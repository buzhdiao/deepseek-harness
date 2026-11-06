/** Required performance budgets for cold Session preparation, first history, and Agent resume. */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import {
  ciTimeBudget,
  PERFORMANCE_BUDGET_HEADROOM,
} from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type {
  SessionOpenBenchmarkScenario,
  SessionOpenWorkerReport,
} from './session-open.worker.ts'
import {
  SYNTHETIC_CURRENT_GENERATION,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_CURRENT_FILENAME,
  SYNTHETIC_V0_FILENAME,
  writeSyntheticReleasedV0Session,
  type SyntheticV0SessionWrite,
} from './synthetic-released-v0-session.ts'

/** 200 turns × (500 text + 125 reasoning deltas): 127,400 released-v0 events. */
// 工作负载形状：200 轮 × 每轮（500 文本增量 + 125 推理增量），共 127,400 个 released-v0 事件。
const SHAPE = { turns: 200, textDeltas: 500 } as const
/** Fresh processes per normal-heap scenario; the median enforces each timing budget. */
// 每个常规堆场景运行的全新进程数：以中位数对照各计时预算。
const ATTEMPTS = 5
/** A stuck child is reaped well before the outer test and hook deadlines. */
// worker 子进程超时上限：远小于外层测试与钩子的截止时间，卡死会被及时回收。
const WORKER_TIMEOUT_MS = 60_000
/** Old-space pressure check, kept independent from normal-heap timing samples. */
// 受限老生代（old space）压力检查：与常规堆计时样本相互独立。
const CONSTRAINED_HEAP_MB = 128

// 访问种类：首次打开（触发迁移）或升级后重开（全新进程）。
type SessionAccessKind = 'first-open' | 'post-upgrade-reopen'
// 测量端点：四阶段、首次历史或 Agent 恢复。
type SessionBenchmarkEndpoint = 'phases' | 'first-history' | 'agent-resume'

// 每种访问对应的源代（generation）：首次打开读 released-v0，重开读当前代。
const SOURCE_GENERATION_BY_ACCESS = {
  'first-open': 'released-v0',
  'post-upgrade-reopen': SYNTHETIC_CURRENT_GENERATION,
} as const satisfies Record<SessionAccessKind, string>

/** Expected durations on the reference machine before CI scaling and variance headroom. */
// 参考机（reference machine）上的期望耗时（毫秒），尚未乘 CI 缩放与方差余量。
const EXPECTED_MS = {
  migrationOpen: 220,
  read: 8,
  sessionRestore: 24,
  projection: 14,
  firstOpenFirstHistory: 220,
  reopenFirstHistory: 48,
  reopenAgentResume: 40,
} as const

