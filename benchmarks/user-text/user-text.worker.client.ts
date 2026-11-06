/** Compiled worker for sent-user-text evaluation cost and allocation with and without the credential matcher. */
// 本文件是“已发送消息 UserText”评估的编译型基准 worker：
// 分别测量带凭据匹配器（credential matcher）与不带时的求值耗时与内存分配。

import { PerformanceObserver, performance } from 'node:perf_hooks'
// 导入性能观测器与高精度时钟：performance 用于计时，PerformanceObserver 用于捕获 GC 事件。
import { getHeapSpaceStatistics } from 'node:v8'
// 导入 V8 的堆空间统计，用于读取新生代（young generation）的字节用量。
import { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context，作为 UserTextRegistry 的生命周期作用域。
import type { UserTextFacts, UserTextRule, UserTextTransformContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
// 导入 UserText 相关类型：消息事实（Facts）、规则（Rule）与转换上下文（TransformContext）。
// These Client-only UserText modules have no plain-Node package export and are compiled into this worker.
// 这些仅限客户端的 UserText 模块没有纯 Node 的包导出，因此直接从源码路径编译进本 worker。
import { UserTextRegistry } from '../../packages/client/ui-conversation/src/client/conversation/user-text-registry.ts'
// 导入 UserText 规则注册表：登记规则并创建求值器（evaluator）。
import { sessionReferenceRule } from '../../packages/client/ui-conversation/src/client/user-text/session-reference-rule.ts'
// 导入会话引用规则（@会话）。
import { collapseWhitespaceRule, trimWhitespaceRule } from '../../packages/client/ui-conversation/src/client/user-text/whitespace-rules.ts'
// 导入空白折叠与空白裁剪两条空白处理规则。
import { fileReferenceRule, folderReferenceRule } from '../../packages/client/ui-reference/src/client/user-text-rules.ts'
// 导入文件与文件夹引用规则（@路径）。
import { skillReferenceRule } from '../../packages/client/ui-skill/src/client/user-text-rules.ts'
// 导入技能引用规则（/命令）。
import { goalCommandReferenceRule } from '../../packages/client/ui-goal/src/client/user-text-rules.ts'
// 导入目标（goal）命令引用规则。
import { createSecretRule } from '../../packages/client/ui-secret-mask/src/client/secret-rule.ts'
// 导入凭据匹配器（secret rule）的工厂函数，它是本基准的被测对象。
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
// 导入基准运行时断言，确保 worker 以构建产物方式运行且依赖解析正确。

/** What a workload contains: no credential, real credentials, or input shaped against one format. */
// 工作负载（workload）的分组：不含凭据、含真实凭据、针对某种凭据格式构造的对抗输入。
export type UserTextWorkloadGroup = 'unmatched' | 'matched' | 'adversarial'

/** Adjacent baseline and credential measurements; even-indexed pairs measure the baseline first. */
// 相邻“基线/带凭据”的一对测量结果；偶数序号的样本对先测基线。
export interface UserTextTimingPair {
  readonly baseMs: number
  // 基线样本的墙钟耗时（毫秒）。
  readonly baseCpuMs: number
  // 基线样本的进程 CPU 耗时（毫秒）。
  readonly withSecretMs: number
  // 带凭据匹配器样本的墙钟耗时（毫秒）。
  readonly withSecretCpuMs: number
  // 带凭据匹配器样本的进程 CPU 耗时（毫秒）。
}

/** Timing of one workload evaluated by the shipped rule set with and without the credential matcher. */
// 单个工作负载的计时结果：用随包规则集分别在不带/带凭据匹配器下评估。
export interface UserTextWorkloadTiming {
  readonly id: string
  // 工作负载唯一标识。
  readonly group: UserTextWorkloadGroup
  // 所属分组。
  readonly documents: number
  // 文档（文本段）数量。
  readonly characters: number
  // 全部文档的字符总数。
  /** Fresh evaluations averaged into each timed sample; counts and characters describe one evaluation. */
  readonly evaluationsPerSample: number
  readonly secrets: number
  // 单次评估命中的凭据节点数。
  /** Characters inside credential ranges, whose masks the matcher builds. */
  readonly maskedCharacters: number
  readonly baseMs: number
  // 基线最快样本的墙钟耗时（毫秒）。
  /** Mean process CPU time per evaluation in the fastest baseline sample. */
  readonly baseCpuMs: number
  readonly withSecretMs: number
  // 带凭据最快样本的墙钟耗时（毫秒）。
  /** Mean process CPU time per evaluation in the fastest with-credential sample. */
  readonly withSecretCpuMs: number
  readonly ratio: number
  // 比值：带凭据耗时 / 基线耗时。
  /** All measured pairs in execution order, excluding warm-up. */
  readonly samples: readonly UserTextTimingPair[]
}

/** Heap allocation of the credential matcher over one workload, with the size of what it returns. */
// 凭据匹配器在单个工作负载上的堆分配，以及其返回结果的规模。
export interface UserTextWorkloadAllocation {
  readonly id: string
  // 工作负载唯一标识。
  /** Young-generation bytes the matcher allocates answering every query of every document, nodes included; no GC ran meanwhile. */
  readonly ruleAllocatedBytes: number
  readonly secrets: number
  // 返回的凭据节点数量。
  /** Characters inside credential ranges. */
  readonly maskedCharacters: number
  /** Line breaks inside credential ranges, each of which ends one piece of a multi-line mask. */
  readonly maskedLineBreaks: number
}

/** Result of `time <attempts>`: warmed code, fresh instances, and independent minima from adjacent sample pairs. */
// `time <attempts>` 模式的结果：预热过的代码、全新实例、以及相邻样本对的独立最小值。
export interface UserTextTimeReport {
  readonly warmupPairs: number
  // 预热轮数（不计入样本）。
  readonly attempts: number
  // 正式测量的轮数。
  readonly workloads: readonly UserTextWorkloadTiming[]
  // 各工作负载的计时条目。
}

/** Result of `allocation`, which needs `--expose-gc` and a young generation larger than one evaluation. */
// `allocation` 模式的结果：需要 --expose-gc，且新生代必须大于单次评估的分配量。
export interface UserTextAllocationReport {
  readonly workloads: readonly UserTextWorkloadAllocation[]
  // 各工作负载的分配条目。
}

/** Matchers the Web composition registers besides the credential matcher. */
// Web 组合中除凭据匹配器之外登记的全部规则，构成基准的基线集合。
const BASE_RULES: readonly UserTextRule[] = [
  sessionReferenceRule, fileReferenceRule, folderReferenceRule, skillReferenceRule,
  goalCommandReferenceRule, collapseWhitespaceRule, trimWhitespaceRule,
]
/** Facts a sent message bubble supplies. */
// 已发送消息气泡提供的事实（Facts）：一个会话标签与两个技能名。
const FACTS: Readonly<Partial<UserTextFacts>> = { sessionLabels: ['会话一'], skillNames: ['plan', 'review'] }

const KIB = 1024
// KiB 常量：1024 字节。
/** Exercise each workload's code paths before measuring sub-millisecond baseline evaluations. */
// 预热轮数：在测量亚毫秒级基线评估前，先跑热各工作负载的代码路径。
const WARMUP_PAIRS = 10
/** Base batch size; half-sized scaling inputs use twice as many evaluations. */
// 基础批量：每个样本的评估次数；规模减半的缩放输入用两倍次数补足总查询量。
const SINGLE_DOCUMENT_EVALUATIONS = 20
// 中英混排的散文样本。
const PROSE = '帮我看看这个函数为什么慢，顺便把 README 也更新一下。The quick brown fox jumps over the lazy dog, 1234 times. '
// 含模板字符串 URL 与错误处理的代码行样本。
const CODE = 'const value = await fetch(`https://api.example.com/v1/items?id=${id}`); if (!value.ok) throw new Error("bad: " + value.status);\n'
// Base64 字符流样本。
const BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLw'
// Markdown 文档样本：标题、列表、表格与代码块。
const MARKDOWN = [
  '## 安装与配置', '', '- 运行 `pnpm install`，然后执行 `pnpm run build`。',
  '- 详见 [文档](https://example.com/docs/setup?ref=readme#install)。', '',
  '| 选项 | 默认值 | 说明 |', '|---|---|---|', '| `timeout` | 30s | 请求超时 |', '| `retries` | 3 | 失败重试次数 |', '',
  '```ts', "const client = createClient({ baseUrl: 'https://api.example.com/v1', timeout: 30_000 })", '```', '', '',
].join('\n')
// 结构化日志行样本：含时间戳、URL、trace id 与邮箱。
const LOG = '2026-10-11T12:00:00.123Z INFO  [worker-3] GET https://api.example.com/v1/items?id=1234&page=2 200 12ms '
  + 'trace=4bf92f3577b34da6a3ce929d0e0e4736 user=alice@example.com\n'
// NDJSON 行样本：含 UUID、CDN URL、标签与时间戳。
const JSON_LINES = '{"id":"123e4567-e89b-12d3-a456-426614174000","url":"https://cdn.example.com/assets/img_0001.png",'
  + '"name":"task-runner","tags":["sk-button","api_key_name"],"created_at":"2026-10-11T12:00:00Z","size":10240},\n'
// Shell 命令行样本：pnpm 过滤测试与 git push。
const SHELL = 'pnpm --filter @deepseek-ai/dsh-client-ui-secret-mask run test -- --coverage --reporter=verbose'
  + ' && git push origin feat/user-text-secret-mask\n'
/** Ordinary message fragments: prose, references, a slash skill, a URL without credentials, and code. */
// 普通消息片段：散文、文件引用、斜杠技能、无凭据 URL、行内代码等。
const MESSAGE_PARTS = [
  PROSE, '参照 @src/app/main.ts 修复一下', ' /plan 先列计划', ' 见 https://example.com/docs/a?b=c#d ',
  '`const total = items.reduce((a, b) => a + b, 0)`', ' 然后跑 pnpm run test -- --watch=false。',
] as const

// fill：把 unit 重复拼接并截断到指定字符数，用于按大小放大样本。
const fill = (unit: string, characters: number): string => unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters)
const MIXED = 'a1B2c3D4e5F6g7H8i9J0'
// 大小写与数字混合的字符样本，用于填补凭据主体。
// Samples are assembled at run time so the repository holds no literal in a credential format.
// 凭据样本在运行时按索引拼装，仓库中不保留任何符合凭据格式的字面量。
const key = (index: number): string => ['sk', '-', `${index.toString(16).padStart(8, '0')}0123456789abcdef01234567`].join('')
// 六类真实形态的凭据样本：sk- 密钥、GitHub 令牌、云密钥 ID、JWT、连接串密码、RSA 私钥块。
const CREDENTIALS = {
  // sk- 前缀的 API 密钥。
  'model-key': key(7),
  // GitHub 个人访问令牌（ghp_ 前缀 + 36 字符）。
  'github-token': ['gh', 'p_', fill(MIXED, 36)].join(''),
  // AWS 风格访问密钥 ID（AKIA 前缀）。
  'cloud-key-id': ['AK', 'IA', 'ABCDEFGHIJ234567'].join(''),
  // JWT：三段 Base64URL 以点号分隔。
  'json-web-token': ['ey', 'J', fill(MIXED, 17), '.', 'ey', 'J', fill(MIXED, 30), '.', fill(MIXED, 43)].join(''),
  // 连接串内嵌密码（postgres://user:pass@host:port/db）。
  'address-password': ['postgres://admin:', 'p4ss-W0rd', '@db.internal:5432/app'].join(''),
  // RSA 私钥 PEM 块：头尾行加 10 行 64 字符 Base64。
  'private-key-block': [
    ['-----BEGIN', ' RSA PRIVATE KEY-----'].join(''), ...Array.from({ length: 10 }, () => fill(BASE64, 64)),
    ['-----END', ' RSA PRIVATE KEY-----'].join(''),
  ].join('\n'),
} as const

// 生成 count 条普通消息：每条取 4 个片段按索引错位拼接，截断到 200 字符。
function messages(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    // 片段选择带步长 2 的偏移，使相邻消息内容彼此不同。
    const parts = Array.from({ length: 4 }, (_unused, part) => MESSAGE_PARTS[(index + part * 2) % MESSAGE_PARTS.length]!)
    // 序号作前缀后拼接片段，并截断到 200 字符以模拟真实气泡长度。
    return `${String(index)} ${parts.join('')}`.slice(0, 200)
  })
}

