/** Isolated worker for cold Session phase, first-history, and Agent-resume benchmarks. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, {
  interruptedTurnClosers,
  SessionId,
  SessionLogOffset,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
// These Host-only adapters have no public Node export and are compiled into the benchmark worker.
import { HistoryController } from '../../packages/api/session-controller/src/history/controller.ts'
import { WebController } from '../../packages/api/session-controller/src/web/controller.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { SYNTHETIC_SESSION_ID } from './session-open.constants.ts'

/** Worker scenario selected by the parent benchmark. */
// 父基准进程选择的 worker 场景。
export type SessionOpenBenchmarkScenario =
  | 'phase-migrate'
  | 'phase-steady'
  | 'first-history'
  | 'agent-resume'

/** One post-GC process memory observation. */
// 一次垃圾回收（GC）后的进程内存观测。
export interface BenchmarkMemorySnapshot {
  // 已用堆（MB）。
  readonly heapUsedMb: number
  // 外部内存（external，MB）。
  readonly externalMb: number
  // ArrayBuffer 占用（MB）。
  readonly arrayBuffersMb: number
  // 常驻内存（RSS，MB）。
  readonly rssMb: number
  // 进程峰值 RSS（MB）。
  readonly peakRssMb: number
}

/** Memory retained by one benchmark endpoint relative to its initialized Host. */
// 一个基准端点相对已初始化宿主（Host）保留的内存增量。
export interface BenchmarkMemoryDelta {
  // 已用堆增量（MB）。
  readonly heapUsedMb: number
  // 外部内存增量（MB）。
  readonly externalMb: number
  // ArrayBuffer 增量（MB）。
  readonly arrayBuffersMb: number
  // 常驻内存增量（MB）。
  readonly rssMb: number
}

/** Timings and memory emitted by one isolated scenario. */
// 一个隔离场景输出的计时与内存报告。
export interface SessionOpenWorkerReport {
  // 本 worker 运行的场景名。
  readonly scenario: SessionOpenBenchmarkScenario
  // 场景总耗时（毫秒）。
  readonly totalMs: number
  // 仅阶段场景携带的四阶段耗时。
  readonly phases?: {
    // 打开句柄阶段耗时。
    readonly openMs: number
    // 读取日志阶段耗时。
    readonly readMs: number
    // 会话恢复（restore）阶段耗时。
    readonly sessionRestoreMs: number
    // 投影（projection）水合阶段耗时。
    readonly projectionMs: number
  }
  // 用户态 CPU 毫秒。
  readonly cpuUserMs: number
  // 内核态 CPU 毫秒。
  readonly cpuSystemMs: number
  // 场景结束时的事件数。
  readonly events: number
  // 测量前 GC 后的内存快照。
  readonly beforeGc: BenchmarkMemorySnapshot
  // 测量后 GC 后的内存快照。
  readonly afterGc: BenchmarkMemorySnapshot
  // 前后快照之差（测量端点保留的内存）。
  readonly retained: BenchmarkMemoryDelta
}

// 拒绝搜索的查询引擎桩：搜索不在会话打开基准的测量范围内。
class BenchmarkSessionQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    // 会话搜索：直接拒绝。
    return Promise.reject(new Error('search is outside the Session opening benchmark'))
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    // 事件搜索：直接拒绝。
    return Promise.reject(new Error('search is outside the Session opening benchmark'))
  }
}

function megabytes(bytes: number): number {
  // 把字节数换算为保留一位小数的 MB（104857.6 = 0.1 MiB）。
  return Math.round(bytes / 104_857.6) / 10
}

