/** Required budgets for listing, searching, and forking Sessions in corpora with the measured local length distribution. */
// 文件头（JSDoc 补充）：在遵循实测本地长度分布的语料（corpus）上，为会话的列表（list）、搜索（search）与 fork 操作规定性能预算。

import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase, type Timing } from '../support/scaling-report.ts'
import { anchorShape, ANCHOR_COUNT, sessionShape } from './corpus-shape.ts'
import { subagentRank } from './synthetic-corpus.ts'
import type {
  AnchorsReport,
  ForkReport,
  ListReport,
  PhaseCpu,
  SearchReport,
  SeedReport,
  SessionCorpusReport,
} from './session-corpus.worker.ts'

/**
 * Sessions per corpus. Search and fork use separate roots, so fork children never reach the search index;
 * the list corpus is the largest that keeps this file within its time limit.
 */
// 中文补充（JSDoc）：各语料的会话数。搜索与 fork 使用独立根目录，因此 fork 出的子会话永远不会进入搜索索引；
// 中文补充（JSDoc）：list 语料规模是本文件能在时限内完成的上限。
const CORPUS = { search: 1_000, fork: 1_000, list: 3_000 } as const
/** Upper bound on this file's hosted CI wall time, from seeding through the last case. */
// 中文补充（常量 JSDoc）：本文件在托管 CI 上的总墙钟时间上限（从播种到最后一个用例）。
const FILE_LIMIT_MS = 300_000
/** Per-child deadline: an endpoint slower than its budget still reports a measurement instead of a kill. */
// 中文补充（常量 JSDoc）：每个子进程的截止时间：慢于预算的端点仍会产出测量值，而不是被直接杀掉。
const WORKER_TIMEOUT_MS = FILE_LIMIT_MS
/** Fixed old-space capacity makes fork RSS comparable across hosted V8 heap defaults. */
// 中文补充（常量 JSDoc）：固定老生代容量，使 fork 的 RSS 在不同托管 V8 堆默认值之间可比。
const FORK_HEAP_LIMIT_MB = 512
/** Fresh processes per list and fork-strata scenario; the median enforces each budget. */
// 中文补充（常量 JSDoc）：列表与 fork 分层场景各自的新进程次数；以中位数来执行预算判定。
const ATTEMPTS = { list: 3, fork: 3 } as const
/** Concurrent anchor-preparation processes; standard hosted runners have two CPUs. */
// 中文补充（常量 JSDoc）：锚点准备（anchor-preparation）的并发进程数；标准托管运行器只有两个 CPU。
const PREPARATION_PROCESSES = 2
/** Midpoints of ten equal length strata of the fork corpus. */
// 中文补充（常量 JSDoc）：fork 语料十个等长分层（strata）的中点名次。
const FORK_STRATA = Array.from({ length: 10 }, (_, stratum) => Math.floor(((stratum + 0.5) * CORPUS.fork) / 10))
/** The highest top-level rank at the measured p99; forking a subagent child adds a lineage lookup. */
// 中文补充（常量 JSDoc）：实测 p99 对应的最高顶层名次；fork 一个子代理（subagent）子会话会额外增加一次谱系查找。
const FORK_P99_RANK = topLevelRank(Math.ceil(0.99 * CORPUS.fork) - 1)
/** The longest Session; one sample, because one fork takes about 20 s on standard hosted CI. */
// 中文补充（常量 JSDoc）：最长的会话；只采样一次——在标准托管 CI 上一次 fork 约需 20 秒。
const FORK_LONGEST_RANK = CORPUS.fork - 1
// 编译产物 worker 的绝对路径。
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'session-corpus.worker.js')

