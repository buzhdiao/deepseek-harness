/** Required time and allocation budgets for sent-user-text evaluation with the credential matcher. */

import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type {
  UserTextAllocationReport, UserTextTimeReport, UserTextWorkloadAllocation, UserTextWorkloadTiming,
} from './user-text.worker.client.ts'

/** Fresh registries and documents after warm-up; independent minima of adjacent pairs limit scheduler delay. */
// 预热后使用全新注册表与文档的采样次数；相邻对各自独立取最小值以限制调度器延迟。
const ATTEMPTS = 5
/**
 * Both independently selected minima vary with V8 tiering and workload shape.
 * Observed unchanged-worker CI ratios reached 1.65× the reference expectation;
 * use one 1.75× margin for all unmatched workloads, keeping absolute, scaling,
 * and allocation budgets unchanged.
 */
// 未命中（unmatched）工作负载统一使用的 1.75 倍余量（抵消 V8 分层与负载形态波动）。
const UNMATCHED_RATIO_HEADROOM = 1.75
/** A stuck worker is reaped before the outer benchmark deadline. */
// worker 超时上限：卡死的 worker 会在外层基准截止时间之前被回收。
const WORKER_TIMEOUT_MS = 180_000
/** Larger than every workload's allocation, so the allocation interval runs without a scavenge. */
// 大于所有工作负载分配量的半空间大小：分配测量区间内不会触发清理（scavenge）。
const ALLOCATION_SEMI_SPACE_MB = 256
// 编译产出的 user-text worker 脚本路径。
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'user-text', 'user-text.worker.js')

/**
 * Documents without credentials: reference-machine milliseconds with the matcher, and the
 * ratio to the shipped rules without it. Ratios need separate variance headroom. The matcher
 * adds one native literal scan, about 2 ns per character, plus format checks where a literal
 * occurs (`://`, `sk-` in identifiers); 5,000 messages also pay the scheduler's cost for one
 * more matcher. Running sixteen format patterns from every query offset measures 1.6–4.9×.
 */
const UNMATCHED_EXPECTED = {
  'typical-messages': { ms: 28, ratio: 1.25 },
  'prose-256k': { ms: 1.25, ratio: 1.8 },
  'code-256k': { ms: 1.7, ratio: 2.3 },
  'base64-256k': { ms: 1.4, ratio: 2.05 },
  'markdown-256k': { ms: 1.6, ratio: 2.15 },
  'log-256k': { ms: 1.75, ratio: 2.05 },
  'json-256k': { ms: 2.05, ratio: 2.75 },
  'shell-256k': { ms: 3.8, ratio: 1.3 },
} as const
/** Reference-machine milliseconds with the matcher for documents whose credentials it masks. */
// 凭据会被匹配器（credential matcher）掩码的文档：开启匹配器时的参考机毫秒期望。
const MATCHED_EXPECTED_MS = {
  'messages-with-model-key': 28,
  'messages-with-github-token': 28,
  'messages-with-cloud-key-id': 28,
  'messages-with-json-web-token': 29,
  'messages-with-address-password': 31,
  'messages-with-private-key-block': 45,
  'env-keys-2000': 2.1,
} as const
/**
 * 128 KiB shaped against one format's prefix, length, or separator rules. Format patterns
 * that backtrack, or a per-query memo whose digit search reaches the end of the text from
 * every query, measure 60–720 ms and up to 4× per doubling.
 */
// 对抗性（adversarial）输入的参考机毫秒期望：针对某种格式规则的前缀/长度/分隔符构造的 128 KiB 文本。
const ADVERSARIAL_EXPECTED_MS = 3.25
/** Doubling the input doubles a linear scan. */
// 输入翻倍时线性扫描允许的最大倍率：线性 2 倍 × 方差余量。
const MAX_DOUBLING_SCALING = 2 * PERFORMANCE_BUDGET_HEADROOM

/** Measurement floor: heap statistics objects created while reading the young generation. */
// 分配测量下限：读取年轻代（young generation）统计时创建的堆统计对象。
const ALLOCATION_FLOOR_BYTES = 16 * 1024
/**
 * One credential node: the node and data objects, the visible-prefix slice, and the
 * concatenation with a slice of a shared mark string; measured at about 180 bytes.
 */
// 每个凭据节点的分配预算（字节）：节点与数据对象、可见前缀切片与共享标记串切片的拼接。
const ALLOCATION_PER_CREDENTIAL_BYTES = 256
/** A multi-line mask adds one slice of a shared mark string and one concatenation per line; measured at about 60 bytes. */
// 每个被掩码换行的分配预算（字节）：一行增加一次共享标记串切片与一次拼接。
const ALLOCATION_PER_MASKED_LINE_BREAK_BYTES = 64
/** A slice shorter than a sliced string copies its characters: at most two bytes per masked character. */
// 每个被掩码字符的分配预算（字节）：短切片会拷贝字符，每字符至多两字节。
const ALLOCATION_PER_MASKED_CHARACTER_BYTES = 2

