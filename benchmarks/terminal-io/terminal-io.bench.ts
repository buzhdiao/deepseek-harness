/** Bounded terminal output must not rescan a full retained window on every chunk. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase, type Timing } from '../support/scaling-report.ts'
import type { TerminalIoReport } from './terminal-io.worker.ts'

// 1 MiB 的字节数。
const MIB = 1024 * 1024
// 每个场景采样的次数（取中位数以限制噪声）。
const ATTEMPTS = 5
// 编译产出的 terminal-io worker 脚本路径。
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'terminal-io', 'terminal-io.worker.js')
/** M5 Pro / Node 26.5 reference expectations, before shared CI scaling and headroom. */
// M5 Pro / Node 26.5 参考机期望（毫秒），尚未乘共享的 CI 缩放与方差余量。
const EXPECTED_MS = { steadyIngest: 20, steadyComplete: 50, fullComplete: 120 }
// 容量扩大 32 倍时允许的最大开销比（近似线性扩展的界限）。
const MAX_CAPACITY_RATIO = 4
/** Terminal output is buffered in memory; no storage access is timed. */
// 终端输出全部缓存在内存中，没有任何存储访问被计时，因此 IO 份额为 0。
const IO_SHARE = 0
// 稳态用例的元数据：1 MiB 输出进入 128 KiB 与 4 MiB 保留窗口。
const STEADY_CASE: BenchmarkCase = {
  id: 'terminal-io/steady',
  measures: 'Terminal ingest and completion of 1 MiB of output into 128 KiB and 4 MiB retained windows.',
  affects: 'Commands that keep printing output in the terminal tool.',
}
// 5 MiB 一次性发送用例的元数据：4 MiB 保留窗口下的完整发送。
const FIVE_MIB_CASE: BenchmarkCase = {
  id: 'terminal-io/five-mib',
  measures: 'Complete terminal send of 5 MiB of output with a 4 MiB retained window.',
  affects: 'Commands that print large logs.',
}
// 保留堆预算上限（16 MiB）。
const MAX_RETAINED_HEAP_BYTES = 16 * MIB

function median(values: readonly number[]): number {
  // 升序排序副本后取中间元素（样本数为奇数时即中位数）。
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
}

async function sample(capacity: number, mode: 'steady' | 'full' | 'tiny' | 'filtered'): Promise<TerminalIoReport> {
  // 启动编译 worker：开启 GC，超时 120 秒。
  const outcome = await runBuiltBenchmarkWorker<TerminalIoReport>({
    worker: WORKER, args: [String(capacity), mode], timeoutMs: 120_000, exposeGc: true,
  })
  // 任何失败形态（超时/信号终止/非零退出/无报告）都直接抛错。
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error('terminal I/O worker failed: ' + JSON.stringify(outcome))
  }
  // 返回解析出的报告。
  return outcome.report
}