/** Higher recorded median of the standard EPYC 7763 and EPYC 9V74 hosted runners, per budgeted endpoint. */
// 中文补充（常量 JSDoc）：标准 EPYC 7763 与 EPYC 9V74 两种托管运行器中较高一侧的录制中位数（按预算端点）。
const RECORDED_CI_MS = {
  listBoot: 2_317.8,
  listFirst: 3_228.7,
  listRepeat: 2_636.4,
  searchFirst: 144_359,
  searchRepeat: 3_426.3,
  forkStratumMedian: 95.5,
  forkP99: 1_066.2,
  forkLongest: 20_326.7,
} as const
/** Hosted CI expectations, rounded above {@link RECORDED_CI_MS} before variance headroom. */
// 中文补充（常量 JSDoc）：托管 CI 期望值——在 {@link RECORDED_CI_MS} 之上取整（波动余量之前）。
const EXPECTED_CI_MS = {
  listBoot: 2_400,
  listFirst: 3_300,
  listRepeat: 2_700,
  searchFirst: 145_000,
  searchRepeat: 3_500,
  forkStratumMedian: 100,
  forkP99: 1_100,
  forkLongest: 20_400,
} as const satisfies Record<keyof typeof RECORDED_CI_MS, number>
/** Higher recorded peak RSS of the two runner models; memory takes headroom but no time scale. */
// 中文补充（常量 JSDoc）：两种运行器中较高的录制峰值 RSS；内存只放大余量，不做时间缩放。
const RECORDED_CI_PEAK_RSS_MB = { list: 742.7, search: 1_197.8, fork: 745.1 } as const
const EXPECTED_CI_PEAK_RSS_MB = {
  list: 750,
  search: 1_200,
  fork: 750,
} as const satisfies Record<keyof typeof RECORDED_CI_PEAK_RSS_MB, number>

// 各语料操作的用例元信息。
const CASES: Readonly<Record<CorpusName, BenchmarkCase>> = {
  list: {
    id: `session-corpus/list-${String(CORPUS.list)}`,
    measures: `Cold Web Host boot, then first and repeated session.list over ${CORPUS.list.toLocaleString('en-US')} Sessions of realistic length.`,
    affects: 'Starting DSH and showing the Session list for a heavy user.',
  },
  search: {
    id: 'session-corpus/search',
    measures: `First session.search, which builds the content index over ${CORPUS.search.toLocaleString('en-US')} Sessions, then a second query.`,
    affects: 'Searching Session content in deployments that enable search; shipped profiles disable it.',
  },
  fork: {
    id: 'session-corpus/fork',
    measures: `session.fork for ten length strata, the p99 Session, and the longest of ${CORPUS.fork.toLocaleString('en-US')} Sessions.`,
    affects: 'Forking a conversation to try another direction.',
  },
}

// 语料名联合类型。
type CorpusName = keyof typeof CORPUS

/**
 * Pair the median wall time of each list phase with the median process CPU time of the same phase.
 * @param samples - Wall-clock samples per phase.
 * @param cpu - CPU time per sample.
 * @returns Endpoints for the scaled report.
 */
// 中文补充（JSDoc）：把列表各阶段的墙钟中位数与同阶段的进程 CPU 中位数配对。
// 中文补充（JSDoc）：@param samples —— 每阶段的墙钟样本。
// 中文补充（JSDoc）：@param cpu —— 每样本的 CPU 时间。
// 中文补充（JSDoc）：@returns —— 供缩放报告使用的端点集合。
function phaseTimings(
  samples: Readonly<Record<keyof PhaseCpu, readonly number[]>>,
  cpu: readonly PhaseCpu[],
): Record<keyof PhaseCpu, Timing> {
  // 对单个阶段：墙钟取中位数，CPU 也取中位数。
  const phase = (key: keyof PhaseCpu): Timing => ({ ms: median(samples[key]), cpuMs: median(cpu.map(entry => entry[key])) })
  return { bootMs: phase('bootMs'), firstMs: phase('firstMs'), repeatMs: phase('repeatMs') }
}

// 把名次向下调整到顶层会话（跳过子代理会话）。
function topLevelRank(rank: number): number {
  return subagentRank(rank) ? rank - 1 : rank
}

