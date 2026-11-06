/** Required performance budgets for compiled Client history folding and live Assistant updates. */
// 文件头（JSDoc 补充）：编译产物 Client 的历史折叠（fold）与直播 Assistant 更新所需的性能预算。

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import {
  ciTimeBudget,
  PERFORMANCE_BUDGET_HEADROOM,
} from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type { ConversationFoldWorkerReport, PreparingToolWorkerReport, StreamingAssistantWorkerReport } from './conversation-fold.worker.client.ts'

/** Replies in the folded window; each carries one reasoning block and one text block. */
// 中文补充（常量 JSDoc）：折叠窗口内的回复数；每条回复含一个推理块与一个文本块。
const TURNS = 200
/** Text deltas per reply in the large workload; each reply adds one quarter as many reasoning deltas. */
// 中文补充（常量 JSDoc）：大负载下每条回复的文本 delta（增量）数；推理 delta 数为其四分之一。
const LARGE_DELTAS = 2_000
/** Text deltas per reply in the small workload used as the scaling reference. */
// 中文补充（常量 JSDoc）：小负载（作为缩放参照基准）下每条回复的文本 delta 数。
const SMALL_DELTAS = 100
/** Fresh object graphs measured in one compiled worker; the fastest sample removes scheduler delay. */
// 中文补充（常量 JSDoc）：在单个编译 worker 中测量全新对象图；取最快样本以剔除调度器延迟。
const ATTEMPTS = 3
/** Folding and argument preparation run on in-memory Client state without storage access. */
// 中文补充（常量 JSDoc）：折叠与参数准备均在内存 Client 状态上进行，不含存储访问。
const IO_SHARE = 0
// 大窗口用例元信息：测什么、影响什么。
const LARGE_WINDOW_CASE: BenchmarkCase = {
  id: 'conversation-fold/large-window',
  measures: 'Client fold of 200 replies whose 500,000 streamed deltas are compacted into 1,600 records.',
  affects: 'Opening or scrolling a long conversation in the Web GUI.',
}
// 参数准备用例的受影响场景：write 对应大文件写入的流式观看，bash 对应长 shell 命令的流式观看。
const PREPARING_AFFECTS = { write: 'Watching the model stream a large file write.', bash: 'Watching the model stream a long shell command.' } as const
/** A stuck fold worker is reaped before the outer benchmark deadline. */
// 中文补充（常量 JSDoc）：卡死的折叠 worker 必须在外层基准截止时间之前被回收。
const WORKER_TIMEOUT_MS = 60_000

/**
 * The large window contains 500,000 streamed deltas compacted into 1,600
 * stream records. The budget separates the record-proportional fold from the
 * per-delta replay that needs hundreds of milliseconds for the same window.
 */
// 中文补充（JSDoc）：大窗口含 50 万条流式 delta，压缩为 1600 条流记录。预算刻意区分
// "与记录数成比例的折叠"和"逐 delta 重放"——后者对同样窗口需要数百毫秒。
const EXPECTED_LARGE_FOLD_MS = 16
// 大窗口折叠预算 = 期望值 16ms 经 CI 时间预算系数放大。
const LARGE_FOLD_BUDGET_MS = ciTimeBudget(EXPECTED_LARGE_FOLD_MS)

/**
 * Both windows contain equal event and compact-record counts. A fold over
 * records plus joined text measures about 2.5×; replaying every delta measures
 * about 11× as the delta count grows 20×.
 */
// 中文补充（JSDoc）：两个窗口的事件数与压缩记录数相同。delta 数增长 20 倍时，
// "按记录 + 拼接文本"的折叠只涨约 2.5 倍，而逐 delta 重放会涨约 11 倍。
const EXPECTED_DELTA_SCALING = 2.5
// 缩放上限 = 期望缩放比 × 波动余量系数。
const MAX_DELTA_SCALING = EXPECTED_DELTA_SCALING * PERFORMANCE_BUDGET_HEADROOM

// 参数准备用例的重复采样次数。
const PREPARING_SAMPLES = 3
// 两个参数准备负载：write 工具 512KiB 参数、bash 工具 128KiB 参数，各有时间与内存期望。
const PREPARING_CASES = [
  { tool: 'write', characters: 512 * 1024, expectedMs: 300, expectedMb: 30 },
  { tool: 'bash', characters: 128 * 1024, expectedMs: 150, expectedMb: 8 },
] as const