/** Ordinary 200-character messages, each carrying one credential whole. */
// 生成 count 条 200 字符的普通消息，每条完整包含一个指定凭据。
function credentialMessages(count: number, credential: string): string[] {
  return Array.from({ length: count }, (_, index) => {
    // 头部：序号加引导语。
    const head = `${String(index)} 帮我看看这个配置能不能用：`
    // 尾部：一段普通文本，稍后按剩余空间截断。
    const tail = `，${MESSAGE_PARTS[index % MESSAGE_PARTS.length]!}${PROSE}`
    // 组装为“头 + 凭据 + 尾”，总长不超过 200 字符。
    return head + credential + tail.slice(0, Math.max(0, 200 - head.length - credential.length))
  })
}

// 生成 count 行“环境变量风格 API 密钥”的文本，模拟 .env 文件。
const envFile = (count: number): string =>
  Array.from({ length: count }, (_, index) => `SERVICE_${String(index)}_API_KEY=${key(index)}`).join('\n')

/** Inputs shaped against each credential format's prefix, length, and separator rules. */
// 针对每种凭据格式的前缀、长度与分隔符规则构造的对抗输入单元。
const ADVERSARIAL_UNITS = {
  // 缺数字的 sk- 前缀：数字搜索必须一路回退。
  'digitless-sk': 'sk-',
  // 形似 JWT 头部但非 Base64 的前缀。
  'jwt-header-runs': 'eyJabcdefgh-',
  // 只有 JWT 前两段、第三段缺失。
  'jwt-two-segments': 'eyJabcdefgh.eyJabcdefgh-',
  // 未闭合的私钥块头。
  'unterminated-key-blocks': ['-----BEGIN', ' RSA PRIVATE KEY-----\nabc\n'].join(''),
  // 无 @ 结尾的地址型凭据前缀。
  'address-without-at': 'a://u:',
  // 纯冒号串。
  'colon-run': ':',
  // 超长 scheme 加超长用户名且无密码结尾。
  'long-scheme-user': `abcdefghijklmnop://${'u'.repeat(250)}:`,
  // 差一个字符即达合法长度的 ghp_ 令牌。
  'short-token-runs': `ghp_${fill('a1B2c3', 35)} `,
  // Closed one-line blocks, each its own credential: mask searches confined to each block keep them linear.
  // 单行闭合的私钥块：每块自成凭据，掩码搜索被限制在块内以保持线性复杂度。
  'closed-one-line-key-blocks': ['-----BEGIN', ' PRIVATE KEY-----abcd', '-----END', ' PRIVATE KEY----- '].join(''),
  // Each query starts after an accepted digit-free token and meets a digit-free `sk-` whose digit search reaches the end.
  // 每次查询都从已接受的免数字令牌之后开始，并遇到免数字的 `sk-`，其数字搜索会一路探到末尾。
  'tokens-between-digitless-keys': ['-', 'sk', '-', 'gh', 'p_', fill('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 36)].join(''),
} as const

interface Workload {
  readonly id: string
  // 工作负载唯一标识。
  readonly group: UserTextWorkloadGroup
  // 所属分组。
  readonly texts: readonly string[]
  // 参与评估的全部文本。
  /** Scaling pairs process the same total keys or characters per sample, including their GC cost. */
  readonly evaluationsPerSample: number
}

/** Scaling sizes share adjacent rounds; standalone workloads occupy one group. */
// 构造全部工作负载分组：同组内为缩放档位（在相邻轮次交错测量）；独立负载各占一组。
function workloadGroups(): readonly (readonly Workload[])[] {
  return [
    // 5000 条不含凭据的普通消息，每个样本评估 1 次。
    [{ id: 'typical-messages', group: 'unmatched', texts: messages(5_000), evaluationsPerSample: 1 }],
    // 七种单元文本各放大到 256 KiB，测单文档大输入的吞吐；用 20 次评估取平均。
    ...Object.entries({ prose: PROSE, code: CODE, base64: BASE64, markdown: MARKDOWN, log: LOG, json: JSON_LINES, shell: SHELL })
      .map(([name, unit]): readonly Workload[] => [{
        id: `${name}-256k`, group: 'unmatched', texts: [fill(unit, 256 * KIB)], evaluationsPerSample: SINGLE_DOCUMENT_EVALUATIONS,
      }]),
    // 每种凭据各生成 5000 条完整包含它的消息，测真实命中场景。
    ...Object.entries(CREDENTIALS).map(([name, credential]): readonly Workload[] => [{
      id: `messages-with-${name}`, group: 'matched', texts: credentialMessages(5_000, credential), evaluationsPerSample: 1,
    }]),
    // 两档 env 密钥文件：评估次数互补（2×20 与 20），使每个样本的总查询量相同。
    [
      { id: 'env-keys-1000', group: 'matched', texts: [envFile(1_000)], evaluationsPerSample: 2 * SINGLE_DOCUMENT_EVALUATIONS },
      { id: 'env-keys-2000', group: 'matched', texts: [envFile(2_000)], evaluationsPerSample: SINGLE_DOCUMENT_EVALUATIONS },
    ],
    // 每种对抗输入构造 64 KiB 与 128 KiB 两档：大档评估次数减半，保持样本总查询量一致。
    ...Object.entries(ADVERSARIAL_UNITS).map(([name, unit]): readonly Workload[] => [
      {
        id: `adversarial-${name}-64k`, group: 'adversarial', texts: [fill(unit, 64 * KIB)],
        evaluationsPerSample: 2 * SINGLE_DOCUMENT_EVALUATIONS,
      },
      {
        id: `adversarial-${name}-128k`, group: 'adversarial', texts: [fill(unit, 128 * KIB)],
        evaluationsPerSample: SINGLE_DOCUMENT_EVALUATIONS,
      },
    ]),
  ]
}

interface Sample {
  readonly ms: number
  // 墙钟耗时（毫秒）。
  readonly cpuMs: number
  // 进程 CPU 耗时（毫秒）。
  readonly secrets: number
  // 凭据节点数量。
  readonly maskedCharacters: number
  // 凭据范围覆盖的字符数。
}

interface SamplePair {
  readonly base: Sample
  // 基线样本（不含凭据匹配器）。
  readonly secret: Sample
  // 实验样本（含凭据匹配器）。
}

/** Rules for one sample; a fresh credential matcher per sample carries no state from an earlier sample. */
// 每个样本使用的规则集合工厂：每次调用新建凭据匹配器，避免样本间残留状态。
type RuleSet = () => readonly UserTextRule[]
// 基线规则集：仅普通规则。
const withoutSecret: RuleSet = () => BASE_RULES
// 实验规则集：普通规则加新建的凭据匹配器。
const withSecret: RuleSet = () => [...BASE_RULES, createSecretRule()]

/**
 * Evaluate fresh documents; await registry disposal outside the measured interval before returning.
 * @returns elapsed and CPU milliseconds, credential nodes produced, and their characters.
 */
// 用全新实例评估全部文档；返回前在测量区间之外完成注册表的释放。
// 返回：墙钟与 CPU 毫秒数、产生的凭据节点数及其覆盖字符数。
async function evaluateAll(rules: RuleSet, texts: readonly string[]): Promise<Sample> {
  // 新建独立的 Cordis 作用域，承载本次评估的注册表生命周期。
  const scope = new Context()
  try {
    // 创建注册表并逐条登记规则。
    const registry = new UserTextRegistry(scope)
    for (const rule of rules()) registry.register(rule)
    // 统计凭据节点数与覆盖字符数。
    let secrets = 0
    let maskedCharacters = 0
    // 记录进程 CPU 起始值与高精度墙钟起始时间。
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    // 逐文档求值：遍历求值器产出的全部节点。
    for (const text of texts) {
      for (const node of registry.createEvaluator()({ text, facts: FACTS })) {
        // 只统计凭据节点，其余节点直接跳过。
        if (node.id !== 'secret') continue
        secrets++
        // 累加该凭据范围的字符宽度（end - start）。
        maskedCharacters += node.end - node.start
      }
    }
    // 停表：墙钟耗时与 CPU 耗时（user + system，换算为毫秒）。
    const ms = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    // 返回单次评估的计时与统计结果。
    return { ms, cpuMs: (cpu.user + cpu.system) / 1_000, secrets, maskedCharacters }
  } finally {
    // 无论成败都在测量区间外释放作用域（销毁注册表等资源）。
    await scope.fiber.dispose()
  }
}

// 运行 evaluations 次全量评估并取平均耗时；secrets/maskedCharacters 取首次值（每次相同）。
async function sample(rules: RuleSet, texts: readonly string[], evaluations: number): Promise<Sample> {
  const first = await evaluateAll(rules, texts)
  let ms = first.ms
  let cpuMs = first.cpuMs
  // 累加其余各次的耗时。
  for (let index = 1; index < evaluations; index++) {
    const next = await evaluateAll(rules, texts)
    ms += next.ms
    cpuMs += next.cpuMs
  }
  // 返回平均耗时，统计量沿用首次结果。
  return { ...first, ms: ms / evaluations, cpuMs: cpuMs / evaluations }
}

// 相邻成对测量一次基线与一次带凭据样本；按 index 奇偶交替先后顺序以抵消漂移。
async function evaluatePair(texts: readonly string[], index: number, evaluations: number): Promise<SamplePair> {
  // 偶数轮先测基线再测实验。
  if (index % 2 === 0) {
    const base = await sample(withoutSecret, texts, evaluations)
    return { base, secret: await sample(withSecret, texts, evaluations) }
  }
  // 奇数轮先测实验再测基线。
  const secret = await sample(withSecret, texts, evaluations)
  return { base: await sample(withoutSecret, texts, evaluations), secret }
}

/** Alternate scaling sizes within every warm-up and measured round to limit drift between them. */
// 在每个预热轮与正式轮中都交错测量各工作负载（奇偶轮反向遍历），限制组间漂移；
// 返回每个负载的全部样本对及其基线/实验各自的最快样本。
async function measure(workloads: readonly Workload[], attempts: number): Promise<readonly (SamplePair & {
  readonly workload: Workload
  readonly samples: readonly UserTextTimingPair[]
})[]> {
  // 为每个工作负载建立空的样本对列表。
  const measured = workloads.map(workload => ({ workload, pairs: new Array<SamplePair>() }))
  // 总轮数 = 预热对数 + 正式尝试数。
  for (let round = 0; round < WARMUP_PAIRS + attempts; round++) {
    for (let position = 0; position < measured.length; position++) {
      // 偶数轮正向遍历、奇数轮反向遍历，实现规模档位的交错。
      const index = round % 2 === 0 ? position : measured.length - 1 - position
      const { workload, pairs } = measured[index]!
      // 当前轮次为该负载评估一对样本（先后顺序由 round 奇偶决定）。
      const pair = await evaluatePair(workload.texts, round, workload.evaluationsPerSample)
      // 预热轮的样本不入库。
      if (round >= WARMUP_PAIRS) pairs.push(pair)
    }
  }
  // 汇总：取各负载样本对中基线与实验各自的最小耗时。
  return measured.map(({ workload, pairs }) => {
    const best = pairs.reduce((min, pair) => ({
      base: pair.base.ms < min.base.ms ? pair.base : min.base,
      secret: pair.secret.ms < min.secret.ms ? pair.secret : min.secret,
    }))
    return {
      workload,
      ...best,
      // 全部正式样本对按执行顺序展开为耗时记录。
      samples: pairs.map(pair => ({
        baseMs: pair.base.ms, baseCpuMs: pair.base.cpuMs,
        withSecretMs: pair.secret.ms, withSecretCpuMs: pair.secret.cpuMs,
      })),
    }
  })
}

declare const gc: (() => void) | undefined
// 声明全局 gc 函数（--expose-gc 时才存在），供分配模式手动触发垃圾回收。

/**
 * Young-generation bytes in use. Code and feedback that compilation allocates during a
 * measurement live in other spaces, so they do not count as allocation by the evaluation.
 */
// 当前新生代已用字节数。编译期间分配的代码与反馈位于其他空间，不计入求值分配。
function youngBytes(): number {
  // 累加新生代相关空间的已用字节。
  let total = 0
  for (const space of getHeapSpaceStatistics()) {
    // 只统计新生代（new_space）与新生代大对象空间。
    if (space.space_name === 'new_space' || space.space_name === 'new_large_object_space') total += space.space_used_size
  }
  return total
}

/** The credential matcher reads no Facts. */
// 凭据匹配器不读取 Facts，这里提供恒返回 undefined 的转换上下文。
const NO_FACTS: UserTextTransformContext = { read: () => undefined }

/**
 * Query the credential matcher over every document as the scheduler does when no other
 * matcher produces a node; an index loop, so the loop itself allocates nothing.
 */
// 像调度器那样（无其他匹配器产出节点时）对每个文档连续查询凭据匹配器；
// 使用索引循环，使循环本身不产生任何分配。
function queryAll(rule: UserTextRule, texts: readonly string[]): void {
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!
    // 从上一匹配结束处继续查询，直到没有新节点。
    for (let from = 0; ;) {
      const node = rule.match(text, from, NO_FACTS)
      if (node === undefined) break
      // 前进到当前节点结束位置，继续下一次查询。
      from = node.end
    }
  }
}

/** Credential nodes the matcher returns over every document, counted outside any measured interval. */
// 在任何测量区间之外统计匹配器对全部文档返回的凭据节点：
// 数量、覆盖字符数以及范围内换行符数（每个换行结束多行掩码的一段）。
function returned(texts: readonly string[]): Omit<UserTextWorkloadAllocation, 'id' | 'ruleAllocatedBytes'> {
  // 新建被测的凭据匹配器。
  const rule = createSecretRule()
  let secrets = 0
  let maskedCharacters = 0
  let maskedLineBreaks = 0
  for (const text of texts) {
    // 逐节点查询：从上一节点结束处继续，直到无匹配。
    for (let node = rule.match(text, 0, NO_FACTS); node !== undefined; node = rule.match(text, node.end, NO_FACTS)) {
      secrets++
      maskedCharacters += node.end - node.start
      // 逐字符检查凭据范围内的换行（\n 或 \r）。
      for (let index = node.start; index < node.end; index++) {
        const code = text.charCodeAt(index)
        if (code === 10 || code === 13) maskedLineBreaks++
      }
    }
  }
  // 返回不含 id 与分配字节数的统计字段。
  return { secrets, maskedCharacters, maskedLineBreaks }
}

/**
 * Bytes one warmed pass of every query allocates, measured across an interval without GC.
 * @returns young-generation growth over the interval.
 */
// 测量预热后一整遍查询分配的字节数；要求测量区间内不发生 GC。
// 返回：区间内新生代的增长字节数。
async function allocatedBytes(texts: readonly string[], collect: () => void): Promise<number> {
  // 记录 GC 事件的开始时间戳。
  const collections: number[] = []
  // 通过 PerformanceObserver 订阅 'gc' 事件类型。
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) collections.push(entry.startTime) })
  observer.observe({ entryTypes: ['gc'] })
  try {
    // 新建凭据匹配器并预热 10 遍全量查询，让 JIT 与内联缓存进入稳定状态。
    const rule = createSecretRule()
    for (let warm = 0; warm < 10; warm++) queryAll(rule, texts)
    // 连续两次完整 GC，清空新生代，从干净基线开始测量。
    collect()
    collect()
    const start = performance.now()
    // 记录测量起点的新生代用量。
    const used = youngBytes()
    // 执行一整遍全部查询；期望期间不触发 GC。
    queryAll(rule, texts)
    // 分配字节数 = 测量后新生代用量减去测量前用量。
    const grown = youngBytes() - used
    const end = performance.now()
    // GC entries arrive on a later turn.
    // GC 事件要到事件循环的下一轮才送达，因此先等待 20 毫秒再校验。
    await new Promise(resolve => { setTimeout(resolve, 20) })
    // 统计落在测量区间内的 GC 次数：一旦发生即说明新生代太小、测量被污染。
    const inside = collections.filter(time => time >= start && time <= end).length
    if (inside > 0) throw new Error(`${String(inside)} garbage collections ran inside the allocation interval; enlarge the young generation`)
    // 返回该遍查询的新生代增长字节数。
    return grown
  } finally {
    // 断开 GC 事件订阅。
    observer.disconnect()
  }
}