// 预算 = 期望值 × 波动余量系数，向上取整。
function budget(expected: number): number {
  return Math.ceil(expected * PERFORMANCE_BUDGET_HEADROOM)
}

/** Test deadline for sequential workers; it outlasts their deadlines, so every child is reaped before cleanup. */
// 中文补充（函数 JSDoc）：串行 worker 的测试用例截止时间；它必须长于各子进程截止时间，确保清理前所有子进程都被回收。
function serialDeadline(workers: number): number {
  return workers * WORKER_TIMEOUT_MS + 30_000
}

// 通用 runner：启动编译 worker，fork 场景附加固定堆上限。
async function run<Report extends SessionCorpusReport>(args: readonly string[]): Promise<Report> {
  const outcome = await runBuiltBenchmarkWorker<Report>({
    worker: WORKER, args, timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
    ...(args[1] === 'fork' ? { heapLimitMb: FORK_HEAP_LIMIT_MB } : {}),
  })
  // 报告缺失时附带最后 20 行 stderr 抛错。
  if (outcome.report === undefined) {
    const stderr = outcome.stderr.trim().split('\n').slice(-20).join('\n')
    throw new Error(`session-corpus worker ${args[1] ?? ''} failed: exit=${String(outcome.exitCode)}, `
      + `signal=${String(outcome.signal)}, timedOut=${String(outcome.timedOut)}\n${stderr}`)
  }
  return outcome.report
}

/**
 * Split anchors into byte-balanced groups, each in ascending order so its byte model starts on small bodies.
 * @returns one anchor group per preparation process.
 */
// 中文补充（JSDoc）：把锚点分成字节量均衡的若干组，组内升序排列，使各组的字节模型从小体型开始生成。
// 中文补充（JSDoc）：@returns —— 每个准备进程一组锚点。
function anchorGroups(): number[][] {
  // 每组维护当前累计字节量。
  const groups = Array.from({ length: PREPARATION_PROCESSES }, () => ({ bytes: 0, anchors: [] as number[] }))
  // 锚点按字节数从大到小排序，逐一放入当前最轻的组（贪心装箱）。
  const bySize = Array.from({ length: ANCHOR_COUNT }, (_, anchor) => anchor)
    .sort((left, right) => anchorShape(right).logicalBytes - anchorShape(left).logicalBytes)
  for (const anchor of bySize) {
    const group = groups.reduce((smallest, candidate) => candidate.bytes < smallest.bytes ? candidate : smallest)
    group.bytes += anchorShape(anchor).logicalBytes
    group.anchors.push(anchor)
  }
  // 组内按锚点下标升序返回。
  return groups.map(group => group.anchors.sort((left, right) => left - right))
}

// 计算中位数。
function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

// 数值保留 1 位小数。
function rounded(values: readonly number[]): number[] {
  return values.map(value => Math.round(value * 10) / 10)
}

// 断言数值不超过预算上限。
function expectWithinBudget(value: number, limit: number): void {
  expect(value).toBeLessThanOrEqual(limit)
}

// 采集运行环境信息（CPU 型号、并行度、平台、Node 版本）。
function environment() {
  return {
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  }
}