// 直播流式发布负载的文本总字符数。
const STREAMING_CHARACTERS = 256 * 1024
// 流式发布用例的重复采样次数。
const STREAMING_SAMPLES = 5
/** Reference-machine expectations; shared CI scaling applies only to elapsed time. */
// 中文补充（常量 JSDoc）：参考机期望值；共享的 CI 缩放系数只作用于耗时，不作用于内存。
const STREAMING_WORKLOADS = [
  { fragments: 4_096, expectedMs: 12 },
  { fragments: 16_384, expectedMs: 32 },
] as const
// 把每个流式负载展开成两个用例：text 普通内容、reasoning 前导空白内容，共 4 个组合。
const STREAMING_CASES = STREAMING_WORKLOADS.flatMap(workload => [
  { ...workload, blockType: 'text', pattern: 'ordinary' },
  { ...workload, blockType: 'reasoning', pattern: 'leading-whitespace' },
] as const)
/** Incremental heap while the Assembler, live entries, and published Chat state remain reachable. */
// 中文补充（常量 JSDoc）：在 Assembler、直播条目与已发布 Chat 状态均保持可达时的增量堆内存期望（16MB）。
const EXPECTED_STREAMING_RETAINED_MB = 16

// 编译产物 worker 文件的绝对路径。
const WORKER = join(
  import.meta.dirname,
  '..',
  '.dsh-build',
  'conversation-fold',
  'conversation-fold.worker.js',
)

// 从一次 worker 运行中取报告；报告缺失则汇总退出码/信号/超时与最后 10 行 stderr 抛错。
function requireReport<Report>(
  run: BuiltBenchmarkWorkerRun<Report>,
): Report {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  throw new Error(
    `conversation-fold worker failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${stderrLines.slice(-10).join('\n')}`,
  )
}

// 基准一：大窗口 v2 历史的冷折叠，并验证缩放随压缩记录数而非 delta 数。
describe('cold Chat fold of a large v2 history window', () => {
  it(`folds ${String(TURNS)} replies with ${String(LARGE_DELTAS)} deltas each within ${String(LARGE_FOLD_BUDGET_MS)} ms and scales with compact records`, async () => {
    // 启动编译 worker：传入回合数、小/大 delta 数与尝试次数。
    const report = requireReport(await runBuiltBenchmarkWorker<ConversationFoldWorkerReport>({
      worker: WORKER,
      args: [String(TURNS), String(SMALL_DELTAS), String(LARGE_DELTAS), String(ATTEMPTS)],
      timeoutMs: WORKER_TIMEOUT_MS,
    }))
    // 输出 JSON 摘要（含预算与缩放上限）供 ScalingReport 采集。
    console.log(JSON.stringify({
      benchmark: 'conversation-fold/large-window',
      ...report,
      budgetMs: LARGE_FOLD_BUDGET_MS,
      maxScaling: MAX_DELTA_SCALING,
    }))
    // 记录大窗口折叠耗时指标及预算。
    recordTimings(LARGE_WINDOW_CASE, { largeFoldMs: { ms: report.largeFoldMs, ioShare: IO_SHARE } }, { largeFoldMs: LARGE_FOLD_BUDGET_MS })
    // 折叠后必须产生可见的 Chat 节点。
    expect(report.chatNodes).toBeGreaterThan(0)
    // 大窗口折叠耗时不得超过预算。
    expect(report.largeFoldMs).toBeLessThanOrEqual(LARGE_FOLD_BUDGET_MS)
    // 缩放比（大/小窗口耗时比）必须贴合记录数比例，证明没有逐 delta 重放。
    expect(report.scaling).toBeLessThanOrEqual(MAX_DELTA_SCALING)
  })
})

