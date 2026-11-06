/** Required baseline budgets for reconnecting during a large active Assistant stream. */
// 文件头（JSDoc 上方补充）：长回复流传输中途重连场景下所要求的基线性能预算（performance budget）。
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type { ReconnectReport } from './reconnect.worker.client.ts'

// 参考基准值：本地（非 CI）环境下整包替换（replace）耗时的参考毫秒数，50ms。
const REFERENCE_REPLACE_MS = 50
// 根据 CI 时间预算系数把参考值放大，得到正式的替换耗时预算（毫秒）。
const REPLACE_BUDGET_MS = ciTimeBudget(REFERENCE_REPLACE_MS)
// 参考基准值：替换后允许保留（retained）的额外堆内存上限，24MB。
const REFERENCE_RETAINED_MB = 24
// 每个基准用例重复采样的次数，取中位数以抑制偶发抖动。
const SAMPLES = 3
/** Replacement folds in-memory Client state; no storage access is timed. */
// 中文补充：替换操作只折叠内存中的 Client 状态；计时范围不含任何存储（storage）访问。
const IO_SHARE = 0
// 用例元信息：id 标识基准，measures 说明测什么，affects 说明受影响的场景。
const CASE: BenchmarkCase = {
  id: 'active-stream-reconnect',
  measures: 'Client rebuild of an unfinished Assistant reply from a 100,000-delta reasoning prefix delivered on reconnect.',
  affects: 'Reloading or reconnecting the Web GUI while a long reply is still streaming.',
}

// 断言工具函数：校验测量值 value 不超过预算 budget，超出则让测试失败。
function expectReplacementWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

// 用例一：对已记录的历史样本做"验收自洽性"检查——预算既能接受慢机器样本，又能拒绝真正的性能回退（regression）。
it('accepts recorded hosted reconnect samples and rejects replacement regressions', () => {
  // 三组历史录制的采样数据（每组三个样本，单位毫秒），分别来自不同规格的托管环境。
  const recordedSamples = [
    [46.574411, 46.067910, 44.193704],
    [55.995471, 55.187582, 55.474573],
    [64.954055, 67.441804, 65.694876],
  ]
  // 对每组样本排序后取中间值（下标 1），得到各组的中位数（median）。
  const recordedMedians = recordedSamples.map(samples => samples.toSorted((a, b) => a - b)[1]!)
  // 最快组的样本绝不可能在 16ms（CI 系数放大前）预算内通过——验证阈值本身不会被"过快"误判通过。
  expect(() => expectReplacementWithinBudget(recordedMedians[0]!, ciTimeBudget(16))).toThrow()
  // 最慢组也不可能在 63ms 的裸预算内通过——验证裸预算确实比最慢样本更紧。
  expect(() => expectReplacementWithinBudget(recordedMedians[2]!, 63)).toThrow()
  // 而三组中位数在放大后的正式预算 REPLACE_BUDGET_MS 内都必须能通过。
  for (const median of recordedMedians) expectReplacementWithinBudget(median, REPLACE_BUDGET_MS)
  // 锁定 ciTimeBudget 的换算结果恰为 125ms，防止预算系数被悄悄改动。
  expect(REPLACE_BUDGET_MS).toBe(125)
  // 再用三个构造值反向验证断言函数：150ms、预算+1ms 都必须被拒绝。
  expect(() => expectReplacementWithinBudget(150, REPLACE_BUDGET_MS)).toThrow()
  expect(() => expectReplacementWithinBudget(REPLACE_BUDGET_MS + 1, REPLACE_BUDGET_MS)).toThrow()
})

// 用例二：真正跑 worker 子进程，重建 100000 条 delta 的直播前缀，校验时间与保留内存预算。
it('reconstructs a 100000-delta live prefix within baseline time and retained-memory budgets', async () => {
  // 收集每一轮采样的报告（ReconnectReport 由 worker 端导出）。
  const samples: ReconnectReport[] = []
  // 重复运行 SAMPLES 次 worker，得到稳定的采样分布。
  for (let sample = 0; sample < SAMPLES; sample++) {
    // 启动由构建产物（.dsh-build）编译出的 worker 子进程，并暴露 gc 以便测内存。
    const run = await runBuiltBenchmarkWorker<ReconnectReport>({
      worker: join(import.meta.dirname, '../.dsh-build/active-stream-reconnect/reconnect.worker.js'),
      exposeGc: true, timeoutMs: 30000,
    })
    // worker 不允许超时，否则直接判失败并打印其标准错误以便排查。
    expect(run.timedOut, run.stderr).toBe(false)
    // worker 不应被信号（signal）杀死。
    expect(run.signal, run.stderr).toBeNull()
    // worker 必须以退出码 0 正常结束。
    expect(run.exitCode, run.stderr).toBe(0)
    // 报告缺失说明 worker 没输出结果，属于异常，显式抛错。
    if (run.report === undefined) throw new Error('reconnect worker omitted report')
    // 接受新帧后的下一帧必须标记为 transient（暂态），说明替换后的流仍处于活跃接续状态。
    expect(run.report.nextFrame).toBe('transient')
    // 可见条目数必须大于 0，证明替换确实重建出了内容。
    expect(run.report.entries).toBeGreaterThan(0)
    // 保存本轮报告。
    samples.push(run.report)
  }
  // 三轮样本按耗时排序取中位数，作为最终替换耗时指标。
  const replaceMs = samples.map(sample => sample.replaceMs).toSorted((a, b) => a - b)[1]!
  // 同样取保留内存（retained，重连后未释放的堆内存）的中位数。
  const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[1]!
  // 时间预算直接取上面算好的替换预算。
  const budgetMs = REPLACE_BUDGET_MS
  // 内存预算 = 参考值 × 全局预留系数（headroom，给 CI 抖动留余量）。
  const budgetMb = REFERENCE_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM
  // 输出一行 JSON 摘要，便于 ScalingReport 采集与后续校准（calibration）。
  console.log(JSON.stringify({ benchmark: 'active-stream-reconnect', samples, median: { replaceMs, retainedMb }, referenceMs: REFERENCE_REPLACE_MS, referenceMb: REFERENCE_RETAINED_MB, budgetMs, budgetMb }))
  // 把耗时指标（含 IO 占比 0）与预算记录进缩放报告。
  recordTimings(CASE, { replaceMs: { ms: replaceMs, ioShare: IO_SHARE } }, { replaceMs: budgetMs })
  // 时间预算是硬性约束：超出即失败。
  expectReplacementWithinBudget(replaceMs, budgetMs)
  // 内存预算用 soft 断言，超限时报告失败但不中断后续清理。
  expect.soft(retainedMb).toBeLessThanOrEqual(budgetMb)
})