// 校准组一：语料形状分布的自洽性校验。
describe('Session corpus workload', () => {
  it('is at least the measured distribution at every rank of every corpus', () => {
    for (const count of Object.values(CORPUS)) {
      // 为语料的每个名次生成目标形状。
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      // 全部锚点都必须被用到。
      expect(new Set(shapes.map(shape => shape.anchor)).size).toBe(ANCHOR_COUNT)
      // 中位名次必须对应第 5 号锚点。
      expect(shapes[Math.floor(count / 2) - 1]).toEqual(anchorShape(4))
      // 最大名次必须是实测最大值（84467 事件 / 48MB / 2181 回合）。
      expect(shapes.at(-1)).toEqual({ anchor: ANCHOR_COUNT - 1, events: 84_467, logicalBytes: 48_139_877, turns: 2_181 })
      // 形状必须按名次单调不减（事件数与字节数）。
      for (let rank = 1; rank < count; rank++) {
        const [previous, current] = [shapes[rank - 1], shapes[rank]] as const
        expect(current?.events).toBeGreaterThanOrEqual(previous?.events ?? 0)
        expect(current?.logicalBytes).toBeGreaterThanOrEqual(previous?.logicalBytes ?? 0)
      }
    }
    // 越界名次必须抛错。
    expect(() => sessionShape(CORPUS.fork, CORPUS.fork)).toThrow('outside')
  })

  it('forks top-level Sessions at the strata midpoints, the measured p99, and the maximum', () => {
    // fork 目标名次集合。
    const ranks = [...FORK_STRATA, FORK_P99_RANK, FORK_LONGEST_RANK]
    // 名次不得落在子代理会话上。
    expect(ranks.filter(subagentRank)).toEqual([])
    // 校验十个分层中点的具体取值。
    expect(FORK_STRATA).toEqual([50, 150, 250, 350, 450, 550, 650, 750, 850, 950])
    // p99 名次与最长名次对应实测的 7229 与 84467 事件。
    expect(sessionShape(FORK_P99_RANK, CORPUS.fork).events).toBe(7_229)
    expect(sessionShape(FORK_LONGEST_RANK, CORPUS.fork).events).toBe(84_467)
  })

  it('accepts every recorded hosted median and rejects one a quarter above its expectation', () => {
    // 把全部录制值与期望值配对（耗时端点 + 内存端点）。
    const endpoints = [
      ...(Object.keys(EXPECTED_CI_MS) as (keyof typeof EXPECTED_CI_MS)[])
        .map(key => [RECORDED_CI_MS[key], EXPECTED_CI_MS[key]] as const),
      ...(Object.keys(EXPECTED_CI_PEAK_RSS_MB) as (keyof typeof EXPECTED_CI_PEAK_RSS_MB)[])
        .map(key => [RECORDED_CI_PEAK_RSS_MB[key], EXPECTED_CI_PEAK_RSS_MB[key]] as const),
    ]
    // 共 11 个端点。
    expect(endpoints).toHaveLength(11)
    for (const [recorded, expected] of endpoints) {
      // 录制值不得高于期望值，且必须落在预算内。
      expect(recorded).toBeLessThanOrEqual(expected)
      expectWithinBudget(recorded, budget(expected))
      // 超出期望 26% 的劣化值必须被拒绝。
      expect(() => expectWithinBudget(Math.ceil(expected * 1.26), budget(expected))).toThrow()
    }
  })
})

