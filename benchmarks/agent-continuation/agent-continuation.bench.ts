/** Baseline budgets for long-history requests, tool continuation, and fork-child discovery. */
// 文件头（JSDoc 补充）：本文件给出三大基准的基线预算——长历史请求（request-history）、工具续跑（tool continuation）、fork 子会话发现（fork-child discovery）。

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type { ContinuationReport } from './agent-continuation.worker.ts'
import type { CatalogReport } from './child-catalog.worker.ts'
import type { ProfileReport } from './profile-continuation.worker.ts'
import { WORKLOAD } from './workload.ts'

// 每个场景（scenario）重复采样的次数。
const ATTEMPTS = 5
// 单次 worker 子进程运行的超时上限（60 秒）。
const WORKER_TIMEOUT_MS = 60_000
/** Checkpoint-enabled two-CPU hosted runs have an upper observed median of 5,432.567 ms. */
// 中文补充（常量 JSDoc）：开启检查点（checkpoint）的双核托管环境下，观察到的 profile 续跑中位数上界为 5432.567ms，期望值取整为 5500ms。
const EXPECTED_PROFILE_CONTINUATION_CI_MS = 5_500
/** Apply variance headroom and round up to a whole second; the baseline is already a CI measurement. */
// 中文补充：预算 = 期望值 × 波动余量系数，再向上取整到整秒；因为基线本身就是 CI 测量值，只做放大不做折减。
const PROFILE_CONTINUATION_BUDGET_MS = Math.ceil(
  EXPECTED_PROFILE_CONTINUATION_CI_MS * PERFORMANCE_BUDGET_HEADROOM / 1_000,
) * 1_000
/** Standard two-CPU hosted CI baseline request-history median is 582.304 ms. */
// 中文补充：标准双核托管 CI 下基线请求历史的中位数为 582.304ms，期望值取 600ms。
const EXPECTED_BASELINE_REQUEST_CI_MS = 600
// 基线请求预算 = 期望值 × 余量系数（毫秒级，不取整到秒）。
const BASELINE_REQUEST_BUDGET_MS = Math.ceil(EXPECTED_BASELINE_REQUEST_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Standard two-CPU hosted CI tool-continuation median is 898.252 ms. */
// 中文补充：标准双核托管 CI 下工具续跑的中位数为 898.252ms，期望值取 900ms。
const EXPECTED_TOOL_CONTINUATION_CI_MS = 900
// 工具续跑预算 = 期望值 × 余量系数。
const TOOL_CONTINUATION_BUDGET_MS = Math.ceil(EXPECTED_TOOL_CONTINUATION_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Standard two-CPU hosted CI catalog median is 858.364 ms; 900 ms is the rounded expectation. */
// 中文补充：标准双核托管 CI 下目录（catalog）发现的中位数为 858.364ms；900ms 为取整后的期望值。
const EXPECTED_CATALOG_CI_MS = 900
// 目录场景预算 = 期望值 × 余量系数。
const CATALOG_BUDGET_MS = Math.ceil(EXPECTED_CATALOG_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Reviewed hosted limit: floor(238 × 1.25); calibration records the original reference. */
// 中文补充：经人工复核的托管环境上限：floor(238 × 1.25) = 297ms；原始参考值由校准（calibration）用例另行记录。
const REQUEST_HISTORY_BUDGET_MS = 297
// 期望的工具续跑后保留堆内存（retained heap）上限，23MB。
const EXPECTED_RETAINED_HEAP_MB = 23
// 编译产物 worker 所在目录（.dsh-build/agent-continuation）。
const WORKERS = join(import.meta.dirname, '..', '.dsh-build', 'agent-continuation')
/** Estimated storage wait of the SDK profile case, whose worker does not report CPU time: it reads files and appends synchronized log records. */
// 中文补充（常量 JSDoc）：SDK profile 场景估算的存储等待占比：其 worker 不上报 CPU 时间，因为它要读文件并同步追加日志记录。
const PROFILE_IO_SHARE = 0.15
// 各场景的用例元信息表：id、measures（测什么）、affects（影响什么）。
const CASES: Readonly<Record<Scenario, BenchmarkCase>> = {
  'request-history': {
    id: 'agent-continuation/request-history',
    measures: 'Building 40 model requests over an 800-turn tool-heavy history, without provider or network work.',
    affects: 'Every new turn in a long Session; the model request leaves later.',
  },
  'tool-continuation': {
    id: 'agent-continuation/tool-continuation',
    measures: 'Cold resume of the 800-turn Session, then 20 turns with 8 synthetic tool calls each through the real tool pipeline.',
    affects: 'Continuing a long tool-heavy Session after restarting DSH.',
  },
  'catalog': {
    id: 'agent-continuation/catalog',
    measures: 'First and repeated discovery of 16 inactive fork children with 80-turn histories.',
    affects: 'Listing forks and subagents of a Session that has many children.',
  },
  'profile-continuation': {
    id: 'agent-continuation/profile-continuation',
    measures: 'Boot plus 100 turns with 800 real file reads through the shipped sdk-minimal profile.',
    affects: 'Headless SDK automation running a long agent task.',
  },
}

// 场景名联合类型：四个基准场景。
type Scenario = 'request-history' | 'catalog' | 'tool-continuation' | 'profile-continuation'
// 各场景报告类型的并集。
type Report = ContinuationReport | CatalogReport | ProfileReport

// 根据场景名返回对应 worker 的编译产物文件名。
function workerName(scenario: Scenario): string {
  if (scenario === 'profile-continuation') return 'profile-continuation.worker.js'
  return scenario === 'catalog' ? 'child-catalog.worker.js' : 'agent-continuation.worker.js'
}

// 通用 runner：在指定根目录 root 上以指定模式启动对应场景的 worker，返回其报告。
async function run<Output>(root: string, scenario: Scenario, mode: string): Promise<Output> {
  const outcome = await runBuiltBenchmarkWorker<Output>({
    worker: join(WORKERS, workerName(scenario)), args: [root, mode],
    timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
  })
  // 超时、被信号杀死、非零退出码或缺少报告，都视为 worker 运行失败并抛错。
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error('backend worker failed: ' + JSON.stringify(outcome))
  }
  return outcome.report
}

// 计算中位数：排序后取中间位置的元素。
function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
}

// 断言总耗时不超过预算；超出即测试失败。
function expectTotalWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

// 校准组一：验证 profile-continuation 的预算自洽性。
describe('checkpoint-enabled SDK-minimal hosted calibration', () => {
  it('accepts the recorded checkpoint-enabled workload above the buffered-write budget', () => {
    // 对五组历史录制样本取中位数。
    const recordedMedian = median([4_182.691, 5_946.326875, 5_581.127338, 5_432.567004, 4_362.941759])

    // 中位数必须是这组录制值中最慢的那组 5432.567（取上界做基线，偏保守）。
    expect(recordedMedian).toBe(5_432.567004)
    // 旧的缓冲写入预算 4250ms 已无法容纳现实样本——必须抛错，证明预算需要放宽。
    expect(() => expectTotalWithinBudget(recordedMedian, 4_250)).toThrow()
    // 新预算 PROFILE_CONTINUATION_BUDGET_MS 必须能接受该样本。
    expectTotalWithinBudget(recordedMedian, PROFILE_CONTINUATION_BUDGET_MS)
    // 锁定预算换算结果恰为 7000ms，防止系数被悄悄改动。
    expect(PROFILE_CONTINUATION_BUDGET_MS).toBe(7_000)
  })

  it('rejects a material SDK-minimal profile slowdown', () => {
    // 构造一组明显劣化（约 7800ms 中位数）的样本。
    const regressionMedian = median([7_600, 7_900, 8_000, 7_700, 7_800])

    // 校验构造值本身。
    expect(regressionMedian).toBe(7_800)
    // 劣化样本必须被预算拒绝——证明预算能捕捉真实的性能回退。
    expect(() => expectTotalWithinBudget(regressionMedian, PROFILE_CONTINUATION_BUDGET_MS)).toThrow()
  })
})

// 校准组二：catalog 目录发现的预算自洽性。
describe('standard hosted catalog calibration', () => {
  it('accepts the recorded two-CPU samples that exceed the historical budget', () => {
    // 对五组历史录制样本取中位数。
    const recordedMedian = median([797.373945, 883.157358, 858.363927, 790.568538, 904.5785669999999])

    // 校验中位数确为 858.363927。
    expect(recordedMedian).toBe(858.363927)
    // 历史预算 800ms 已无法容纳样本——必须抛错。
    expect(() => expectTotalWithinBudget(recordedMedian, 800)).toThrow()
    // 新预算必须接受该样本。
    expectTotalWithinBudget(recordedMedian, CATALOG_BUDGET_MS)
    // 锁定 catalog 预算恰为 1125ms。
    expect(CATALOG_BUDGET_MS).toBe(1_125)
  })

  it('rejects a synthetic material catalog regression', () => {
    // 构造约 1400ms 的劣化样本。
    const regressionMedian = median([1_380, 1_400, 1_420, 1_410, 1_390])

    // 校验构造值。
    expect(regressionMedian).toBe(1_400)
    // 劣化样本必须被预算拒绝。
    expect(() => expectTotalWithinBudget(regressionMedian, CATALOG_BUDGET_MS)).toThrow()
  })
})

// 校准组三：tool-continuation 工具续跑的预算自洽性。
describe('standard hosted tool-continuation calibration', () => {
  it('accepts recorded two-CPU samples but rejects a material regression', () => {
    // 对五组历史录制样本取中位数。
    const recordedMedian = median([917.006744, 892.091482, 887.838867, 905.6594390000001, 898.2517579999999])

    // 校验中位数确为 898.2517579999999。
    expect(recordedMedian).toBe(898.2517579999999)
    // 旧的 850ms 预算容纳不了样本——必须抛错。
    expect(() => expectTotalWithinBudget(recordedMedian, 850)).toThrow()
    // 新预算必须接受该样本。
    expectTotalWithinBudget(recordedMedian, TOOL_CONTINUATION_BUDGET_MS)
    // 锁定工具续跑预算恰为 1125ms。
    expect(TOOL_CONTINUATION_BUDGET_MS).toBe(1_125)
    // 构造的 1400ms 劣化值必须被拒绝。
    expect(() => expectTotalWithinBudget(1_400, TOOL_CONTINUATION_BUDGET_MS)).toThrow()
  })
})

// 校准组四：baseline request-history（基线请求历史）的预算自洽性。
describe('standard hosted baseline request-history calibration', () => {
  it('accepts recorded two-CPU samples but rejects a material regression', () => {
    // 对五组历史录制样本取中位数。
    const recordedMedian = median([618.598065, 618.606407, 582.0351149999999, 582.303506, 581.8318300000001])

    // 校验中位数确为 582.303506。
    expect(recordedMedian).toBe(582.303506)
    // 旧的 550ms 预算容纳不了样本——必须抛错。
    expect(() => expectTotalWithinBudget(recordedMedian, 550)).toThrow()
    // 新预算必须接受该样本。
    expectTotalWithinBudget(recordedMedian, BASELINE_REQUEST_BUDGET_MS)
    // 锁定基线请求预算恰为 750ms。
    expect(BASELINE_REQUEST_BUDGET_MS).toBe(750)
    // 构造的 900ms 劣化值必须被拒绝。
    expect(() => expectTotalWithinBudget(900, BASELINE_REQUEST_BUDGET_MS)).toThrow()
  })
})

// request-history 场景专用断言：使用人工复核过的 297ms 紧预算（见上方常量 JSDoc）。
function assertRequestHistoryBudget(value: number): void {
  expect(value).toBeLessThanOrEqual(REQUEST_HISTORY_BUDGET_MS)
}

// 校准组五：request-history 的紧预算自洽性。
describe('standard hosted request-history calibration', () => {
  it('accepts the recorded two-CPU samples above the historical budget', () => {
    // 五组历史录制样本（本场景已优化，数值很小）。
    const recorded = [183.355397, 184.468253, 185.042397, 182.160790, 182.924728]
    const recordedMedian = median(recorded)

    // 校验中位数确为 183.355397。
    expect(recordedMedian).toBe(183.355397)
    // 该中位数必须大于 ciTimeBudget(70)——即历史 CI 系数下的预算已不足以约束（样本比旧预算更慢），故需要紧预算。
    expect(recordedMedian).toBeGreaterThan(ciTimeBudget(70))
    // 紧预算必须接受中位数。
    assertRequestHistoryBudget(recordedMedian)
    // 连最大样本也必须落在紧预算内。
    assertRequestHistoryBudget(Math.max(...recorded))
    // 锁定紧预算恰为 297ms。
    expect(REQUEST_HISTORY_BUDGET_MS).toBe(297)
  })

  it('rejects a synthetic material request-history regression', () => {
    // 构造约 310ms 的劣化样本。
    const regressionMedian = median([308, 310, 312, 311, 309])
    // 劣化样本必须被紧预算拒绝。
    expect(() => assertRequestHistoryBudget(regressionMedian)).toThrow()
  })

  it('accepts the observed slower hosted runners', () => {
    // 两组更慢的托管运行环境（runner）的录制样本，各自取中位数。
    const recordedMedians = [
      [246.87661500000002, 246.88104699999997, 272.3702179999999, 265.796833, 272.50750700000003],
      [279.6894890000001, 297.79284899999993, 263.17839100000003, 252.66029200000003, 251.26736099999994],
    ].map(median)
    // 校验两个中位数与录制值一致。
    expect(recordedMedians).toEqual([265.796833, 263.17839100000003])
    // 这两组样本虽然超出 238ms 的历史预算，但仍须被 297ms 紧预算接受。
    for (const recordedMedian of recordedMedians) {
      expect(() => expectTotalWithinBudget(recordedMedian, 238)).toThrow()
      assertRequestHistoryBudget(recordedMedian)
    }
  })
})

// 正式基准组：在"工具密集 + 大历史"的会话上跑四个场景。
describe('continuing tool-heavy Sessions with large histories', () => {
  // 临时工作目录（scratch），所有场景数据都放在其中。
  let scratch: string | undefined
  // 各场景已"播种"（seed）好的源目录，便于后续复制复用。
  const sources = new Map<Scenario, string>()

  // 全组开始前：创建临时目录，并对 request-history、catalog 两个场景播种数据。
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-continuation-bench-'))
    for (const scenario of ['request-history', 'catalog'] as const) {
      // 为每个场景建独立子目录，以 seed 模式运行 worker 生成夹具。
      const root = join(scratch, 'source-' + scenario)
      await run(root, scenario, 'seed')
      sources.set(scenario, root)
    }
    // tool-continuation 复用 request-history 的会话数据（两者数据形态一致）。
    sources.set('tool-continuation', sources.get('request-history') as string)
  })
  // 全组结束后：递归删除临时目录。
  afterAll(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  // 对每个场景各生成一个测试用例。
  for (const scenario of ['request-history', 'tool-continuation', 'catalog', 'profile-continuation'] as const) {
    it(scenario, async () => {
      // 收集本场景的各次采样报告。
      const samples: Report[] = []
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        // 为本次尝试准备独立运行目录。
        const root = join(scratch as string, scenario + '-' + String(attempt))
        // profile 场景从零开始（mkdir 空目录，由 worker 自举）；其余场景直接复制播种好的源目录。
        if (scenario === 'profile-continuation') await mkdir(root)
        else await cp(sources.get(scenario) as string, root, { recursive: true })
        // 运行 worker 并收集报告；无论成败都清理本次运行目录。
        try { samples.push(await run<Report>(root, scenario, scenario)) }
        finally { await rm(root, { recursive: true, force: true }) }
      }
      // 汇总各次的总耗时用于统计。
      const totalMs = samples.map(sample => sample.totalMs)
      // 按场景选择对应预算：紧预算或各场景的放大预算。
      const budgetMs = scenario === 'request-history' ? REQUEST_HISTORY_BUDGET_MS
        : scenario === 'catalog' ? CATALOG_BUDGET_MS
          : scenario === 'tool-continuation' ? TOOL_CONTINUATION_BUDGET_MS : PROFILE_CONTINUATION_BUDGET_MS
      // 保留堆内存预算 = 期望值 × 余量系数。
      const retainedHeapBudgetMb = EXPECTED_RETAINED_HEAP_MB * PERFORMANCE_BUDGET_HEADROOM
      // 输出一行 JSON 摘要：含负载描述、运行环境（CPU 型号/并行度/平台/Node 版本）、样本与中位数、预算。
      console.log(JSON.stringify({
        benchmark: 'agent-continuation/' + scenario, workload: WORKLOAD,
        runtime: {
          cpuModels: [...new Set(cpus().map(cpu => cpu.model))],
          availableParallelism: availableParallelism(),
          platform: process.platform, arch: process.arch,
          node: process.version, v8: process.versions.v8,
        },
        samples, totalMs: { min: Math.min(...totalMs), median: median(totalMs), max: Math.max(...totalMs) },
        budgetMs, ...(scenario === 'tool-continuation' ? { retainedHeapBudgetMb } : {}),
      }))
      // 记录耗时指标：profile 场景只报 IO 占比（无 CPU 数据）；其余场景附上用户态+内核态 CPU 时间的中位数。
      recordTimings(CASES[scenario], {
        totalMs: scenario === 'profile-continuation'
          ? { ms: median(totalMs), ioShare: PROFILE_IO_SHARE }
          : { ms: median(totalMs), cpuMs: median((samples as (ContinuationReport | CatalogReport)[]).map(sample => sample.cpuUserMs + sample.cpuSystemMs)) },
      }, { totalMs: budgetMs })
      // request-history 用人工复核的紧预算断言；其余场景用放大后的预算。
      if (scenario === 'request-history') assertRequestHistoryBudget(median(totalMs))
      else expectTotalWithinBudget(median(totalMs), budgetMs)
      // 仅工具续跑场景校验保留堆内存：工具调用会产生缓存，防止内存无界增长。
      if (scenario === 'tool-continuation') {
        expect(median((samples as ContinuationReport[]).map(sample => sample.retainedHeapMb)))
          .toBeLessThanOrEqual(retainedHeapBudgetMb)
      }
    })
  }
})