function memorySnapshot(): BenchmarkMemorySnapshot {
  // 读取当前进程内存用量。
  const memory = process.memoryUsage()
  // 组装快照：各项换算为 MB，峰值 RSS 由 KB 换算。
  return {
    heapUsedMb: megabytes(memory.heapUsed),
    externalMb: megabytes(memory.external),
    arrayBuffersMb: megabytes(memory.arrayBuffers),
    rssMb: megabytes(memory.rss),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

async function collectGarbage(): Promise<BenchmarkMemorySnapshot> {
  // 从全局对象取出 gc 函数（需要 --expose-gc 才存在）。
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  // 缺少 gc 说明启动参数不对，测量结果不可信。
  if (gc === undefined) throw new Error('Session opening benchmark requires --expose-gc')
  // 第一次 GC：回收大部分垃圾。
  gc()
  // 让出事件循环，使挂起的终结器（finalizer）有机会执行。
  await scheduler.yield()
  // 第二次 GC：回收终结器释放后产生的次级垃圾。
  gc()
  // 返回 GC 后的内存快照。
  return memorySnapshot()
}

function memoryDelta(
  before: BenchmarkMemorySnapshot,
  after: BenchmarkMemorySnapshot,
): BenchmarkMemoryDelta {
  // 计算前后快照各项差值（保留一位小数）。
  return {
    heapUsedMb: Math.round((after.heapUsedMb - before.heapUsedMb) * 10) / 10,
    externalMb: Math.round((after.externalMb - before.externalMb) * 10) / 10,
    arrayBuffersMb: Math.round((after.arrayBuffersMb - before.arrayBuffersMb) * 10) / 10,
    rssMb: Math.round((after.rssMb - before.rssMb) * 10) / 10,
  }
}

async function installProjectionSet(ctx: Context): Promise<void> {
  // Mirrors projection owners mounted by the base and web-app bundles without timing profile boot.
  // 注册 Agent 预设投影定义（与生产一致）。
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  // 挂载会话标题服务（回退标题与最大长度限制同生产）。
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  // 挂载会话统计插件。
  await ctx.plugin(SessionStatsPlugin)
  // 挂载会话轮次大纲插件。
  await ctx.plugin(SessionTurnOutlinePlugin)
  // 挂载令牌计量服务。
  await ctx.plugin(TokenMeter)
}

/** Owns one initialized Host and the live endpoint retained through its final GC sample. */
class SessionBenchmarkHost {
  // 阶段场景持有的会话准备对象（保持存活以便测量保留内存）。
  private preparation: SessionPreparation | undefined
  // Agent 恢复场景持有的句柄。
  private agentHandle: AgentHandle | undefined
  // 首次历史场景的订阅中止控制器。
  private historyAbort: AbortController | undefined
  // 首次历史场景的历史迭代器。
  private historyIterator: AsyncIterator<unknown> | undefined
  // 需要在最终 GC 采样时保持可达的测量端点。
  private retained: unknown

  // 私有构造：统一通过 create 工厂创建。
  private constructor(
    private readonly ctx: Context,
    private readonly scenario: SessionOpenBenchmarkScenario,
    private readonly history: WebController | undefined,
  ) {}

  static async create(root: string, scenario: SessionOpenBenchmarkScenario): Promise<SessionBenchmarkHost> {
    // 新建依赖注入容器。
    const ctx = new Context()
    // 是否为 Agent 恢复场景。
    const agentScenario = scenario === 'agent-resume'
    // Agent 场景挂载完整的 AgentLoop 测试依赖；其他场景只挂会话核心服务。
    if (agentScenario) await mountAgentLoopTestDependencies(ctx)
    else {
      // 挂载会话投影注册表。
      await ctx.plugin(SessionProjectionRegistry)
      // 挂载 Agent 注册表。
      await ctx.plugin(AgentRegistry)
      // 挂载会话存储。
      await ctx.plugin(SessionStore)
    }
    // 安装与生产一致的投影集合。
    await installProjectionSet(ctx)
    // 挂载 JSONL 会话持久化（zstd 压缩）。
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    // 首次历史场景需要 Web 控制器。
    let history: WebController | undefined
    if (scenario === 'first-history') {
      // 注册拒绝搜索的查询引擎桩。
      new BenchmarkSessionQuery(ctx)
      // 组装 Web 控制器与历史控制器。
      history = new WebController(ctx, new HistoryController(ctx), (observation) => {
        // First-history ends at snapshot delivery; Agent-resume owns live activation and retention.
        // 观察结束时立即释放：首次历史止于快照投递，活跃保持归 Agent 恢复场景。
        observation[Symbol.dispose]()
      })
    }
    // Agent 场景挂载 AgentLoop（agents 为空：只测恢复，不做模型调用）。
    if (agentScenario) await ctx.plugin(AgentLoop, { agents: [] })
    // 构造宿主实例。
    return new SessionBenchmarkHost(ctx, scenario, history)
  }

  async measure(): Promise<SessionOpenWorkerReport> {
    // 测量前先 GC 并记录基线快照。
    const beforeGc = await collectGarbage()
    // 记录起始时刻。
    const started = performance.now()
    // 记录起始 CPU 用量。
    const cpuStarted = process.cpuUsage()
    // 执行被测场景。
    const measured = await this.runScenario()
    // 统计总墙钟耗时。
    const totalMs = performance.now() - started
    // 统计同区间的用户/内核 CPU 用量。
    const cpu = process.cpuUsage(cpuStarted)
    // 场景必须保留其测量端点，否则保留内存的测量无意义。
    if (this.retained === undefined) throw new Error(`${this.scenario} did not retain its measured endpoint`)
    // 测量后再次 GC 并记录快照。
    const afterGc = await collectGarbage()
    // 汇总报告。
    return {
      scenario: this.scenario,
      totalMs,
      ...measured.phases === undefined ? {} : { phases: measured.phases },
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      events: measured.events,
      beforeGc,
      afterGc,
      retained: memoryDelta(beforeGc, afterGc),
    }
  }

  async dispose(): Promise<void> {
    // 中止历史订阅。
    this.historyAbort?.abort(new Error('Session opening benchmark complete'))
    // 结束历史迭代器。
    await this.historyIterator?.return?.()
    // 释放 Agent 句柄。
    await this.agentHandle?.dispose()
    // 释放会话准备对象。
    this.preparation?.[Symbol.dispose]()
    // 清空保留引用。
    this.retained = undefined
    // 销毁容器（等待全部后台任务结束）。
    await this.ctx.fiber.dispose()
  }

  private runScenario(): Promise<{
    readonly events: number
    readonly phases?: SessionOpenWorkerReport['phases']
  }> {
    // 按场景名分发到对应的测量函数。
    switch (this.scenario) {
      case 'phase-migrate':
      case 'phase-steady':
        // 阶段测量（迁移版或稳态版共用同一实现）。
        return this.measurePhases()
      case 'first-history':
        // 首次历史测量。
        return this.measureFirstHistory()
      case 'agent-resume':
        // Agent 恢复测量。
        return this.measureAgentResume()
    }
  }

  private async measurePhases(): Promise<{
    readonly events: number
    readonly phases: NonNullable<SessionOpenWorkerReport['phases']>
  }> {
    // 阶段计时起点。
    let phaseStarted = performance.now()
    // 阶段一：打开只读日志句柄。
    const handle = await this.ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
    // 打开阶段耗时。
    const openMs = performance.now() - phaseStarted
    // 重置阶段计时起点。
    phaseStarted = performance.now()
    // 阶段二：读取全部事件。
    const read = await handle.read()
    // 关闭句柄（计入读取阶段）。
    await handle.close()
    // 读取阶段耗时。
    const readMs = performance.now() - phaseStarted
    // 重置阶段计时起点。
    phaseStarted = performance.now()
    // 修补被中断轮次的闭合事件，构成与生产冷读一致的种子事件序列。
    const repaired = [...read.events, ...interruptedTurnClosers(read.events)]
    // 种子即修补后的事件序列。
    const seed = repaired
    // 阶段三：以种子事件与会话头创建会话准备（preparation）对象。
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(SessionId(SYNTHETIC_SESSION_ID), {
      seed,
      meta: structuredClone(handle.header),
      inheritedEventCount: handle.inheritedEventCount,
      eventState: read.eventState,
    }))
    // 保留准备对象供 GC 采样。
    this.preparation = preparation
    // 会话恢复阶段耗时。
    const sessionRestoreMs = performance.now() - phaseStarted
    // 重置阶段计时起点。
    phaseStarted = performance.now()
    // 阶段四：对准备好的会话从 0 偏移水合（hydrate）全部投影。
    const projection = this.ctx.sessionProjections.hydrate(
      preparation.session,
      {},
      seed,
      SessionLogOffset(0),
    )
    // 投影阶段耗时。
    const projectionMs = performance.now() - phaseStarted
    // 保留投影与种子，使其在最终 GC 采样时可达。
    this.retained = { preparation, projection, seed }
    // 返回事件数与四阶段耗时。
    return {
      events: preparation.session.seq,
      phases: { openMs, readMs, sessionRestoreMs, projectionMs },
    }
  }

  private async measureFirstHistory(): Promise<{ readonly events: number }> {
    // 创建可中止的订阅控制器。
    const abort = new AbortController()
    // 登记以便 dispose 时清理。
    this.historyAbort = abort
    // 历史控制器必须已初始化。
    const history = this.history
    // 缺失即内部错误。
    if (history === undefined) throw new Error('first-history benchmark did not initialize its controller')
    // 订阅该会话的历史流并取得异步迭代器。
    const iterator = history.follow({
      address: { kind: 'session', sessionId: SessionId(SYNTHETIC_SESSION_ID) },
    }, abort.signal)[Symbol.asyncIterator]()
    // 登记迭代器以便清理。
    this.historyIterator = iterator as AsyncIterator<unknown>
    // 等待第一条消息（应为全量快照）。
    const first = await iterator.next()
    // 第一条必须是快照，否则历史投递不符合预期。
    if (first.done || first.value.type !== 'snapshot') {
      throw new Error('Session history did not produce an opening snapshot')
    }
    // 保留历史流与快照供 GC 采样。
    this.retained = { history, iterator, first }
    // 返回快照中的记录数。
    return { events: first.value.records.length }
  }

  private async measureAgentResume(): Promise<{ readonly events: number }> {
    // 以基准模型恢复（resume）该会话的 Agent。
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(SYNTHETIC_SESSION_ID),
      agentOptions: { provider: 'bench', model: 'bench' },
    })
    // 登记句柄以便清理。
    this.agentHandle = handle
    // 保留句柄供 GC 采样。
    this.retained = handle
    // 返回恢复后会话的事件数。
    return { events: handle.agent.session.seq }
  }
}

// 断言以编译产物运行，且持久化包解析到生产 lib 构建。
assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-session-persistence-jsonl': import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),
})

// 解析命令行参数：数据根目录与场景名。
const [root, scenarioValue] = process.argv.slice(2)
// 全部合法场景列表。
const scenarios: readonly SessionOpenBenchmarkScenario[] = [
  'phase-migrate',
  'phase-steady',
  'first-history',
  'agent-resume',
]
// 根目录缺失或场景名不合法即报错。
if (root === undefined || !scenarios.includes(scenarioValue as SessionOpenBenchmarkScenario)) {
  throw new Error('usage: session-open.worker.js <root> <phase-migrate|phase-steady|first-history|agent-resume>')
}
// 确定本次场景。
const scenario = scenarioValue as SessionOpenBenchmarkScenario
// 创建被测宿主。
const host = await SessionBenchmarkHost.create(root, scenario)
// 声明报告变量，由下方测量赋值。
let report: SessionOpenWorkerReport
try {
  // 执行测量。
  report = await host.measure()
} finally {
  // 无论成败都清理宿主。
  await host.dispose()
}
// 把报告序列化为 JSON 行输出（父进程解析最后一行 JSON）。
process.stdout.write(`${JSON.stringify(report)}\n`)
