/** Session-list Host queue responsiveness; no browser input, transport, or paint is measured. */
// 文件头（JSDoc 补充）：测量 Host 会话列表（Session-list）的队列响应能力；不测量浏览器输入、网络传输或绘制。

import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings } from '../support/scaling-report.ts'
import type { ProjectionListReport } from './projection-list.worker.ts'

// 编译产物 worker 的绝对路径。
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'projection-list.worker.js')
// 每个负载（workload）的重复尝试次数。
const ATTEMPTS = 3
// 单次 worker 运行的超时上限（120 秒，cheap 负载要生成 3000 个会话）。
const WORKER_TIMEOUT_MS = 120_000
/** Coarse reference-machine throughput allowances, before CI scaling and variance headroom. */
// 中文补充（常量 JSDoc）：参考机的粗粒度吞吐允许值（尚未做 CI 缩放与波动余量处理）。
const LIST_REFERENCE_MS = { modest: 50, tail: 500, cheap: 150 } as const
/** Queue-delay reference allowance above the measured 16 ms work slices and one-row overshoot. */
// 中文补充（常量 JSDoc）：队列延迟参考允许值：在实测的 16ms 工作切片与单行溢出之上再放宽到 30ms。
const CALLBACK_REFERENCE_MS = 30
/** Reference retained-heap allowance; memory receives variance headroom but no CPU scaling. */
// 中文补充（常量 JSDoc）：参考保留堆允许值；内存只做波动余量放大，不做 CPU 缩放。
const RETAINED_HEAP_REFERENCE_BYTES = 240 * 1024 * 1024
/** Queue delay is time other callbacks wait behind list work on the Host thread, which is CPU work. */
// 中文补充（常量 JSDoc）：队列延迟是其他回调在 Host 线程上等待列表工作的时间——纯属 CPU 工作。
const CALLBACK_IO_SHARE = 0
/** Sessions per workload. */
// 中文补充（常量 JSDoc）：各负载的会话数量。
const SESSIONS = { modest: 50, tail: 300, cheap: 3_000 } as const

// 计算中位数。
function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

// 启动一次 worker 运行：在独立的临时目录中按指定负载执行并返回报告。
async function run(workload: ProjectionListReport['workload']): Promise<ProjectionListReport> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projection-list-bench-'))
  try {
    const outcome = await runBuiltBenchmarkWorker<ProjectionListReport>({
      worker: WORKER, args: [root, workload], timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
    })
    // 超时、信号、非零退出或缺少报告都视为失败，并附上最后 20 行 stderr。
    if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
      throw new Error(`projection-list ${workload} failed: exit=${String(outcome.exitCode)}, signal=${String(outcome.signal)}, `
        + `timedOut=${String(outcome.timedOut)}\n${outcome.stderr.trim().split('\n').slice(-20).join('\n')}`)
    }
    return outcome.report
  } finally {
    // The shared launcher resolves only after child close, including timeout kills.
    await rm(root, { recursive: true, force: true })
  }
}