// 正式操作组：播种三种语料并测量 list / search / fork。
describe('Session corpus operations', () => {
  // 临时根目录。
  let scratch = ''
  // 全组开始时间。
  let started = 0
  // 各语料的播种报告。
  let seeded: readonly SeedReport[] = []
  // 按语料名取对应子目录。
  const root = (name: CorpusName): string => join(scratch, `corpus-${name}`)

  // 全组开始前：创建临时目录、并发准备锚点与播种语料。
  beforeAll(async () => {
    started = performance.now()
    scratch = await mkdtemp(join(tmpdir(), 'dsh-session-corpus-bench-'))
    // 两组锚点并行准备（合成"种子体"素材）。
    const prepared = await Promise.all(anchorGroups().map(group => run<AnchorsReport>([scratch, 'anchors', ...group.map(String)])))
    // 三种语料并行播种。
    seeded = await Promise.all((Object.keys(CORPUS) as CorpusName[])
      .map(name => run<SeedReport>([scratch, 'seed', name, String(CORPUS[name])])))
    console.log(JSON.stringify({ benchmark: 'session-corpus/seed', prepared, seeded, environment: environment() }))
  }, serialDeadline(2))

  // 全组结束后删除临时目录。
  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('writes corpora at least as long as the measured distribution', () => {
    // 播种报告必须覆盖全部语料名。
    expect(seeded.map(report => report.name).sort()).toEqual(Object.keys(CORPUS).sort())
    for (const { name, corpus } of seeded) {
      const count = CORPUS[name as CorpusName]
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      // 会话数与不同"种子体"数必须精确匹配。
      expect(corpus.sessions).toBe(count)
      expect(corpus.distinctBodies).toBe(ANCHOR_COUNT)
      // 总事件数与总字节数必须不低于实测分布之和。
      expect(corpus.events).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.events, 0))
      expect(corpus.logicalBytes).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.logicalBytes, 0))
    }
  })

  it(`lists ${String(CORPUS.list)} Sessions after a cold Host boot`, async () => {
    // 列表场景的四项预算。
    const budgets = {
      bootMs: budget(EXPECTED_CI_MS.listBoot),
      firstMs: budget(EXPECTED_CI_MS.listFirst),
      repeatMs: budget(EXPECTED_CI_MS.listRepeat),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.list),
    }
    // 三个新进程分别跑冷启动 + 首次 + 重复列表。
    const reports: ListReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.list; attempt++) {
      reports.push(await run<ListReport>([root('list'), 'list', String(CORPUS.list)]))
    }
    // 汇总各样本指标。
    const samples = {
      bootMs: rounded(reports.map(report => report.bootMs)),
      firstMs: rounded(reports.map(report => report.firstMs)),
      repeatMs: rounded(reports.map(report => report.repeatMs)),
      peakRssMb: reports.map(report => report.memory.peakRssMb),
      heapUsedMb: reports.map(report => report.memory.heapUsedMb),
    }
    console.log(JSON.stringify({ benchmark: `session-corpus/list-${String(CORPUS.list)}`, samples, budgets, environment: environment() }))
    // 记录阶段耗时（墙钟 + CPU 配对）与峰值内存。
    recordTimings(CASES.list, phaseTimings(samples, reports.map(report => report.cpu)),
      { bootMs: budgets.bootMs, firstMs: budgets.firstMs, repeatMs: budgets.repeatMs })
    recordPeakMemory(CASES.list, { peakRssMb: Math.max(...samples.peakRssMb) })
    // 完整性校验：带投影的条目数必须等于语料规模。
    for (const report of reports) expect(report.itemsWithProjections).toBe(CORPUS.list)
    // 四项预算逐一校验（各取中位数）。
    expectWithinBudget(median(samples.bootMs), budgets.bootMs)
    expectWithinBudget(median(samples.firstMs), budgets.firstMs)
    expectWithinBudget(median(samples.repeatMs), budgets.repeatMs)
    expectWithinBudget(median(samples.peakRssMb), budgets.peakRssMb)
  }, serialDeadline(ATTEMPTS.list))

  it(`searches ${String(CORPUS.search)} Sessions with a cold and then a built content index`, async () => {
    // 搜索场景的三项预算。
    const budgets = {
      firstMs: budget(EXPECTED_CI_MS.searchFirst),
      repeatMs: budget(EXPECTED_CI_MS.searchRepeat),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.search),
    }
    // One sample: the cold index build dominates this file's time.
    const report = await run<SearchReport>([root('search'), 'search'])
    console.log(JSON.stringify({ benchmark: 'session-corpus/search', report, budgets, environment: environment() }))
    // 记录首次（冷索引构建）与重复查询的耗时与峰值内存。
    recordTimings(CASES.search, {
      firstMs: { ms: report.firstMs, cpuMs: report.cpu.firstMs },
      repeatMs: { ms: report.repeatMs, cpuMs: report.cpu.repeatMs },
    }, { firstMs: budgets.firstMs, repeatMs: budgets.repeatMs })
    recordPeakMemory(CASES.search, { peakRssMb: report.memory.peakRssMb })
    // 三项预算逐一校验。
    expectWithinBudget(report.firstMs, budgets.firstMs)
    expectWithinBudget(report.repeatMs, budgets.repeatMs)
    expectWithinBudget(report.memory.peakRssMb, budgets.peakRssMb)
  }, serialDeadline(1))

  it(`forks Sessions across the length distribution of ${String(CORPUS.fork)} Sessions`, async () => {
    // fork 场景的四项预算。
    const budgets = {
      stratumMedianMs: budget(EXPECTED_CI_MS.forkStratumMedian),
      p99Ms: budget(EXPECTED_CI_MS.forkP99),
      longestMs: budget(EXPECTED_CI_MS.forkLongest),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.fork),
    }
    // 三个新进程各 fork 十个分层中点与 p99 名次。
    const reports: ForkReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.fork; attempt++) {
      reports.push(await run<ForkReport>([root('fork'), 'fork', ...[...FORK_STRATA, FORK_P99_RANK].map(String)]))
    }
    // 最长会话单独跑一次（约 20 秒）。
    const longest = await run<ForkReport>([root('fork'), 'fork', String(FORK_LONGEST_RANK)])
    // 从报告中取指定名次的 fork 条目。
    const forkEntry = (report: ForkReport, rank: number): ForkReport['forks'][number] => {
      const fork = report.forks.find(entry => entry.rank === rank)
      if (fork === undefined) throw new Error(`fork report omits rank ${String(rank)}`)
      return fork
    }
    const forkMs = (report: ForkReport, rank: number): number => forkEntry(report, rank).forkMs
    const forkCpuMs = (report: ForkReport, rank: number): number => forkEntry(report, rank).forkCpuMs
    // 汇总样本指标。
    const samples = {
      stratumMedianMs: rounded(reports.map(report => median(FORK_STRATA.map(rank => forkMs(report, rank))))),
      p99Ms: rounded(reports.map(report => forkMs(report, FORK_P99_RANK))),
      longestMs: Math.round(forkMs(longest, FORK_LONGEST_RANK) * 10) / 10,
      perRank: reports.map(report => report.forks.map(({ rank, sourceEvents, forkMs }) => ({ rank, sourceEvents, forkMs: Math.round(forkMs) }))),
      peakRssMb: [...reports, longest].map(report => report.memory.peakRssMb),
    }
    console.log(JSON.stringify({ benchmark: 'session-corpus/fork', samples, budgets, environment: environment() }))
    // 记录分层中位、p99 与最长 fork 的耗时与峰值内存。
    recordTimings(CASES.fork, {
      stratumMedianMs: {
        ms: median(samples.stratumMedianMs),
        cpuMs: median(reports.map(report => median(FORK_STRATA.map(rank => forkCpuMs(report, rank))))),
      },
      p99Ms: { ms: median(samples.p99Ms), cpuMs: median(reports.map(report => forkCpuMs(report, FORK_P99_RANK))) },
      longestMs: { ms: samples.longestMs, cpuMs: forkCpuMs(longest, FORK_LONGEST_RANK) },
    },
      { stratumMedianMs: budgets.stratumMedianMs, p99Ms: budgets.p99Ms, longestMs: budgets.longestMs })
    recordPeakMemory(CASES.fork, { peakRssMb: Math.max(...samples.peakRssMb) })
    // 四项预算逐一校验。
    expectWithinBudget(median(samples.stratumMedianMs), budgets.stratumMedianMs)
    expectWithinBudget(median(samples.p99Ms), budgets.p99Ms)
    expectWithinBudget(samples.longestMs, budgets.longestMs)
    expectWithinBudget(Math.max(...samples.peakRssMb), budgets.peakRssMb)
  }, serialDeadline(ATTEMPTS.fork + 1))

  it(`completes within ${String(FILE_LIMIT_MS / 60_000)} minutes`, () => {
    // 全文件耗时必须低于 5 分钟上限。
    const elapsedMs = performance.now() - started
    console.log(JSON.stringify({ benchmark: 'session-corpus/total', elapsedMs: Math.round(elapsedMs), limitMs: FILE_LIMIT_MS }))
    expectWithinBudget(elapsedMs, FILE_LIMIT_MS)
  })
})