// 把命令行参数解析为正整数，非法时抛出错误。
function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  // 必须是安全整数且大于 0。
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

// 分配模式入口：要求 --expose-gc，逐工作负载测量凭据匹配器的分配字节与返回节点统计。
async function allocations(): Promise<UserTextAllocationReport> {
  if (gc === undefined) throw new Error('user-text allocation mode needs --expose-gc')
  // 取得手动 GC 函数。
  const collect = gc
  const results: UserTextWorkloadAllocation[] = []
  // 展平全部分组，逐个工作负载测量。
  for (const { id, texts } of workloadGroups().flat()) {
    // 合并分配字节数与节点统计。
    results.push({ id, ruleAllocatedBytes: await allocatedBytes(texts, collect), ...returned(texts) })
  }
  return { workloads: results }
}

// 计时模式入口：按分组测量所有工作负载并汇总为最终报告。
async function timings(attempts: number): Promise<UserTextTimeReport> {
  const results: UserTextWorkloadTiming[] = []
  for (const workloads of workloadGroups()) {
    // 解构每个负载的测量结果：负载元数据、双方最快样本与全部样本对。
    for (const { workload: { id, group, texts, evaluationsPerSample }, base, secret, samples } of await measure(workloads, attempts)) {
      // 组装单个工作负载的计时条目。
      results.push({
        id,
        group,
        documents: texts.length,
        characters: texts.reduce((sum, text) => sum + text.length, 0),
        evaluationsPerSample,
        secrets: secret.secrets,
        maskedCharacters: secret.maskedCharacters,
        baseMs: base.ms,
        baseCpuMs: base.cpuMs,
        withSecretMs: secret.ms,
        withSecretCpuMs: secret.cpuMs,
        ratio: secret.ms / base.ms,
        samples,
      })
    }
  }
  // 报告记录预热对数与正式尝试数。
  return { warmupPairs: WARMUP_PAIRS, attempts, workloads: results }
}

// 断言本 worker 以构建产物运行，且关键依赖解析到同一实例。
assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/cordis': import.meta.resolve('@deepseek-ai/cordis'),
  '@deepseek-ai/dsh-client-store': import.meta.resolve('@deepseek-ai/dsh-client-store'),
})
// 解析命令行参数：模式（time / allocation）与尝试次数。
const [mode, count] = process.argv.slice(2)
if (mode !== 'time' && mode !== 'allocation') throw new Error('usage: user-text.worker.js time <attempts> | allocation')
// 按模式执行基准，并把 JSON 结果打印到标准输出（顶层 await，输出后即退出）。
console.log(JSON.stringify(mode === 'time' ? await timings(positiveInteger(count, 'attempts')) : await allocations()))