// 正式用例：三种负载都要求"列表服务不独占 Host 队列"。
it.each(['modest', 'tail', 'cheap'] as const)('serves the %s projection list without monopolizing the Host queue', async (workload) => {
  // 收集各次尝试的报告。
  const reports: ProjectionListReport[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) reports.push(await run(workload))
  // 首次列表 + JSON 耗时样本（每报告第一个采样）。
  const firstMs = reports.map(report => report.samples[0]!.listAndJsonMs)
  // 重复列表耗时样本（其余采样的中位数）。
  const repeatMs = reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonMs)))
  // 堆用量样本：取每个报告所有采样与响应性段中的最大值。
  const heapBytes = reports.map(report => Math.max(...[...report.samples, report.responsiveness].map(sample => sample.memory.heapUsedBytes)))
  // 汇总各指标的中位数：首次/重复的列表耗时、CPU 耗时、保留堆、最差回调延迟、让渡调用数等。
  const medians = {
    firstListAndJsonMs: median(firstMs),
    repeatListAndJsonMs: median(repeatMs),
    firstListMs: median(reports.map(report => report.samples[0]!.listMs)),
    repeatListMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listMs)))),
    firstListAndJsonCpuMs: median(reports.map(report => report.samples[0]!.listAndJsonCpuMs)),
    repeatListAndJsonCpuMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonCpuMs)))),
    retainedHeapBytes: median(heapBytes),
    worstCallbackDelayMs: median(reports.map(report => report.responsiveness.maxCallbackDelayMs)),
    repeatYieldCalls: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.yieldCalls)))),
    firstCallbackDelayMs: median(reports.map(report => report.samples[0]!.callbackDelayMs)),
    repeatCallbackDelayMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.callbackDelayMs)))),
    firstEventLoopMaxMs: median(reports.map(report => report.samples[0]!.eventLoopMaxMs)),
    repeatEventLoopMaxMs: median(reports.map(report => Math.max(...report.samples.slice(1).map(sample => sample.eventLoopMaxMs)))),
  }
  // 三项预算：列表耗时（按负载）、回调延迟、保留堆内存。
  const budgets = {
    listAndJsonMs: ciTimeBudget(LIST_REFERENCE_MS[workload]),
    callbackDelayMs: ciTimeBudget(CALLBACK_REFERENCE_MS),
    retainedHeapBytes: Math.ceil(RETAINED_HEAP_REFERENCE_BYTES * PERFORMANCE_BUDGET_HEADROOM),
  }
  // 输出 JSON 摘要（含运行环境）。
  console.log(JSON.stringify({ benchmark: `session-corpus/projection-list-${workload}`,
    reports, medians, budgets, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model } }))

  // 把列表耗时与最差回调延迟指标及预算写入缩放报告。
  recordTimings({
    id: `session-corpus/projection-list-${workload}`,
    measures: `Host Session-list projection and JSON for ${SESSIONS[workload].toLocaleString('en-US')} Sessions, and the longest Host queue delay meanwhile.`,
    affects: 'Showing the Session sidebar; a long queue delay stalls other Web GUI requests.',
  }, {
    firstListAndJsonMs: { ms: medians.firstListAndJsonMs, cpuMs: medians.firstListAndJsonCpuMs },
    repeatListAndJsonMs: { ms: medians.repeatListAndJsonMs, cpuMs: medians.repeatListAndJsonCpuMs },
    worstCallbackDelayMs: { ms: medians.worstCallbackDelayMs, ioShare: CALLBACK_IO_SHARE },
  }, { firstListAndJsonMs: budgets.listAndJsonMs, repeatListAndJsonMs: budgets.listAndJsonMs, worstCallbackDelayMs: budgets.callbackDelayMs })
  // 结构校验：每个报告的负载名、夹具会话数、基础行数与采样数都必须符合预期。
  for (const report of reports) {
    expect(report.workload).toBe(workload)
    expect(report.fixture.sessions).toBe(SESSIONS[workload])
    expect(report.fixture.baseRows).toBe({ modest: 100, tail: 1_000, cheap: 0 }[workload])
    expect(report.samples).toHaveLength(4)
    // 每个采样（含响应性段）都必须产出全部条目与线视图。
    for (const sample of [...report.samples, report.responsiveness]) {
      expect(sample.items).toBe(report.fixture.sessions)
      expect(sample.wireViews).toBe(report.fixture.sessions)
    }
  }
  // 核心预算校验：最差回调延迟、首次与重复列表耗时、保留堆均不得超标。
  expect(medians.worstCallbackDelayMs).toBeLessThanOrEqual(budgets.callbackDelayMs)
  expect(medians.firstListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.repeatListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.retainedHeapBytes).toBeLessThanOrEqual(budgets.retainedHeapBytes)
}, ATTEMPTS * WORKER_TIMEOUT_MS + 30_000)