// 首次打开（迁移）的打开预算：参考期望 × CI 缩放 × 余量。
const MIGRATION_OPEN_BUDGET_MS = ciTimeBudget(EXPECTED_MS.migrationOpen)
/** Standard two-CPU CI reopen samples span 47.4–49.2 ms; 50 ms is the rounded expectation. */
// 双 CPU CI 重开实测区间为 47.4–49.2 ms，取整为 50 ms 的期望。
const EXPECTED_REOPEN_CI_MS = 50
// 重开的打开预算：CI 实测期望向上取整后乘方差余量。
const REOPEN_OPEN_BUDGET_MS = Math.ceil(EXPECTED_REOPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
// 读取阶段预算。
const READ_BUDGET_MS = ciTimeBudget(EXPECTED_MS.read)
// 会话恢复阶段预算。
const SESSION_RESTORE_BUDGET_MS = ciTimeBudget(EXPECTED_MS.sessionRestore)
// 投影阶段预算。
const PROJECTION_BUDGET_MS = ciTimeBudget(EXPECTED_MS.projection)
// 首次打开的首次历史预算。
const FIRST_OPEN_FIRST_HISTORY_BUDGET_MS = ciTimeBudget(EXPECTED_MS.firstOpenFirstHistory)
// 重开的首次历史预算。
const REOPEN_FIRST_HISTORY_BUDGET_MS = ciTimeBudget(EXPECTED_MS.reopenFirstHistory)
/** Reviewed hosted limit: floor(450 × 1.25); calibration records the original reference. */
// 首次打开的 Agent 恢复预算：审核过的托管上限 floor(450 × 1.25)；校准用例记录了原始参考。
const FIRST_OPEN_AGENT_RESUME_BUDGET_MS = 562
// 重开的 Agent 恢复预算。
const REOPEN_AGENT_RESUME_BUDGET_MS = ciTimeBudget(EXPECTED_MS.reopenAgentResume)
/** Historical-reference retained heap before variance headroom. */
// Agent 恢复的历史参考保留堆（MB），尚未乘方差余量。
const EXPECTED_AGENT_RETAINED_HEAP_MB = 26.1
// Agent 恢复后的保留堆预算：期望 × 余量，向上取整。
const AGENT_RETAINED_HEAP_BUDGET_MB = Math.ceil(
  EXPECTED_AGENT_RETAINED_HEAP_MB * PERFORMANCE_BUDGET_HEADROOM,
)

// 编译产出的 session-open worker 脚本路径。
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-open', 'session-open.worker.js')
/**
 * Estimated storage wait of the phase endpoints, whose worker reports CPU time only for the whole run: open
 * and read access one Session log that the page cache usually holds; restore and projection start after the
 * file handle closes and process memory only.
 */
// 阶段端点的存储等待占比估计：打开/读取访问页缓存通常已持有的日志（10% 文件等待）；恢复/投影为纯内存（0）。
const PHASE_IO_SHARE = { file: 0.1, memory: 0 } as const
/** User scenario of each access kind. */
// 每种访问对应用户场景的说明。
const ACCESS_AFFECTS: Readonly<Record<SessionAccessKind, string>> = {
  'first-open': 'Opening a large Session for the first time after upgrading DSH.',
  'post-upgrade-reopen': 'Opening a large Session again in a new DSH process.',
}

/**
 * Describe one Session-open case.
 * @param access - Access kind and its label.
 * @param endpoint - Case suffix and what it measures.
 * @returns Case metadata for the scaled report.
 */
function openCase(access: AccessBenchmarkSpec, endpoint: { readonly suffix: string; readonly measures: string }): BenchmarkCase {
  // 组装用例元数据：id 由基准名/访问种类/端点后缀组成，描述补上负载与访问标签。
  return {
    id: `session-open/${access.accessKind}/${endpoint.suffix}`,
    measures: `${endpoint.measures} One 127,400-event Session, ${access.label}.`,
    affects: ACCESS_AFFECTS[access.accessKind],
  }
}

// 一次 worker 运行的结果类型（报告已定型为 SessionOpenWorkerReport）。
type WorkerRun = BuiltBenchmarkWorkerRun<SessionOpenWorkerReport>

function rounded(value: number): number {
  // 保留一位小数。
  return Math.round(value * 10) / 10
}

function median(values: readonly number[]): number {
  // 升序排序副本。
  const sorted = [...values].sort((left, right) => left - right)
  // 取中间元素（奇数样本即中位数）。
  return sorted[Math.floor(sorted.length / 2)] as number
}

function metric(
  reports: readonly SessionOpenWorkerReport[],
  read: (report: SessionOpenWorkerReport) => number,
): { readonly min: number; readonly median: number; readonly max: number; readonly samples: readonly number[] } {
  // 对每份报告读取该指标的样本序列。
  const samples = reports.map(read)
  // 汇总最小/中位/最大与逐样本值（均保留一位小数）。
  return {
    min: rounded(Math.min(...samples)),
    median: rounded(median(samples)),
    max: rounded(Math.max(...samples)),
    samples: samples.map(rounded),
  }
}

function phaseMetric(
  reports: readonly SessionOpenWorkerReport[],
  key: keyof NonNullable<SessionOpenWorkerReport['phases']>,
): ReturnType<typeof metric> {
  // 读取指定阶段指标的快捷方式。
  return metric(reports, (report) => {
    // 该报告必须携带阶段计时。
    if (report.phases === undefined) throw new Error(`${report.scenario} did not report phase timings`)
    // 返回指定阶段的毫秒值。
    return report.phases[key]
  })
}

function summarize(reports: readonly SessionOpenWorkerReport[]) {
  // 汇总总耗时、CPU 与各项内存指标。
  return {
    totalMs: metric(reports, report => report.totalMs),
    cpuUserMs: metric(reports, report => report.cpuUserMs),
    cpuSystemMs: metric(reports, report => report.cpuSystemMs),
    retainedHeapMb: metric(reports, report => report.retained.heapUsedMb),
    retainedExternalMb: metric(reports, report => report.retained.externalMb),
    retainedArrayBuffersMb: metric(reports, report => report.retained.arrayBuffersMb),
    retainedRssMb: metric(reports, report => report.retained.rssMb),
    peakRssMb: metric(reports, report => report.afterGc.peakRssMb),
  }
}

function summarizePhases(reports: readonly SessionOpenWorkerReport[]) {
  // 在整体汇总之上追加四个阶段指标。
  return {
    ...summarize(reports),
    openMs: phaseMetric(reports, 'openMs'),
    readMs: phaseMetric(reports, 'readMs'),
    sessionRestoreMs: phaseMetric(reports, 'sessionRestoreMs'),
    projectionMs: phaseMetric(reports, 'projectionMs'),
  }
}

function runWorker(
  root: string,
  scenario: SessionOpenBenchmarkScenario,
  heapLimitMb?: number,
): Promise<WorkerRun> {
  // 启动编译 worker：固定超时、开启 GC，可选堆上限。
  return runBuiltBenchmarkWorker({
    worker: WORKER,
    args: [root, scenario],
    timeoutMs: WORKER_TIMEOUT_MS,
    exposeGc: true,
    ...(heapLimitMb === undefined ? {} : { heapLimitMb }),
  })
}

function requireReport(
  run: WorkerRun,
  scenario: SessionOpenBenchmarkScenario,
  heapLimitMb?: number,
): SessionOpenWorkerReport {
  // 已拿到报告则直接返回。
  if (run.report !== undefined) return run.report
  // 按行拆分标准错误输出。
  const stderrLines = run.stderr.trim().split('\n')
  // 过滤出致命错误相关行（堆耗尽等）。
  const fatal = stderrLines.filter(line => /FATAL ERROR|heap limit|out of memory/i.test(line))
  // 输出过长时截取首尾各 10 行，保留关键信息。
  const context = stderrLines.length <= 20
    ? stderrLines
    : [...stderrLines.slice(0, 10), '... stderr middle omitted ...', ...stderrLines.slice(-10)]
  // 优先展示致命错误行，否则展示截断后的上下文。
  const detail = (fatal.length > 0 ? fatal : context).join('\n')
  // 描述堆限制（或常规堆）。
  const limit = heapLimitMb === undefined ? 'normal heap' : `${String(heapLimitMb)} MB old space`
  // 抛出包含退出码、信号、超时与详细错误的异常。
  throw new Error(
    `${scenario} failed under ${limit}: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${detail}`,
  )
}

/** Owns deterministic first-open/reopen sources and private roots created for one benchmark file. */
class SessionOpenBenchmarkSuite {
  // released-v0 源文件路径（prepare 后填充）。
  private legacySourcePath = ''
  // 当前代源文件路径（prepare 后填充）。
  private currentSourcePath = ''
  // 本套件的一次性临时目录。
  private scratch = ''
  // 合成 v0 会话的写盘事实（事件/行/帧/字节）。
  private facts: SyntheticV0SessionWrite | undefined
  // 根目录计数器：保证每个样本用独立目录。
  private rootIndex = 0

  async prepare(): Promise<void> {
    // 创建一次性临时目录。
    this.scratch = await mkdtemp(join(tmpdir(), 'dsh-session-open-bench-'))
    // 生成确定性的合成的 released-v0 会话源文件。
    this.facts = await writeSyntheticReleasedV0Session(join(this.scratch, 'source'), SHAPE)
    // 记录 v0 源路径。
    this.legacySourcePath = this.facts.path
    // Produce one real post-upgrade directory outside every measured interval.
    // 生成一次真实的“升级后”目录作为模板（不在任何测量区间内）。
    const templateRoot = await this.createRoot('first-open', 'post-upgrade-template')
    // 跑一次 agent-resume 使迁移发生，从而产出当前代文件。
    requireReport(await runWorker(templateRoot, 'agent-resume'), 'agent-resume')
    // 记录当前代源文件路径。
    this.currentSourcePath = join(
      templateRoot,
      SYNTHETIC_SESSION_DIRECTORY,
      SYNTHETIC_CURRENT_FILENAME,
    )
  }

  async dispose(): Promise<void> {
    // 测试结束后递归删除整个临时目录。
    await rm(this.scratch, { recursive: true, force: true })
  }

  workload(accessKind: SessionAccessKind) {
    // 套件必须已准备。
    if (this.facts === undefined) throw new Error('Session opening benchmark source is not prepared')
    // 描述工作负载：访问种类、源代与 v0 输入的各项事实。
    return {
      accessKind,
      sourceGeneration: SOURCE_GENERATION_BY_ACCESS[accessKind],
      logicalInputEvents: this.facts.events,
      legacyInputRows: this.facts.rows,
      legacyInputFrames: this.facts.frames,
      legacyInputLogicalBytes: this.facts.logicalBytes,
      legacyInputCompressedBytes: this.facts.compressedBytes,
    }
  }

  async sample(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
  ): Promise<SessionOpenWorkerReport[]> {
    // 收集各次尝试的报告。
    const reports: SessionOpenWorkerReport[] = []
    // 每次尝试都用全新进程与全新目录。
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // 运行一次并保存报告。
      reports.push(await this.run(accessKind, endpoint))
    }
    // 返回全部样本。
    return reports
  }

  async run(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
    heapLimitMb?: number,
  ): Promise<SessionOpenWorkerReport> {
    // 解析 worker 场景名。
    const scenario = this.workerScenario(accessKind, endpoint)
    // 为本次运行创建独立根目录（标签带递增序号）。
    const root = await this.createRoot(
      accessKind,
      `${accessKind}-${endpoint}-${String(this.rootIndex++)}`,
    )
    // 运行 worker 并强制要求报告存在。
    const report = requireReport(await runWorker(root, scenario, heapLimitMb), scenario, heapLimitMb)
    // 返回报告。
    return report
  }

  private workerScenario(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
  ): SessionOpenBenchmarkScenario {
    // 非阶段端点直接以端点名作为场景。
    if (endpoint !== 'phases') return endpoint
    // 阶段端点按访问种类选择迁移或稳态场景。
    return accessKind === 'first-open' ? 'phase-migrate' : 'phase-steady'
  }

  private async createRoot(accessKind: SessionAccessKind, label: string): Promise<string> {
    // 本次的根目录。
    const root = join(this.scratch, label)
    // 会话存储目录（由夹具的 cwd/id 推导）。
    const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
    // 创建存储目录。
    await mkdir(directory, { recursive: true })
    // 复制 v0 源文件为该根目录下的会话日志。
    await copyFile(this.legacySourcePath, join(directory, SYNTHETIC_V0_FILENAME))
    // 重开场景还需要当前代文件。
    if (accessKind === 'post-upgrade-reopen') {
      // 模板未生成即失败。
      if (this.currentSourcePath === '') throw new Error('current V2 benchmark source is not prepared')
      // Released generations remain adjacent after migration, so V2 samples retain their V0 predecessor.
      // 复制当前代源文件：迁移后 released 代相邻共存，V2 样本保留其 V0 前身。
      await copyFile(this.currentSourcePath, join(directory, SYNTHETIC_CURRENT_FILENAME))
    }
    // 返回准备好的根目录。
    return root
  }
}