// 对抗性输入形态列表：每种针对凭据格式规则的一个弱点（前缀、长度或分隔符）。
const ADVERSARIAL = [
  'digitless-sk', 'jwt-header-runs', 'jwt-two-segments', 'unterminated-key-blocks', 'address-without-at',
  'colon-run', 'long-scheme-user', 'short-token-runs', 'tokens-between-digitless-keys', 'closed-one-line-key-blocks',
] as const

function benchmarkCase(id: string, measures: string): BenchmarkCase {
  // 组装用例元数据：影响场景固定为 Web 界面渲染已发送用户消息。
  return { id: `user-text/${id}`, measures, affects: 'Rendering sent user messages, queued messages, and goal input in the Web GUI.' }
}

async function worker<Report>(args: readonly string[], semiSpaceMb?: number): Promise<Report> {
  // 启动编译 worker：开启 GC，可选半空间大小。
  const run = await runBuiltBenchmarkWorker<Report>({
    worker: WORKER, args, timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true, ...semiSpaceMb === undefined ? {} : { semiSpaceMb },
  })
  // 没有报告即失败：附带退出信息与 stderr 尾部 10 行。
  if (run.report === undefined) {
    throw new Error(`user-text worker failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
      + `timedOut=${String(run.timedOut)}\n${run.stderr.trim().split('\n').slice(-10).join('\n')}`)
  }
  // 返回解析出的报告。
  return run.report
}

/** Compare adjacent scaling samples before aggregating, so unrelated fastest rounds cannot set the ratio. */
function doublingRatio(half: readonly number[], full: readonly number[]): number {
  // 逐对计算相邻样本的倍率并升序排序。
  const ratios = half.map((duration, index) => full[index]! / duration).sort((a, b) => a - b)
  // 取中位数倍率（不受个别异常快轮次影响）。
  return ratios[Math.floor(ratios.length / 2)]!
}

describe('credential-matcher scaling measurement', () => {
  it('compares adjacent rounds when the runner changes speed', () => {
    // 构造半速与全速的模拟样本。
    const half = [1, 2, 2, 2, 2]
    const full = [4, 4, 4, 4, 4]
    // 用最小值之比会高估倍率（超过线性预算），说明该法不可用。
    expect(Math.min(...full) / Math.min(...half)).toBeGreaterThan(MAX_DOUBLING_SCALING)
    // 相邻比值法给出正确的 2 倍。
    expect(doublingRatio(half, full)).toBe(2)
  })

  it('rejects superlinear growth even when one round is faster', () => {
    // 即使某一轮更快，相邻比值法仍应拒绝超线性增长。
    expect(doublingRatio([1, 2, 2, 2, 2], [2, 6, 6, 6, 6])).toBeGreaterThan(MAX_DOUBLING_SCALING)
  })
})

describe('sent user text with the credential matcher', () => {
  // 各工作负载的计时结果索引。
  let timings: ReadonlyMap<string, UserTextWorkloadTiming>
  // 各工作负载的分配结果索引。
  let allocations: ReadonlyMap<string, UserTextWorkloadAllocation>

  beforeAll(async () => {
    // 启动计时 worker（常规堆）。
    const time = await worker<UserTextTimeReport>(['time', String(ATTEMPTS)])
    // 启动分配 worker（大半空间避免触发清理）。
    const allocation = await worker<UserTextAllocationReport>(['allocation'], ALLOCATION_SEMI_SPACE_MB)
    // 输出原始结果 JSON 行。
    console.log(JSON.stringify({ benchmark: 'user-text', ...time, allocation: allocation.workloads }))
    // 按工作负载 id 建立计时索引。
    timings = new Map(time.workloads.map(workload => [workload.id, workload]))
    // 按工作负载 id 建立分配索引。
    allocations = new Map(allocation.workloads.map(workload => [workload.id, workload]))
  }, 2 * WORKER_TIMEOUT_MS)

  // 读取指定工作负载的计时结果。
  const timing = (id: string): UserTextWorkloadTiming => {
    // 查找该工作负载。
    const found = timings.get(id)
    // 缺失说明 worker 未报告该工作负载。
    if (found === undefined) throw new Error(`user-text worker reported no ${id} workload`)
    // 返回计时结果。
    return found
  }
  // 记录一个用例的计时（附带采样方法说明与预算）。
  const record = (benchmark: BenchmarkCase, measured: UserTextWorkloadTiming, budgetMs: number): void => {
    // 调用记录器：补充采样说明，记录带 CPU 时间的耗时与预算。
    recordTimings({
      ...benchmark,
      measures: `${benchmark.measures} Minimum of ${ATTEMPTS} per-sample means of ${measured.evaluationsPerSample} fresh evaluations after warm-up.`,
    }, { withSecretMs: { ms: measured.withSecretMs, cpuMs: measured.withSecretCpuMs } }, { withSecretMs: budgetMs })
  }
  // 校验输入翻倍时耗时按线性增长。
  const expectLinear = (half: UserTextWorkloadTiming, full: UserTextWorkloadTiming): void => {
    // 计算相邻样本的倍率中位数。
    const ratio = doublingRatio(half.samples.map(sample => sample.withSecretMs), full.samples.map(sample => sample.withSecretMs))
    // 输出倍率 JSON 行。
    console.log(JSON.stringify({ benchmark: `user-text/${full.id}/scaling`, ratio, budget: MAX_DOUBLING_SCALING }))
    // 倍率不得超过线性预算。
    expect(ratio).toBeLessThanOrEqual(MAX_DOUBLING_SCALING)
  }

  it.each(Object.entries(UNMATCHED_EXPECTED))('evaluates %s without credentials within its budget and ratio', (id, expected) => {
    // 读取该工作负载的计时结果。
    const measured = timing(id)
    // 由参考期望计算 CI 预算。
    const budgetMs = ciTimeBudget(expected.ms)
    // 记录计时（含采样说明）。
    record(benchmarkCase(id, `Fresh ${id} documents without credentials through every shipped matcher.`), measured, budgetMs)
    // 分组必须是无凭据组。
    expect(measured.group).toBe('unmatched')
    // 不得发现任何凭据。
    expect(measured.secrets).toBe(0)
    // 耗时不得超过预算。
    expect(measured.withSecretMs).toBeLessThanOrEqual(budgetMs)
    // 相对出厂规则（无匹配器）的倍率不得超过期望 × 余量。
    expect(measured.ratio).toBeLessThanOrEqual(expected.ratio * UNMATCHED_RATIO_HEADROOM)
  })

  it.each(Object.entries(MATCHED_EXPECTED_MS))('masks every credential of %s within its budget', (id, expectedMs) => {
    // 读取该工作负载的计时结果。
    const measured = timing(id)
    // 由参考期望计算 CI 预算。
    const budgetMs = ciTimeBudget(expectedMs)
    // 记录计时。
    record(benchmarkCase(id, `Fresh ${id} documents, each credential masked, through every shipped matcher.`), measured, budgetMs)
    // 分组必须是命中（matched）组。
    expect(measured.group).toBe('matched')
    // 凭据数量须符合工作负载定义（env-keys-2000 为 2000，其余为 5000）。
    expect(measured.secrets).toBe(id === 'env-keys-2000' ? 2_000 : 5_000)
    // 掩码耗时不得超过预算。
    expect(measured.withSecretMs).toBeLessThanOrEqual(budgetMs)
  })

  it('masks 2,000 pasted keys in time linear in their number', () => {
    // 读取 1000 键与 2000 键两个规模的计时。
    const half = timing('env-keys-1000')
    const full = timing('env-keys-2000')
    // 两个规模的凭据数量必须分别为 1000 与 2000。
    expect([half.secrets, full.secrets]).toEqual([1_000, 2_000])
    // 增长必须与键数呈线性。
    expectLinear(half, full)
  })

  it.each(ADVERSARIAL)('scans adversarial %s input linearly without backtracking', (name) => {
    // 读取 64 KiB 与 128 KiB 两种规模的对抗样本。
    const half = timing(`adversarial-${name}-64k`)
    const full = timing(`adversarial-${name}-128k`)
    // 对抗输入的 CI 预算。
    const budgetMs = ciTimeBudget(ADVERSARIAL_EXPECTED_MS)
    // 记录 128 KiB 样本的计时。
    record(benchmarkCase(`adversarial-${name}`, `One 128 KiB document repeating a ${name} unit.`), full, budgetMs)
    // 128 KiB 耗时不得超过预算。
    expect(full.withSecretMs).toBeLessThanOrEqual(budgetMs)
    // 增长必须线性：不允许回溯（backtracking）。
    expectLinear(half, full)
  })

  it.each(workloadIds())('allocates only result nodes and masks for %s', (id) => {
    // 读取该工作负载的分配结果。
    const allocation = allocations.get(id)
    // 缺失说明 worker 未报告该分配。
    if (allocation === undefined) throw new Error(`user-text worker reported no ${id} allocation`)
    // 分配用例的凭据数必须与计时一致。
    expect(allocation.secrets).toBe(timing(id).secrets)
    // 预算 = 测量下限 + 每凭据 × 凭据数 + 每换行 × 换行数 + 每字符 × 字符数。
    const budgetBytes = ALLOCATION_FLOOR_BYTES + ALLOCATION_PER_CREDENTIAL_BYTES * allocation.secrets
      + ALLOCATION_PER_MASKED_LINE_BREAK_BYTES * allocation.maskedLineBreaks
      + ALLOCATION_PER_MASKED_CHARACTER_BYTES * allocation.maskedCharacters
    // 规则实际分配量不得超过预算（只允许结果节点与掩码本身）。
    expect(allocation.ruleAllocatedBytes).toBeLessThanOrEqual(budgetBytes)
  })
})

/** Every workload id, in the worker's order, so each has an allocation case. */
function workloadIds(): readonly string[] {
  // 汇总全部工作负载 id：无凭据 + 命中 + 1000 键 + 对抗样本（64KiB/128KiB 各一）。
  return [
    ...Object.keys(UNMATCHED_EXPECTED), ...Object.keys(MATCHED_EXPECTED_MS), 'env-keys-1000',
    ...ADVERSARIAL.flatMap(name => [`adversarial-${name}-64k`, `adversarial-${name}-128k`]),
  ]
}