// 基准二：流式工具参数的发布（preparing）——CPU 与堆内存开销均有界。
describe('preparing tool arguments', () => {
  it.each(PREPARING_CASES)('publishes streamed $tool arguments within bounded CPU and heap costs', async (workload) => {
    // 收集各次采样的报告。
    const samples: PreparingToolWorkerReport[] = []
    for (let index = 0; index < PREPARING_SAMPLES; index++) {
      // 启动 worker：以 preparing 模式传入工具名与参数字符数。
      const run = await runBuiltBenchmarkWorker<PreparingToolWorkerReport>({
        worker: WORKER, args: ['preparing', workload.tool, String(workload.characters)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      // worker 不允许超时、被信号杀死或非零退出。
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      // 报告中的字符数必须与负载定义一致。
      expect(report.characters).toBe(workload.characters)
      // write 工具有额外可见断言：进度换算为 KiB 且路径名为 preview.md。
      if (workload.tool === 'write') {
        expect(report.progressKb).toBe(workload.characters / 1024)
        expect(report.filePath).toBe('preview.md')
      }
      // 详情文本：write 为文件名；bash 为 150 字符截断后加省略号的命令预览。
      expect(report.detail).toBe(workload.tool === 'write' ? 'preview.md' : `${'abcdefghijklmno '.repeat(10).slice(0, 159)}…`)
      samples.push(report)
    }
    // 取耗时中位数（排序后下标 1）。
    const medianMs = samples.map(sample => sample.elapsedMs).toSorted((a, b) => a - b)[1]!
    // 取保留内存中位数。
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[1]!
    // 时间预算 = 期望值经 CI 系数放大；内存预算 = 期望值 × 余量系数。
    const budgetMs = ciTimeBudget(workload.expectedMs)
    const budgetMb = workload.expectedMb * PERFORMANCE_BUDGET_HEADROOM
    console.log(JSON.stringify({ benchmark: `conversation-fold/preparing-${workload.tool}`, samples, medianMs, retainedMb, budgetMs, budgetMb }))
    // 记录耗时指标与预算（IO 占比为 0）。
    recordTimings({
      id: `conversation-fold/preparing-${workload.tool}`,
      measures: `Client publishing of ${String(workload.characters / 1024)} KiB of streamed ${workload.tool} tool arguments.`,
      affects: PREPARING_AFFECTS[workload.tool],
    }, { medianMs: { ms: medianMs, ioShare: IO_SHARE } }, { medianMs: budgetMs })
    // 耗时与内存均不得超预算。
    expect(medianMs).toBeLessThanOrEqual(budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})

// 基准三：直播 Assistant 文本发布（streaming）——分块类型与内容模式四种组合。
describe('live Assistant text publication', () => {
  it.each(STREAMING_CASES)('publishes $fragments $blockType deltas with $pattern content within bounded CPU and heap costs', async (workload) => {
    // 收集各次采样的报告。
    const samples: StreamingAssistantWorkerReport[] = []
    for (let index = 0; index < STREAMING_SAMPLES; index++) {
      // 启动 worker：以 streaming 模式传入块类型、内容模式、总字符数与碎片数。
      const run = await runBuiltBenchmarkWorker<StreamingAssistantWorkerReport>({
        worker: WORKER,
        args: ['streaming', workload.blockType, workload.pattern, String(STREAMING_CHARACTERS), String(workload.fragments)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      // worker 不允许超时、被信号杀死或非零退出。
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      // 校验报告与负载一致：字符总数与碎片数。
      expect(report.characters).toBe(STREAMING_CHARACTERS)
      expect(report.fragments).toBe(workload.fragments)
      samples.push(report)
    }
    // 按耗时排序取中位数样本（对象本身，便于读 CPU 字段）。
    const median = samples.toSorted((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(STREAMING_SAMPLES / 2)]!
    // 保留内存同样取中位数。
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[Math.floor(STREAMING_SAMPLES / 2)]!
    // 时间与内存预算。
    const budgetMs = ciTimeBudget(workload.expectedMs)
    const budgetMb = EXPECTED_STREAMING_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM
    // 构造用例元信息：id 中编码块类型、内容模式与碎片数。
    const benchmarkCase: BenchmarkCase = {
      id: `conversation-fold/streaming-${workload.blockType}-${workload.pattern}-${String(workload.fragments)}`,
      measures: `Client append, final Chat publication, and complete text read for ${String(STREAMING_CHARACTERS / 1024)} KiB in ${String(workload.fragments)} ${workload.blockType} deltas with ${workload.pattern} content.`,
      affects: 'Local processing of a long active model response; excludes model pacing, network transport, and browser rendering.',
    }
    // 输出 JSON 摘要。
    console.log(JSON.stringify({ benchmark: benchmarkCase.id, samples, medianMs: median.elapsedMs, retainedMb, budgetMs, budgetMb }))
    // 记录耗时指标（含用户态+内核态 CPU 时间）。
    recordTimings(benchmarkCase, {
      medianMs: { ms: median.elapsedMs, cpuMs: median.cpuUserMs + median.cpuSystemMs },
    }, { medianMs: budgetMs })
    // 另记录峰值内存指标（取所有样本的最大 RSS）。
    recordPeakMemory(benchmarkCase, { peakRssMb: Math.max(...samples.map(sample => sample.maxRssMb)) })
    // 耗时与内存均不得超预算。
    expect(median.elapsedMs).toBeLessThanOrEqual(budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})