it('bounds steady overflow cost as retained terminal capacity grows 32 times', async () => {
  // 小容量（128 KiB）样本列表。
  const small: TerminalIoReport[] = []
  // 大容量（4 MiB）样本列表。
  const large: TerminalIoReport[] = []
  // 两种容量交替采样，共 ATTEMPTS 轮。
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // 采样 128 KiB 容量的稳态摄取。
    small.push(await sample(128 * 1024, 'steady'))
    // 采样 4 MiB 容量的稳态摄取。
    large.push(await sample(4 * MIB, 'steady'))
  }
  // 大/小容量摄取耗时中位数之比：衡量容量扩大 32 倍后的开销增幅。
  const capacityRatio = median(large.map(row => row.ingestMs)) / median(small.map(row => row.ingestMs))
  // 摄取阶段的 CI 时间预算。
  const ingestBudgetMs = ciTimeBudget(EXPECTED_MS.steadyIngest)
  // 完成阶段的 CI 时间预算。
  const completeBudgetMs = ciTimeBudget(EXPECTED_MS.steadyComplete)
  // 输出结果 JSON 行（父报告收集）。
  console.log(JSON.stringify({ scenario: 'terminal-steady', small, large, capacityRatio, ingestBudgetMs, completeBudgetMs }))
  // 以声明的 0 IO 份额构造计时记录。
  const declared = (ms: number): Timing => ({ ms, ioShare: IO_SHARE })
  // 记录小/大容量下的摄取与完成耗时及其预算。
  recordTimings(STEADY_CASE, {
    smallIngestMs: declared(median(small.map(row => row.ingestMs))), largeIngestMs: declared(median(large.map(row => row.ingestMs))),
    smallCompleteMs: declared(median(small.map(row => row.completeMs))), largeCompleteMs: declared(median(large.map(row => row.completeMs))),
  }, { smallIngestMs: ingestBudgetMs, largeIngestMs: ingestBudgetMs, smallCompleteMs: completeBudgetMs, largeCompleteMs: completeBudgetMs })
  // 容量比不得超过上限：摄取代价必须近似与容量无关。
  expect(capacityRatio).toBeLessThanOrEqual(MAX_CAPACITY_RATIO)
  // 对两种容量分别校验耗时与内存预算。
  for (const rows of [small, large]) {
    // 摄取中位数不超过预算。
    expect(median(rows.map(row => row.ingestMs))).toBeLessThanOrEqual(ingestBudgetMs)
    // 完成中位数不超过预算。
    expect(median(rows.map(row => row.completeMs))).toBeLessThanOrEqual(completeBudgetMs)
    // 峰值保留堆不超过 16 MiB。
    expect(Math.max(...rows.map(row => row.retainedHeapBytes))).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
  }
})

it('bounds retained memory when five MiB arrives in sixteen-byte chunks', async () => {
  // 以 4 MiB 容量运行 tiny 模式（16 字节小块）。
  const report = await sample(4 * MIB, 'tiny')
  // 输出报告 JSON 行。
  console.log(JSON.stringify({ scenario: 'terminal-tiny-chunks', report, heapBudgetBytes: MAX_RETAINED_HEAP_BYTES }))
  // 保留堆不得超过 16 MiB 预算。
  expect(report.retainedHeapBytes).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})

it('releases filtered OSC storage behind retained visible string slices', async () => {
  // 以 4 MiB 容量运行 filtered 模式（OSC 转义被过滤）。
  const report = await sample(4 * MIB, 'filtered')
  // 输出报告 JSON 行。
  console.log(JSON.stringify({ scenario: 'terminal-filtered-chunks', report, heapBudgetBytes: MAX_RETAINED_HEAP_BYTES }))
  // 保留堆不得超过 16 MiB 预算：被过滤的 OSC 存储不能滞留。
  expect(report.retainedHeapBytes).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})

it('completes a five MiB terminal send with bounded retained output', async () => {
  // 5 MiB 一次性发送的样本列表。
  const samples: TerminalIoReport[] = []
  // 采样 ATTEMPTS 次。
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) samples.push(await sample(4 * MIB, 'full'))
  // 完成耗时的中位数。
  const completeMedianMs = median(samples.map(row => row.completeMs))
  // 完成阶段的 CI 时间预算。
  const completeBudgetMs = ciTimeBudget(EXPECTED_MS.fullComplete)
  // 输出结果 JSON 行。
  console.log(JSON.stringify({ scenario: 'terminal-five-mib', samples, completeMedianMs, completeBudgetMs }))
  // 记录完成耗时及其预算。
  recordTimings(FIVE_MIB_CASE, { completeMs: { ms: completeMedianMs, ioShare: IO_SHARE } }, { completeMs: completeBudgetMs })
  // 完成中位数不得超过预算。
  expect(completeMedianMs).toBeLessThanOrEqual(completeBudgetMs)
  // 峰值保留堆不超过 16 MiB 预算。
  expect(Math.max(...samples.map(row => row.retainedHeapBytes))).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})
