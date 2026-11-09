// 模块说明：agent-loop 插件的具体实现——它是整个 harness 的"发动机装配车间"：
// 按 cordis.yml 声明式配置或编程式调用，创建出挂在独立作用域上的 ReactLoopAgent
// （主循环驱动器，见 ./agent.ts），并经由 agents/sessions 两个注册表对外发布；
// 同时拥有这些智能体从创建（create）、恢复（resume）到有序拆除（teardown）的完整生命周期。
// 关键设计：
// 1. 失效熔断（abort 融合）：调用方取消信号、owner fiber 卸载、工厂拆除三条来源
//    都会汇入同一个 AbortController，任何一方触发都让初始化/恢复过程尽快放弃；
// 2. 失败不吞不漏：拆除时收集所有清理阶段的失败并聚合抛出（AggregateError），
//    保证每个竞争等待者都能观察到同一个结果；
// 3. 持久化优先：挂载了 session-persistence 后端时，会话种子与增量事件先落盘再发布，
//    崩溃恢复通过"写入合成收尾事件"（interruptedTurnClosers）完成语义修复。
/**
 * Concrete agent-loop plugin: creates scoped ReactLoopAgents, publishes them
 * through the agent/session registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */
// Volatile 类型：cosmokit 提供的"易变值"包装，用于会随时间变化的配置项。
import type { Volatile } from '@deepseek-ai/cosmokit'

// cordis 核心三件套：Context（依赖注入上下文）、FiberState（fiber 生命周期状态）、Service（服务基类）。
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
// randomUUID：为新建会话生成随机的组合 id 后缀。
import { randomUUID } from 'node:crypto'
// schemastery 的 z：声明 AgentLoop 的运行时配置 schema。
import z from '@deepseek-ai/schemastery'
// brandString：把普通字符串收窄为品牌类型（如 SessionId）。
import { brandString } from '@deepseek-ai/dsh-brand'
// dsh-agent 包的类型：智能体、工厂、句柄、选项、装配（setup）、创建/恢复选项、
// 会话启动来源、模型选择及其投影状态、收件箱状态。
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxState,
} from '@deepseek-ai/dsh-agent'
// 模型选择投影定义：把每个会话当前的 provider/model/reasoningEffort 投影给客户端订阅。
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
// errorChain：把错误链压成一行可读文本；ReasoningEffortId：推理力度的品牌类型。
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// 会话侧原语：为被打断的末轮合成收尾事件、日志偏移品牌、会话准备器（创建会话并保证失败回滚）。
import { interruptedTurnClosers, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
// 会话核心类型：会话对象、头部元数据、会话 id。
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
// 副作用导入：引入 system-prompt 与 tools 包的类型环境（扩展 Context 接口）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
// ProjectionHandle：会话投影注册后返回的操作句柄（可按会话读取）。
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
// 会话持久化：后端缺失错误与句柄/后端接口类型。
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// ReactLoopAgent：本包的核心驱动器类（agent.ts），负责真正跑主循环。
import { ReactLoopAgent } from './agent.ts'
// 收件箱投影定义：把每个会话的待处理输入状态投影给客户端。
import { inboxProjectionDefinition } from './inbox.ts'
// 默认的每步最大并行工具调用数常量。
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'
// 副作用导入：引入 runtime-context 的模块扩充（运行期上下文类型）。
import type {} from './runtime-context.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
// 已失活的 fiber 状态集合：处于这些状态的工厂不能再创建/服务任何新生命周期。
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  // 正在卸载。
  FiberState.UNLOADING,
  // 已被释放。
  FiberState.DISPOSED,
  // 已失败。
  FiberState.FAILED,
])

/** Re-throw one collected failure as itself, or several as one `AggregateError`. */
// 重新抛出收集到的失败：单个失败原样抛出（保留原始栈），多个则聚合为一个 AggregateError。
function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  // 只有一个失败：直接抛出原始错误，避免无谓的包装。
  if (failures.length === 1) throw failures[0]
  // 多个失败：聚合抛出，附上说明消息。
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/** Factory-level ownership: live agent teardowns plus config startup work. */
// 工厂级所有权：跟踪所有存活智能体的拆除闭包与配置驱动的启动任务，
// 是整个 agent-loop 生命周期归属的"总账本"。
class FactoryOwnership {
  // 是否还在接受新智能体；dispose 后置 false。
  private accepting = true
  // 工厂拆除的中断控制器：一旦触发，所有挂靠其上的操作都会收到 abort。
  private readonly teardown = new AbortController()
  // 手动解析的 promise：工厂拆除开始即 resolve，用于让等待者提前退出。
  private readonly inactive = Promise.withResolvers<void>()
  // 存活智能体的共享拆除闭包集合；拆除完成后会自行移除。
  private readonly liveAgents = new Set<() => Promise<void>>()
  // 配置驱动的启动任务集合（如首个声明式智能体的创建/恢复）。
  private startupTasks = new Set<Promise<void>>()

  // 构造：记录工厂所在的 fiber，用于判断其生命周期状态。
  constructor(private readonly fiber: Context['fiber']) {}