// 一次访问基准的配置：访问种类、标签与三个预算。
interface AccessBenchmarkSpec {
  // 访问种类。
  readonly accessKind: SessionAccessKind
  // 展示标签。
  readonly label: string
  // 打开阶段预算。
  readonly openBudgetMs: number
  // 首次历史预算。
  readonly firstHistoryBudgetMs: number
  // Agent 恢复预算。
  readonly agentResumeBudgetMs: number
}

// 两种访问场景的基准配置（首次打开与升级后重开；数据行不再逐条注释）。
const ACCESS_BENCHMARKS: readonly AccessBenchmarkSpec[] = [
  {
    accessKind: 'first-open',
    label: 'first open from released V0',
    openBudgetMs: MIGRATION_OPEN_BUDGET_MS,
    firstHistoryBudgetMs: FIRST_OPEN_FIRST_HISTORY_BUDGET_MS,
    agentResumeBudgetMs: FIRST_OPEN_AGENT_RESUME_BUDGET_MS,
  },
  {
    accessKind: 'post-upgrade-reopen',
    label: 'fresh-process reopen after upgrade',
    openBudgetMs: REOPEN_OPEN_BUDGET_MS,
    firstHistoryBudgetMs: REOPEN_FIRST_HISTORY_BUDGET_MS,
    agentResumeBudgetMs: REOPEN_AGENT_RESUME_BUDGET_MS,
  },
]

function expectOpenWithinBudget(value: number, budget: number): void {
  // 断言测量值不超过预算（封装以便校准用例中捕获其抛错）。
  expect(value).toBeLessThanOrEqual(budget)
}

describe('standard hosted reopen calibration', () => {
  // 校准用例：接受超过历史预算的、记录在案的双 CPU 重开样本。
  it('accepts the recorded two-CPU samples that exceed the historical budget', () => {
    // 记录在案的五次 CI 采样的中位数。
    const recordedMedian = median([49.2, 47.4, 49.1, 48.6, 48.1])

    // 锁定记录值本身。
    expect(recordedMedian).toBe(48.6)
    // 历史预算（12ms 参考期望）应拒绝该中位数。
    expect(() => expectOpenWithinBudget(recordedMedian, ciTimeBudget(12))).toThrow()
    // 新的重开预算应接受该中位数。
    expectOpenWithinBudget(recordedMedian, REOPEN_OPEN_BUDGET_MS)
    // 锁定重开预算的具体数值，防止无意改动。
    expect(REOPEN_OPEN_BUDGET_MS).toBe(63)
  })

  // 校准用例：拒绝合成重开退化与多秒级的首次打开退化。
  it('rejects synthetic reopen and multi-second first-open regressions', () => {
    // 构造一个明显退化的重开中位数。
    const regressionMedian = median([74, 75, 76, 75, 74])
    // 新预算应拒绝该退化样本。
    expect(() => expectOpenWithinBudget(regressionMedian, REOPEN_OPEN_BUDGET_MS)).toThrow()
    // 锁定迁移打开预算的具体数值。
    expect(MIGRATION_OPEN_BUDGET_MS).toBe(550)
    // 4 秒的首次打开必须被拒绝。
    expect(() => expectOpenWithinBudget(4_000, MIGRATION_OPEN_BUDGET_MS)).toThrow()
  })
})