  /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
  // 工厂拆除信号：拆除开始时以 `agent loop is not active` 错误为原因触发 abort。
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  // 工厂是否处于活跃状态：仍在接受新智能体且 fiber 未失活。
  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /** Track one live agent's shared teardown until it has run. */
  // 跟踪一个存活智能体的共享拆除闭包，直到它真正执行完；返回取消跟踪的函数。
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** Join config startup work that begins before an agent exists. */
  // 跟踪"智能体尚不存在"就已开始的配置启动工作，工厂拆除时会等它结束。
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    // 任务结束后从集合中移除（无论成败），避免集合无限增长。
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /** Join one public create/resume continuation; factory dispose awaits its settlement. */
  // 跟踪一次公开的 create/resume 调用 promise；工厂拆除会等它落定。
  trackWrapper(job: Promise<unknown>): void {
    // 吞掉结果只保留落定时机，让工厂拆除不因调用者的错误处理而分叉。
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  /** Resolve `task`, or stop waiting when factory teardown begins. */
  // 等待 task 完成，或工厂拆除开始时提前返回（用 inactive promise 竞速）。
  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  // 工厂拆除：停止接受新智能体、触发 abort 信号、释放等待者，
  // 然后等所有存活智能体与启动任务落定；失败聚合抛出，绝不静默。
  async dispose(): Promise<void> {
    // 先停止接受新智能体。
    this.accepting = false
    // 触发拆除信号：所有挂靠其上的操作立即收到 abort。
    this.teardown.abort(new Error('agent loop is not active'))
    // 释放所有 waitWhileActive 的等待者。
    this.inactive.resolve()
    // 并行等待所有智能体拆除与启动任务完成，收集各自结果。
    const settlements = await Promise.allSettled([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
    // 挑出所有被拒绝的结果。
    const failures: unknown[] = []
    for (const result of settlements) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    // 聚合抛出所有失败，保证拆除失败对调用者可见。
    throwCollectedFailures(failures, 'agent loop disposal failed')
  }
}

/** Await `operation`, or throw the signal's reason as soon as it aborts. */
// await operation 完成；一旦 signal 触发 abort，立即抛出中断原因，不再等操作结果。
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  // 把 abort 原因规整为 Error：本身是 Error 就直接用，否则包装一层并挂为 cause。
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  // 已经处于 aborted 状态：无需等待，直接抛出。
  if (signal.aborted) throw toAbortError()
  // 手动 reject 的 promise：作为 abort 事件到竞速结果的桥梁。
  const aborted = Promise.withResolvers<never>()
  // abort 事件监听器：把 aborted promise 拒绝为规整后的错误。
  const listener = (): void => { aborted.reject(toAbortError()) }
  // 注册一次性监听器。
  signal.addEventListener('abort', listener, { once: true })
  try {
    // 操作结果与 abort 竞速：谁先落定用谁。
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    // 无论结果如何都要移除监听器，避免泄漏。
    signal.removeEventListener('abort', listener)
  }
}

/** Start an abortable operation and release a value that arrives after cancellation. */
// 启动一个可中断操作；若取消发生在结果产生之后，用 releaseAbandoned 释放迟到的值（如关闭句柄）。
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  // 调用前已 abort：直接抛出规整后的中断原因。
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  // 先把 operation 包成 promise，确保它启动后也能参与竞速。
  const pending = Promise.resolve().then(operation)
  try {
    // 与 abort 信号竞速等待结果。
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the operation is awaited.
    // 若等待期间信号触发了 abort，且调用方提供了迟到值释放钩子，则异步释放该值。
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    // 原样抛出错误（中断错误或操作自身的失败）。
    throw error
  }
}

/** Reject an output-token cap that cannot be represented exactly on the request wire. */
// 校验智能体选项：输出 token 上限必须是能精确上送请求线的正安全整数。
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** One session's owned write handle plus the count of events already stored through it. */
// 一个会话独占的写句柄，以及通过它已经落盘的事件计数（存储游标）。
interface StoredSession {
  // 持久化后端返回的写句柄。
  readonly handle: SessionHandle
  // 已写入后端的事件数，用于计算待落盘的后缀。
  storedCount: number
}

/** Acquired Session resources and composition inputs for one Agent initialization. */
// 一次 Agent 初始化所需的已获取会话资源与组合输入。
interface AgentInitializationOptions {
  // 已准备的会话对象。
  readonly session: Session
  // 主循环选项（模型路由、并行度等）。
  readonly agentOptions: AgentOptions
  // 会话启动来源（startup/resume 等），供注册表记录。
  readonly source: SessionStartSource
  // 挂载了持久化时的独占写句柄与存储游标（可选）。
  readonly stored?: StoredSession | undefined
  // 调用方提供的装配钩子（在发布前对智能体做一次性配置）。
  readonly setup?: AgentSetup | undefined
  // 调用方的取消信号。
  readonly signal?: AbortSignal | undefined
}

// 模块扩充：为 cordis 的 Context 声明 agentLoop 服务与启动器身份注入点。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // agentLoop 服务实例：本文件定义的 AgentLoop。
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config `id` and set with `ctx.provide()` before any Loader
     * entry mounts (see {@link CONFIGURED_AGENT_IDENTITIES_KEY}). A launcher
     * owns identity because only it knows whether the session already exists,
     * while the `cordis.yml` row keeps the model route as ordinary patchable
     * config. An entry with no matching key keeps its configured identity.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * Consumers that buffer work for the configured identity use this
     * transient signal to reject that work instead of waiting forever. Normal
     * factory teardown suppresses failures from the cancelled startup attempt.
     * @param payload.sessionId - exact shared agent/session identity that failed startup.
     * @param payload.error - persistence, setup, or publication failure.
     * @mode emit
     */
    // 声明式智能体条目在发布存活智能体之前失败的事件。
    // 为该配置身份缓冲工作的消费者借此即时拒绝工作，而不是无限等待；
    // 正常工厂拆除会抑制已取消启动尝试的失败。
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

// 原样转发默认并行度常量，供外部配置引用。
export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/**
 * One launcher-selected session identity for a configured agent. `resume`
 * distinguishes rehydrating existing persisted history from creating the
 * session fresh under that exact id, which the two config keys express as
 * `resumeSessionId` and `sessionId`.
 */
// 启动器为某个配置智能体选定的会话身份：resume 区分"回灌既有持久历史"
// 与"以该精确 id 全新建会话"，对应配置里的 resumeSessionId 与 sessionId 两个键。
export interface LauncherAgentIdentity {
  /** Exact session id to create fresh or resume. */
  // 要全新创建或恢复的精确会话 id。
  id: SessionId
  /** Resume existing persisted history instead of creating the session fresh. */
  // 恢复既有持久历史而不是全新创建会话。
  resume: boolean
}

/** Launcher-selected identities keyed by the configured agent's `id`. */
// 以配置智能体的 `id` 为键的启动器身份表（只读）。
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`) to fix
 * configured agents' session identities without a config key, so an overlay
 * repointing the row's model route cannot drop them.
 */
// 启动器在任何 Loader 条目挂载前设置的身份注入键：用 ctx.provide 提供身份表，
// 无需配置键即可固定配置智能体的会话身份，避免覆盖层改写模型路由时丢失身份。
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * Apply launcher-owned identities over the configured agents, replacing both
 * identity keys for every entry the launcher named so a config-supplied
 * identity can never survive alongside a launcher-supplied one.
 * @param agents - the configured agent entries.
 * @param identities - launcher identities keyed by configured agent `id`, or `undefined`.
 * @returns the entries with launcher-owned identities applied.
 */
// 把启动器持有的身份套用到配置智能体上：对启动器点名的每个条目同时替换两个身份键，
// 保证配置提供的身份绝不可能与启动器提供的身份并存。
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  // 启动器未提供身份：配置原样返回。
  if (identities === undefined) return agents
  // 逐个条目应用启动器身份。
  return agents.map((agent) => {
    // 按配置 id 查找启动器身份；未点名则保持原样。
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    // 剥掉配置里两个身份键（sessionId 与 resumeSessionId），保留其余字段。
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    // resume 模式写入 resumeSessionId，否则写入 sessionId。
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Agent-loop plugin configuration. */
// agent-loop 插件的配置接口。
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  // 每个智能体步骤允许在途的最大并行安全调用数；`1` 即串行；缺省取默认常量。
  maxParallelToolCalls: Volatile<number>
  /** Agents created or resumed at plugin startup; a resumed agent records its configured route as the Session's model selection. */
  // 插件启动时创建或恢复的智能体列表；恢复的智能体会把配置路由记为会话的模型选择。
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    // 稳定的配置标签：用于日志，也作为新建组合 id 的前缀。
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    // 可选的稳定身份：重新挂载时恢复其已物化历史，首次使用则全新创建。
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    // 新建会话可选的工作目录。
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    // 指定恢复的持久会话 id，代替全新创建。
    resumeSessionId?: SessionId
  })[]
}

/** Reject self-contained identity conflicts before any configured agent starts. */
// 在任何配置智能体启动之前，拒绝配置自身的身份冲突（互斥键、重复精确身份）。
function validateConfiguredAgents(agents: Config['agents']): void {
  // 精确身份到首个占用它的配置 id 的映射。
  const exactIdentities = new Map<SessionId, string>()
  // 遍历每个配置条目做两类校验。
  for (const { id, sessionId, resumeSessionId } of agents) {
    // resumeSessionId 是否有效（存在且非空字符串）。
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    // 两个身份键互斥：同时给出直接报错。
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    // 取生效的精确身份（resume 优先，否则全新创建身份）。
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    // 未固定身份的条目：跳过重复检查。
    if (exactIdentity === undefined) continue
    // 同一精确身份被两个条目占用：报重复错误。
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    // 记录占用关系。
    exactIdentities.set(exactIdentity, id)
  }
}

/** Concrete agent factory and driver service. */
// 具体的智能体工厂兼驱动服务：实现 AgentFactory 接口，是 agentLoop 服务的本体。
export class AgentLoop extends Service implements AgentFactory {
  // 声明依赖的服务：智能体注册表、会话注册表、LLM、工具、系统提示词、会话投影。
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** Runtime schema for declarative agents. */
  // 声明式智能体的运行时 schema：校验 cordis.yml 里的 agents 数组与并行度配置。
  static Config: z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config> = z.object({
    // 并行度：正整数，缺省取默认常量，标记为 volatile（运行期可变）。
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
    // agents 数组：每个条目的字段约束。
    agents: z.array(z.object({
      // 配置标签：必填。
      id: z.string().required(),
      // 稳定会话身份：非空字符串（可选）。
      sessionId: z.string().min(1),
      // 模型提供方（可选）。
      provider: z.string(),
      // 模型名（可选）。
      model: z.string(),
      // 推理力度（可选，收窄为品牌类型）。
      reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
      // 输出 token 上限：1 到安全整数上限。
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      // 新建会话的工作目录（可选）。
      cwd: z.string(),
      // 恢复用的持久会话 id（可选）。
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config>

  /** Validated configuration owned by the agent-loop service. */
  // 经校验且归本服务所有的配置。
  readonly config: Config
  // 工厂级所有权账本：跟踪存活智能体与启动任务。
  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  // 普通对象持有 ctx：防止 Cordis 把工厂的依赖上下文沿调用者影子重新追踪。
  private readonly runtime: { ctx: Context }
  // 模型选择投影句柄（init 后赋值）。
  private modelProjectionHandle!: ProjectionHandle<ModelSelectionProjectionState>
  // 收件箱投影句柄（init 后赋值）。
  private inboxProjectionHandle!: ProjectionHandle<InboxState>

  // 构造：应用启动器身份、校验配置、建立所有权账本。
  constructor(ctx: Context, config: Config) {
    // 以 'agentLoop' 为名注册服务。
    super(ctx, 'agentLoop')

    // 组装最终配置：套用启动器身份表（若提供）。
    this.config = {
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      maxParallelToolCalls: config.maxParallelToolCalls,
    }
    // 在任何智能体启动前拒绝自相矛盾的身份配置。
    validateConfiguredAgents(this.config.agents)
    // 建立工厂级所有权账本。
    this.ownership = new FactoryOwnership(ctx.fiber)
    // 用普通对象包住 ctx，阻断 Cordis 的依赖追踪。
    this.runtime = { ctx }
  }

  protected async [Service.init](): Promise<void> {
    // 取普通对象里的 ctx，避免依赖追踪。
    const ctx = this.runtime.ctx
    // 就地引用所有权账本。
    const ownership = this.ownership
    // Agent projections remain readable until teardown finishes.
    // 注册服务拆除副作用：拆卸时执行 ownership.dispose（投影在拆除完成前仍可读）。
    ctx.effect(() => () => ownership.dispose(), 'agentLoop.transactions()')
    // 注册模型选择投影：把每个会话的路由状态暴露给客户端订阅。
    this.modelProjectionHandle = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
    // 注册收件箱投影：把每个会话的待处理输入状态暴露给客户端。
    this.inboxProjectionHandle = await ctx.sessionProjections.register(inboxProjectionDefinition)
    // 把自己设为全局智能体工厂；拆卸时自动还原。
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    // 暴露系统提示词变量 provider：优先取会话当前模型选择，回退到智能体配置。
    ctx.systemPrompt.variable('provider', context => context.modelSelection?.provider ?? context.agent?.options.provider)
    // 暴露系统提示词变量 model：同上。
    ctx.systemPrompt.variable('model', context => context.modelSelection?.model ?? context.agent?.options.model)

    // 逐个启动配置声明的智能体：全新创建（可带稳定身份）或恢复持久会话。
    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      // 组装会话头部元数据：仅工作目录（可选）。
      const meta = cwd === undefined ? {} : { cwd }
      // 分支一：全新创建（未配置 resumeSessionId）。
      if (resumeSessionId === undefined || resumeSessionId === '') {
        // 计算精确身份：配置给了 sessionId 就用它，否则生成 `<id>-session-<uuid>` 组合 id。
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        // 固定了身份才需要持久化后端（匿名智能体无需落盘）。
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        if (persistence === undefined) {
          // 无持久化：直接创建；失败上报给身份绑定的消费者。
          const startup = this.create(configuredId, options, meta).then(() => undefined, (error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          // 纳入工厂所有权账本，拆除时等待其落定。
          this.ownership.trackStartup(startup)
        } else {
          // 有持久化：先尝试恢复已物化历史，缺失时再全新创建。
          const startup = this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        }
        // 该条目处理完毕，进入下一个。
        continue
      }
      // 分支二：恢复持久会话。用副作用包裹，拆卸时释放注入的子 fiber。
      ctx.effect(() => {
        // 注入 sessionPersistence 服务得到子 fiber，在子上下文里执行恢复。
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void this.resumeWith(ctx, childCtx.sessionPersistence, {
            resumeSessionId,
            agentOptions: options,
            // 装配钩子：把配置里的模型路由应用到恢复出的智能体上。
            setup: (_agentCtx, agent) => { this.applyConfiguredRoute(agent, options) },
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        // 返回拆卸函数：卸载时释放子 fiber。
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  // 把配置里的模型路由应用到智能体上（恢复场景），尽量保留既有推理力度。
  private applyConfiguredRoute(agent: Agent, options: AgentOptions): void {
    // 解构配置里的模型路由三要素。
    const { provider, model, reasoningEffort } = options
    // provider/model 缺一不可：没有就不改路由。
    if (!provider || !model) return
    // 记下智能体当前的模型选择。
    const previous = agent.model.current()
    // 组装新的模型选择（推理力度可选）。
    const selection: ModelSelection = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    // 配置未给推理力度且旧选择同路由时：沿用旧的推理力度，避免恢复后降级。
    if (selection.reasoningEffort === undefined && previous !== undefined
      && previous.provider === selection.provider && previous.model === selection.model
      && previous.reasoningEffort !== undefined) {
      selection.reasoningEffort = previous.reasoningEffort
    }
    // 应用新的模型选择。
    agent.model.select(selection)
  }

  /** Report a contained declarative-start failure to identity-bound consumers. */
  // 上报一次被容住的声明式启动失败：记日志并向绑定该身份的消费者派发事件。
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    // 工厂已失活（如正在拆除）：静默返回，抑制已取消启动尝试的失败。
    if (!this.ownership.isActive()) return
    // 记录带错误链的告警日志。
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    // 组装事件参数：事件名 + 载荷。
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    // 以 emit 模式派发事件并遍历所有监听器。
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        // 调用监听器；返回值可能是 promise。
        const returned: unknown = callback(...args)
        // 异步拒绝也要兜住并告警，不让监听器错误冒泡成未处理拒绝。
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        // 同步抛错同样只告警，不影响其他监听器。
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** Restore a materialized exact config identity on remount, or create it on first use. */
  // 重新挂载时恢复已物化的精确配置身份；首次使用（存储缺失）则全新创建。
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    persistence: SessionPersistence,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    // 先等同 id 的旧生命周期完成注册表拆除，避免复活竞争。
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    // 等待期间工厂失活：放弃本次启动。
    if (!this.ownership.isActive()) return
    try {
      // 首选恢复：以精确身份打开持久会话。
      await this.resumeWith(ownerCtx, persistence, {
        resumeSessionId: sessionId,
        agentOptions,
        // 装配钩子：应用配置的模型路由。
        setup: (_agentCtx, agent) => { this.applyConfiguredRoute(agent, agentOptions) },
      })
      // 恢复成功：结束。
      return
    } catch (error: unknown) {
      // 等待期间工厂失活：放弃。
      if (!this.ownership.isActive()) return
      // Only a genuinely absent stored session falls back to first creation;
      // corruption, ownership conflicts, and backend failures stay loud.
      // 只有"存储会话确实不存在"才回退到首次创建；
      // 损坏、所有权冲突、后端故障必须保持响亮报错。
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
    // 回退路径：全新创建该身份的会话与智能体。
    await this.create(sessionId, agentOptions, meta)
  }

  /** Wait for a draining same-id lifecycle to finish registry teardown. */
  // 等待同 id 的旧生命周期完成注册表拆除（draining），再继续启动。
  private async waitForDrainingConfiguredIdentity(ownerCtx: Context, sessionId: SessionId): Promise<void> {
    // Only an id still occupying a registry needs waiting for; a live healthy
    // occupant is a collision the create/resume below will surface itself.
    // 只有仍占据注册表的 id 才需要等待；健康存活者造成的冲突
    // 会让下方 create/resume 自行暴露，这里不必关心。
    if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) return

    // 手动解析的 promise：身份释放即 resolve。
    const released = Promise.withResolvers<void>()
    // 检查函数：两个注册表都不再有该 id 时释放等待者。
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) {
        released.resolve()
      }
    }
    // 订阅智能体销毁事件（回调里再检查）。
    const disposeAgentListener = ownerCtx.on('agent/disposed', () => { checkReleased() })
    // 订阅会话销毁事件。
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      // 先同步检查一次（可能已经释放）。
      checkReleased()
      // 等待释放，或工厂拆除开始时提前返回。
      await this.ownership.waitWhileActive(released.promise)
    } finally {
      // 无论结果都要退订两个事件。
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /**
   * Own initialization and teardown from an acquired Session to a published Agent.
   * Registers factory teardown and caller cancellation before constructing the scope.
   * Failed initialization drains cleanup while retaining stored events and inbox input.
   * @param ownerCtx - caller context that owns the Agent lifecycle.
   * @param options - acquired Session/write handle, loop options, start source, setup, and cancellation.
   * @returns the initialized Agent and its shared disposer.
   */
  private async initializeAgent(
    ownerCtx: Context,
    options: AgentInitializationOptions,
  ): Promise<AgentHandle> {
    // 解构初始化输入：会话、循环选项、启动来源、写句柄、装配钩子、取消信号。
    const { session, agentOptions, source, stored, setup, signal: callerSignal } = options
    // 会话 id 即智能体 id（共享身份）。
    const id = session.id
    // 普通对象里的工厂上下文。
    const loopCtx = this.runtime.ctx

    // Deactivation fuses three owners, each with its own reason: the caller's
    // cancellation signal, the owner fiber's unload, and factory teardown.
    // It is registered BEFORE any resource exists, over mutable slots, so an
    // unload arriving while the scope is still minting finds a working
    // disposer instead of a leak.
    // 失活信号融合三个所有者，各带自己的原因：调用方取消信号、owner fiber 卸载、工厂拆除。
    // 它在任何资源存在之前、基于可变槽位注册——这样作用域还在铸造途中到来的卸载
    // 也能找到可用的拆除器，而不是泄漏。
    const abort = new AbortController()
    // 调用方信号触发时的回调：把原因规整为 Error 后融进 abort。
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    // 工厂拆除触发时的回调：直接转发工厂的 abort 原因。
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    // 注册调用方取消监听（一次性）。
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    // 注册工厂拆除监听（一次性）。
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    // 智能体驱动器（作用域内逐步赋值，中途可能仍为空）。
    let machine: ReactLoopAgent | undefined
    // 会话注册表的注销闭包。
    let detachSession: (() => void) | undefined
    // 智能体注册表的注销闭包。
    let detachAgent: (() => void) | undefined
    // 记忆化的拆除 promise：保证多个竞争所有者共用一次拆除。
    let disposing: Promise<void> | undefined
    // 发布栅栏：装配完成后 resolve，拆除必须等它（避免拆掉装配到一半的智能体）。
    let publication: ReturnType<typeof Promise.withResolvers<void>> | undefined
    // 智能体是否已进入"就绪"状态（决定拆除时是否保留收件箱输入）。
    let ready = false
    // 驱动器构造完成的栅栏：拆除在 machine 槽位尚未填充时需要等它。
    const machineReady = Promise.withResolvers<void>()
    // Reverse teardown, memoized so every racing owner awaits one quiescence:
    // stop the machine, unwind the scope, drain and close the session's write
    // path, leave the registries, release bookkeeping.
    // 逆序拆除并记忆化，让每个竞争所有者都等待同一个静止点：
    // 停机 -> 退绕作用域 -> 排空并关闭会话写路径 -> 退出注册表 -> 释放簿记。
    const teardown = (): Promise<void> => (disposing ??= (async () => {
      // 先触发本生命周期的 abort：原因区分工厂是否仍活跃。
      abort.abort(new Error(this.ownership.isActive()
        ? `agent "${id}" lifecycle disposed`
        : 'agent loop is not active'))
      // 移除两个 abort 来源监听器。
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      // Teardown failures are collected, never swallowed: registry, scope,
      // and ownership cleanup always run to quiescence, then the memoized
      // disposal rejects with what failed so every racing owner observes it.
      // 拆除失败被收集、绝不吞掉：注册表、作用域、所有权清理总会跑到静止，
      // 然后记忆化的拆掷以失败集合拒绝，让每个竞争所有者都观察到。
      const failures: unknown[] = []
      try {
        // Creation listeners retain the session and scope through their awaits.
        // 创建监听器在其 await 期间仍持有会话与作用域：先等发布栅栏落定。
        if (publication !== undefined) await publication.promise
        // Disposal IS a disposed-cause cancel followed by quiescence. New work
        // sent after this point is the sender's bug — the registries are about
        // to drop the agent, so nothing should still hold it.
        // 拆除即"以 disposed 为因的取消 + 等静止"。此后新送入的工作是发送方的错误——
        // 注册表即将丢弃该智能体，不应再有人持有它。
        /* v8 ignore next -- Cordis effect teardown waits for synchronous setup before observing the machine slot. */
        // 驱动器槽位尚未填充：等构造栅栏（构造是同步 effect 内完成的）。
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- setup failure untracks this disposer before resolving without a machine. */
        // 驱动器存在：以 disposed 取消主循环（未就绪则保留收件箱），等它完全空闲。
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' }, { keepInbox: !ready })
          await machine.whenIdle()
        }
      } catch (error: unknown) {
        // 阶段一失败：收集后继续，不让后续清理跳过。
        failures.push(error)
      }
      try {
        // 阶段二：退绕智能体作用域。
        await machine?.scope.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
      // Close drains events already routed into the handle. The backend's
      // live-event listeners must stay mounted through driver shutdown to
      // receive all closing events. A failed final drain is retained here
      // rather than logged away.
      // 关闭句柄会排空已路由进来的事件。后端的活事件监听器必须挂到驱动器
      // 关闭全程，才能收到所有收尾事件。最终排空失败在此保留而非一笔带过。
      try {
        await stored?.handle.close()
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        // 阶段四：退出两个注册表。
        detachAgent?.()
        detachSession?.()
      } finally {
        // 无论成败都要取消所有权跟踪。
        untrack()
      }
      // 聚合抛出收集到的失败。
      throwCollectedFailures(failures, `agent "${id}" disposal failed`)
    })())
    // 作用域级联注销闭包（跟随工厂 fiber 状态而定）。
    let unfollowScope: (() => Promise<void> | void) | undefined
    // 所有者 effect 的注销闭包。
    let unfollowOwner: () => Promise<void> | void
    // 对外暴露的共享拆除器：先跑拆除，再解除两个 effect 跟随。
    const dispose = async (): Promise<void> => {
      try {
        await teardown()
      } finally {
        await Promise.all([unfollowOwner(), unfollowScope?.()])
      }
    }
    // 把拆除器登记到工厂账本；返回取消登记的函数。
    const untrack = this.ownership.track(dispose)
    try {
      // 校验循环选项（maxTokens 合法性）。
      assertAgentOptions(agentOptions)
      // 断言调用者 fiber 仍活跃。
      ownerCtx.fiber.assertActive()
      // Factory dispatch and resume's load barrier already require a live owner.
      // 工厂分发与恢复的加载屏障都已要求所有者存活；这里是兜底断言。
      /* v8 ignore next -- unreachable backstop for factory ownership */
      if (!this.ownership.isActive()) throw new Error('agent loop is not active')
      // 调用方已取消：抛出规整后的原因，不做任何资源创建。
      if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
      }
      // 查询会话上一轮的轮次边界（用于恢复循环的续点）。
      const lastTurn = loopCtx.agents.turnBoundaryOf(session).lastTurn
      // 组装两个投影的按会话读取器。
      const projections = {
        modelSelection: this.modelProjectionHandle.readerFor(session),
        inbox: this.inboxProjectionHandle.readerFor(session),
      }
      // 在所有者 fiber 上登记生命周期 effect：同步构造驱动器，再挂拆卸逻辑。
      unfollowOwner = ownerCtx.effect(function* () {
        // 构造 ReactLoopAgent 驱动器并填入 machine 槽位。
        const created = machine = new ReactLoopAgent(
          loopCtx, id, agentOptions, session,
          projections,
          lastTurn,
        )
        // 解除"machine 未就绪"栅栏。
        machineReady.resolve()
        // Adopt the scope on its original fiber so it cannot unload before teardown.
        // A loop already unloading during minting owns the provisional scope itself.
        // 把作用域收养到原始 fiber 上，保证它不会先于拆除被卸载；
        // 若循环在铸造途中已在卸载，临时作用域由循环自己负责。
        if (!INACTIVE_STATES.has(loopCtx.fiber.state)) {
          // 作用域 effect：先裸卸载作用域，再跑共享拆除器。
          unfollowScope = loopCtx.effect(function* () {
            yield created.scope.rawDispose
            yield () => teardown()
          }, `agentLoop.scope(${id})`)
        }
        // 所有者卸载时的清理：abort 信号 + 共享拆除 + 解除作用域跟随。
        yield async () => {
          abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
          try {
            await teardown()
          } finally {
            await unfollowScope?.()
          }
        }
      }, `agentLoop.lifecycle(${id})`)
    } catch (error: unknown) {
      // 早期失败路径：解除栅栏、取消跟踪与监听、释放已获取的句柄，然后原样抛出。
      machineReady.resolve()
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      await stored?.handle.close().catch((_closeError: unknown) => {
        // Initialization failure remains primary when releasing the acquired handle fails.
        // 释放句柄再失败也只吞掉：初始化失败才是主要错误。
      })
      throw error
    }

    // 存活断言：abort 已触发就抛出融合后的原因。
    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      // Every fused abort source carries an Error reason: onCallerAbort and
      // raceAbort wrap non-Error caller reasons, and the factory/lifecycle
      // owners abort with constructed Errors.
      // 每个融合来源都带 Error 原因：onCallerAbort 与 raceAbort 会包装非 Error，
      // 工厂/生命周期所有者则以构造的 Error 触发。
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
    }
    try {
      /* v8 ignore next -- a synchronous effect exhausts the generator before returning */
      // effect 是同步的，machine 此时应已填充；缺失说明生命周期没构造出驱动器。
      if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)
      // 就地别名。
      const agent = machine
      // 断言未被 abort。
      assertLive()

      // 在主循环的维护窗口内完成发布序列（暂停新轮次，避免竞争）。
      return await agent.runMaintenance(async () => {
        // 竖起发布栅栏：拆除需等本序列落定。
        publication = Promise.withResolvers<void>()
        try {
          // 每个关键步骤之间都检查存活。
          assertLive()
          // 把上次存储游标之后累积的会话事件先落盘。
          await this.appendUnstoredSuffix(stored, session)
          assertLive()
          // 进入会话注册表并广播新会话。
          detachSession = agent.ctx.sessions.enter(session)
          agent.ctx.sessions.announce(session)
          assertLive()
          // 在可中断窗口内执行调用方的装配钩子。
          const setupCommit = await raceAbort(setup?.(agent.ctx, agent), abort.signal, id)
          assertLive()
          // 提交装配钩子的修改（若有）。
          setupCommit?.commit()
          assertLive()
          // The mounted backend routes announced live events into the active
          // write handle by session id; the loop only owns the handle itself.
          // 挂载的持久化后端按会话 id 把广播出的活事件路由进活跃写句柄；
          // 主循环本身只负责持有句柄。
          detachAgent = loopCtx.agents.enter(agent)
          await loopCtx.agents.announce(agent, source, abort.signal)
          assertLive()
          // 标记就绪：此后拆除不再保留收件箱输入。
          ready = true
          // 发布完成：返回智能体与其共享拆除器。
          return { agent, dispose }
        } catch (error: unknown) {
          // Failed initialization must not release queued input into a new turn.
          // 初始化失败绝不能把排队输入放进新一轮：以 disposed 取消但保留收件箱。
          agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        } finally {
          // 无论成败都放下发布栅栏，避免拆除者永久等待。
          publication.resolve()
          publication = undefined
        }
      })
    } catch (error: unknown) {
      // 发布阶段失败：跑完整拆除并吞掉拆除自身的错误（初始化失败为主）。
      await dispose().catch((_disposeError: unknown) => {
        // Initialization failure remains primary after cleanup reaches quiescence.
      })
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber. Constructor-driven config calls mint a fresh combined
   * id before entering this boundary. When a persistence backend is mounted,
   * the session's durable identity and any seed are stored before publication.
   * @param id - shared agent/session identity.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published running agent.
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    // 准备会话（using 确保失败时自动释放准备资源）。
    using preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, { meta }))
    // 挂载持久化时先取写句柄（把种子落盘）。
    const stored = await this.createStoredSession(preparation.session)
    // 进入初始化与发布流程，返回发布的智能体。
    return (await this.initializeAgent(this.ctx, {
      session: preparation.session,
      stored,
      agentOptions: options,
      source: 'startup',
    })).agent
  }

  /**
   * Take a fresh session's write ownership when persistence is mounted.
   * The constructor seed is stored before Session store entry. Setup then
   * appends through the live event feed; creation failure retains any events
   * already written to the handle.
   * @param session - the unpublished session to store.
   * @param signal - optional cancellation forwarded to the backend create.
   * @returns the owned handle and stored cursor, or `undefined` without a backend.
   */
  private async createStoredSession(session: Session, signal?: AbortSignal): Promise<StoredSession | undefined> {
    // 取当前挂载的持久化后端。
    const persistence = this.runtime.ctx.get('sessionPersistence')
    // 未挂载：无需存储，返回 undefined。
    if (persistence === undefined) return undefined
    // 在后端创建会话存储：写入头部（含继承事件计数），可转发取消信号。
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    // 返回独占写句柄，存储游标从 0 开始。
    return { handle, storedCount: 0 }
  }

  /**
   * Durably store the session events appended since the last stored cursor.
   * @param stored - the session's owned handle and stored cursor, if any.
   * @param session - the unpublished session whose suffix is stored.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    // 无写句柄（未挂载持久化）：无事可做。
    if (stored === undefined) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    // 从已存储游标处快照出尚未落盘的事件后缀。
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    // 后缀非空才追加写入。
    if (suffix.length > 0) await stored.handle.append(suffix)
    // 推进存储游标。
    stored.storedCount += suffix.length
  }

  /**
   * Create an owned agent on a caller-supplied session id.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // 准备会话：可带种子事件、元数据与继承事件计数。
    const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    // 发布 promise：工厂拆除需等它落定。
    const published = (async () => {
      // using 确保任何路径退出都释放准备资源。
      using ownedPreparation = preparation
      // raceAbortCall closes a handle that finishes creating after cancellation.
      // raceAbortCall 负责关闭"取消之后才创建完成"的句柄。
      const stored = options.signal === undefined
        // 无取消信号：直接创建存储。
        ? await this.createStoredSession(ownedPreparation.session)
        // 有取消信号：与中断竞速，迟到句柄由释放钩子关闭。
        : await raceAbortCall(
          () => this.createStoredSession(ownedPreparation.session, options.signal),
          options.signal,
          options.sessionId,
          (abandoned) => { void abandoned?.handle.close().catch(() => {}) },
        )
      // 进入初始化与发布流程。
      return await this.initializeAgent(ownerCtx, {
        session: ownedPreparation.session,
        stored,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        source: 'startup',
      })
    })()
    // 纳入工厂账本。
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // 取当前挂载的持久化后端。
    const persistence = this.runtime.ctx.get('sessionPersistence')
    // 没有后端就无法恢复：显式报错并提示加载后端。
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    // 委托给内部恢复流程。
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** Resume through an explicit persistence handle used by the deferred config path. */
  // 通过显式给出的持久化后端执行恢复（配置驱动的延迟路径也用它）。
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    // 要恢复的精确会话 id。
    const id = options.resumeSessionId
    // 发布 promise：纳入工厂账本。
    const published = (async () => {
      // The open and read may outlive their owner: race them against caller
      // cancellation, owner-fiber unload, and factory teardown so a
      // never-settling backend cannot pin the identity.
      // open/read 可能比其所有者活得久：把它们与调用方取消、owner fiber 卸载、
      // 工厂拆除竞速，确保永不落定的后端无法钉死该身份。
      const ownerAbort = new AbortController()
      // 所有者卸载的跟随 effect：卸载时触发 ownerAbort。
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `agentLoop.resume-load(${id})`)
      // 融合三路取消来源为一个信号。
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      // 写句柄槽位（交给 initializeAgent 后清空）。
      let handle: SessionHandle | undefined
      // 存储槽位。
      let stored: StoredSession | undefined
      // 会话准备器槽位（finally 中兜底释放）。
      let preparation: SessionPreparation | undefined
      try {
        try {
          // Taking write ownership FIRST excludes a concurrent resume of the
          // same id (in this process, a live agent's handle holds the claim).
          // 先取写所有权，排除同 id 的并发恢复（本进程内，存活智能体的句柄持有声明）。
          handle = await raceAbortCall(
            () => persistence.open(id, 'write', { signal: fused }),
            fused,
            id,
            (abandoned) => { void abandoned.close() },
          )
          // Semantic crash repair is the agent layer's job: persistence hands
          // back the physically valid log; an interrupted final turn receives
          // synthetic closers (missing tool errors, step/end, turn/end) that
          // are appended through the same handle as an ordinary batch.
          // 语义级崩溃修复是智能体层的职责：持久化只交还物理有效的日志；
          // 被打断的末轮会收到合成收尾事件（缺失工具错误、step/end、turn/end），
          // 以普通批次经同一句柄追加。
          const coldRead = await handle.read(0, undefined, { signal: fused })
          // 读完成后再显式检查一次是否已中断。
          fused.throwIfAborted()
          // 持久化下来的既有事件。
          const persisted = coldRead.events
          // 推导被打断末轮所需的合成收尾事件。
          const closers = interruptedTurnClosers(persisted)
          // 有收尾事件就先落盘，保证日志语义完整。
          if (closers.length > 0) await handle.append(closers)
          // 用恢复出的历史 + 收尾事件作种子准备会话；元数据深拷贝头部。
          preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }))
          // 存储游标 = 既有事件 + 刚追加的收尾事件。
          stored = { handle, storedCount: persisted.length + closers.length }
          // 把准备阶段又追加进会话的增量事件落盘。
          await this.appendUnstoredSuffix(stored, preparation.session)
        } finally {
          // 无论成败都解除所有者卸载跟随。
          await unfollowOwner()
        }
        // 断言调用者 fiber 仍活跃。
        ownerCtx.fiber.assertActive()
        // 断言工厂仍活跃。
        if (!this.ownership.isActive()) throw new Error('agent loop is not active')
        // 取出存储槽位。
        const owned = stored
        // initializeAgent 从此接管写句柄（含回滚与拆除），本地槽位清空防重复关闭。
        handle = undefined // initializeAgent owns the write handle through rollback and teardown.
        // 进入初始化与发布流程，来源标记为 resume。
        return await this.initializeAgent(ownerCtx, {
          session: preparation.session,
          stored: owned,
          agentOptions: options.agentOptions ?? {},
          setup: options.setup,
          signal: options.signal,
          source: 'resume',
        })
      } finally {
        // 兜底：释放尚未交付的准备器。
        preparation?.[Symbol.dispose]()
        // 兜底：关闭尚未移交的句柄（成功路径此处为空）。
        await handle?.close().catch(() => {})
      }
    })()
    // 纳入工厂账本。
    this.ownership.trackWrapper(published)
    return published
  }
}

// 默认导出：AgentLoop 服务类。
export default AgentLoop