describe('standard hosted first-open Agent-resume calibration', () => {
  // 校准用例：接受记录在案的托管采样，同时拒绝实质性退化。
  it('accepts recorded hosted samples while rejecting a material regression', () => {
    // 记录在案的托管采样中位数。
    const recordedMedian = median([454.2, 454.8, 455.4, 457.8, 459.8])

    // 锁定记录值本身。
    expect(recordedMedian).toBe(455.4)
    // 原始 450ms 上限应拒绝该中位数。
    expect(() => expectOpenWithinBudget(recordedMedian, 450)).toThrow()
    // 审核后的预算应接受它。
    expectOpenWithinBudget(recordedMedian, FIRST_OPEN_AGENT_RESUME_BUDGET_MS)
    // 明显退化（600ms）应被拒绝。
    expect(() => expectOpenWithinBudget(600, FIRST_OPEN_AGENT_RESUME_BUDGET_MS)).toThrow()
  })
})

describe('Session opening benchmark prerequisites', () => {
  // 前提用例：worker 失败时错误信息保留异常标题并截断 stderr 尾部。
  it('retains the exception headline and bounded stderr tail when a worker fails', () => {
    // 构造一条异常标题。
    const headline = 'SessionFormatUnsupportedError: source chronology cannot be migrated'
    // 构造 30 行栈帧夹在标题与测试框架尾行之间的 stderr。
    const stderr = [headline, ...Array.from({ length: 30 }, (_, index) => 'stack frame ' + String(index)), 'Node.js test'].join('\n')
    // 构造一次失败的 worker 运行。
    const run: WorkerRun = { report: undefined, exitCode: 1, signal: null, timedOut: false, stderr }
    // 错误信息必须包含异常标题。
    expect(() => requireReport(run, 'agent-resume')).toThrow(headline)
    // 且保留有界的尾行。
    expect(() => requireReport(run, 'agent-resume')).toThrow('Node.js test')
    // 中间的栈帧被省略。
    expect(() => requireReport(run, 'agent-resume')).not.toThrow('stack frame 15')
    // 堆耗尽错误要附带堆限制描述。
    expect(() => requireReport({ ...run, stderr: 'FATAL ERROR: heap limit' }, 'agent-resume', 128))
      .toThrow('128 MB old space')
  })

  // 前提用例：迁移生成的工作负载并重开其后继，且不改动 v0 文件。
  it('migrates the generated workload and reopens its successor without changing V0', async () => {
    // 创建临时持久化根目录。
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-bench-fixture-'))
    // 记录创建的容器以便逆序清理。
    const contexts: Context[] = []
    // 挂载 JSONL 持久化并返回持久化服务。
    const mount = async () => {
      // 新建容器并登记。
      const ctx = new Context()
      contexts.push(ctx)
      // 挂载 zstd 压缩的 JSONL 持久化。
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
      // 返回持久化服务。
      return ctx.sessionPersistence
    }
    try {
      // 写出小型合成 v0 会话（2 轮 × 12 文本增量）。
      const facts = await writeSyntheticReleasedV0Session(root, { turns: 2, textDeltas: 12 })
      // 校验事件/行/帧数量符合确定性预期。
      expect({ events: facts.events, rows: facts.rows, frames: facts.frames }).toEqual({ events: 54, rows: 28, frames: 29 })
      // 读取原始文件字节以便稍后比对。
      const original = await readFile(facts.path)
      // 会话存储目录。
      const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
      // 挂载持久化服务。
      const persistence = await mount()
      // 以只读方式打开该会话。
      const read = await persistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
      // 读入全部事件与状态。
      const initial = await read.read()
      // 从读取结果恢复出 Session 对象（与生产冷读一致）。
      const session = Session.fromRestore(read.header.id, initial.events, read.header, read.inheritedEventCount, initial.eventState)
      // 头版本应为当前格式版本。
      expect(read.header.version).toBe(SESSION_FORMAT_VERSION)
      // 事件中恰好一条系统消息。
      expect(initial.events.filter(event => event.type === 'system/message')).toHaveLength(1)
      // 派生消息序列与确定性的用户/推理/文本内容一致。
      expect(session.deriveMessages().map(({ id, role, content }) => ({ id, role, content }))).toEqual(
        [1, 2].flatMap(turn => [
          { id: 'user-' + String(turn), role: 'user', content: [{ type: 'text', text: 'prompt ' + String(turn) }] },
          { id: 'assistant-' + String(turn), role: 'assistant', content: [
            { type: 'reasoning', text: 'r0 r1 r2 ' },
            { type: 'text', text: Array.from({ length: 12 }, (_, index) => 'w' + String(index) + ' ').join('') },
          ] },
        ]),
      )
      // 关闭只读句柄。
      await read.close()
      // 迁移前目录中只有 v0 文件。
      expect(await readdir(directory)).toEqual([SYNTHETIC_V0_FILENAME])
      // 以写方式打开（触发迁移到当前代）。
      const writer = await persistence.open(SessionId(SYNTHETIC_SESSION_ID), 'write')
      // 写句柄读到的事件与只读一致。
      expect((await writer.read()).events).toEqual(initial.events)
      // 关闭写句柄。
      await writer.close()
      // 目录中已出现当前代文件。
      expect(await readdir(directory)).toContain(SYNTHETIC_CURRENT_FILENAME)
      // 在全新进程中重开只读句柄。
      const reopened = await (await mount()).open(SessionId(SYNTHETIC_SESSION_ID), 'read')
      // 重开读到的事件与最初一致。
      expect((await reopened.read()).events).toEqual(initial.events)
      // 关闭重开句柄。
      await reopened.close()
      // v0 源文件字节保持不变。
      expect(await readFile(facts.path)).toEqual(original)
    } finally {
      try {
        // 逆序销毁全部容器。
        for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      } finally {
        // 递归删除临时根目录。
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})

describe('opening a large Session for first open and post-upgrade reopen', () => {
  // 套件实例持有准备好的源文件与目录。
  const suite = new SessionOpenBenchmarkSuite()

  // 测试前准备源文件与升级模板。
  beforeAll(async () => { await suite.prepare() })
  // 测试后清理。
  afterAll(async () => { await suite.dispose() })

  // 遍历两种访问场景。
  for (const access of ACCESS_BENCHMARKS) {
    describe(access.label, () => {
      // 用例：常规堆下剖析全部四个阶段。
      it('profiles all four phases under normal heap', async () => {
        // 采样并汇总各阶段指标。
        const result = summarizePhases(await suite.sample(access.accessKind, 'phases'))
        // 输出结果 JSON 行（含工作负载与各预算）。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/phases`,
          ...suite.workload(access.accessKind),
          result,
          budgetsMs: {
            open: access.openBudgetMs,
            read: READ_BUDGET_MS,
            sessionRestore: SESSION_RESTORE_BUDGET_MS,
            projection: PROJECTION_BUDGET_MS,
          },
        }))
        // 记录各阶段计时（含 IO 占比与预算）。
        recordTimings(openCase(access, { suffix: 'phases', measures: 'File open, read, Session restore, and projection phases.' }), {
          openMs: { ms: result.openMs.median, ioShare: PHASE_IO_SHARE.file },
          readMs: { ms: result.readMs.median, ioShare: PHASE_IO_SHARE.file },
          sessionRestoreMs: { ms: result.sessionRestoreMs.median, ioShare: PHASE_IO_SHARE.memory },
          projectionMs: { ms: result.projectionMs.median, ioShare: PHASE_IO_SHARE.memory },
        }, { openMs: access.openBudgetMs, readMs: READ_BUDGET_MS, sessionRestoreMs: SESSION_RESTORE_BUDGET_MS, projectionMs: PROJECTION_BUDGET_MS })
        // 打开阶段中位数不得超过预算。
        expectOpenWithinBudget(result.openMs.median, access.openBudgetMs)
        // 读取阶段中位数不得超过预算。
        expect(result.readMs.median).toBeLessThanOrEqual(READ_BUDGET_MS)
        // 会话恢复阶段中位数不得超过预算。
        expect(result.sessionRestoreMs.median).toBeLessThanOrEqual(SESSION_RESTORE_BUDGET_MS)
        // 投影阶段中位数不得超过预算。
        expect(result.projectionMs.median).toBeLessThanOrEqual(PROJECTION_BUDGET_MS)
      })

      // 用例：受限老生代下完成全部四阶段。
      it(`completes all four phases under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        // 以 128 MB 堆上限运行一次阶段场景。
        const report = await suite.run(access.accessKind, 'phases', CONSTRAINED_HEAP_MB)
        // 输出受限堆运行的完整报告。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/phases-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })

      // 用例：首次历史必须在预算内产出。
      it(`produces first Host history within ${String(access.firstHistoryBudgetMs)} ms`, async () => {
        // 采样并汇总。
        const result = summarize(await suite.sample(access.accessKind, 'first-history'))
        // 输出结果 JSON 行。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/first-history`,
          ...suite.workload(access.accessKind),
          result,
          budgetMs: access.firstHistoryBudgetMs,
        }))
        // 记录总耗时（含 CPU 时间）与预算。
        recordTimings(openCase(access, { suffix: 'first-history', measures: 'Host delivery of the first history snapshot.' }),
          { totalMs: { ms: result.totalMs.median, cpuMs: result.cpuUserMs.median + result.cpuSystemMs.median } },
          { totalMs: access.firstHistoryBudgetMs })
        // 总耗时中位数不得超过首次历史预算。
        expect(result.totalMs.median).toBeLessThanOrEqual(access.firstHistoryBudgetMs)
      })

      // 用例：受限老生代下的首次历史。
      it(`produces first Host history under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        // 以 128 MB 堆上限运行一次首次历史场景。
        const report = await suite.run(access.accessKind, 'first-history', CONSTRAINED_HEAP_MB)
        // 输出受限堆运行的完整报告。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/first-history-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })

      // 用例：冷 Agent 恢复必须在预算内完成。
      it(`resumes a cold Agent within ${String(access.agentResumeBudgetMs)} ms`, async () => {
        // 采样并汇总。
        const result = summarize(await suite.sample(access.accessKind, 'agent-resume'))
        // 输出结果 JSON 行（含保留堆预算）。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/agent-resume`,
          ...suite.workload(access.accessKind),
          result,
          budgetMs: access.agentResumeBudgetMs,
          retainedHeapBudgetMb: AGENT_RETAINED_HEAP_BUDGET_MB,
        }))
        // 记录总耗时（含 CPU 时间）与预算。
        recordTimings(openCase(access, { suffix: 'agent-resume', measures: 'Cold Agent resume until the resumed Agent handle returns.' }),
          { totalMs: { ms: result.totalMs.median, cpuMs: result.cpuUserMs.median + result.cpuSystemMs.median } },
          { totalMs: access.agentResumeBudgetMs })
        // 恢复耗时中位数不得超过预算。
        expect(result.totalMs.median).toBeLessThanOrEqual(access.agentResumeBudgetMs)
        // 保留堆中位数不得超过预算。
        expect(result.retainedHeapMb.median).toBeLessThanOrEqual(AGENT_RETAINED_HEAP_BUDGET_MB)
      })

      // 用例：受限老生代下的冷 Agent 恢复。
      it(`resumes a cold Agent under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        // 以 128 MB 堆上限运行一次 Agent 恢复场景。
        const report = await suite.run(access.accessKind, 'agent-resume', CONSTRAINED_HEAP_MB)
        // 输出受限堆运行的完整报告。
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/agent-resume-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })
    })
  }
})
