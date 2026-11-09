// 模块说明：智能体服务（ctx.agents）——存活智能体注册表、创建工厂委托、
// 以及进程内的发起者（initiator）作用域。具体的创建与驱动归 agent-loop 包所有，
// 这里只做"名册 + 因果归因"。关键设计：
// 1. 所有权分权：编程创建者拿到 AgentHandle（拆除能力），
//    结构性所有者（工厂 provider 卸载）也会停止并排空其句柄；
// 2. 发起者链：AsyncLocalStorage 携带"哪个 Agent 发起了这条异步驱动链"，
//    仅用于同进程因果归因——在场不等于存活证明，更不是授权；
// 3. 发布边界：enter（不广播插入）与 announce（串行创建广播）分离，
//    拆除与创建严格配对，回滚路径不虚构生命周期边。
/**
 * Agent service: live registry, factory delegation, and process-local
 * initiator scope. Concrete creation and driving belong to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

// cordis 原语：上下文、fiber 状态、可追踪接收器、服务基类、包装穿透符号。
import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
// Fiber 类型。
import type { Fiber } from '@deepseek-ai/cordis'
// AsyncLocalStorage：进程内携带发起者边界。
import { AsyncLocalStorage } from 'node:async_hooks'
// isPromise：判断返回值是否为 promise。
import { isPromise } from 'node:util/types'
// scopeTarget：以智能体为 subject 圈定监听范围。
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// Scoped this 标记类型。
import type { Scoped } from '@deepseek-ai/dsh-scope'
// 会话核心类型：会话、事件、id、日志偏移。
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
// 投影句柄类型。
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
// 轮次归档准入安装器。
import { installTurnArchiveAdmission } from './archive-admission.ts'
// Agent 契约与轮次边界投影类型。
import type { Agent, TurnBoundaryProjection } from './types.ts'
// 运行期类型：智能体选项与会话启动来源。
import type { AgentOptions, SessionStartSource } from './runtime-types.ts'
// 轮次边界投影定义。
import { turnBoundaryProjectionDefinition } from './projection.ts'

// 原样转发各子模块的类型与值导出。
export * from './runtime-types.ts'
export * from './types.ts'
// 模型选择层及其投影。
export { AgentModel, modelSelectionProjectionDefinition, installModelSelection } from './model-selection.ts'
export type { ModelSelectionProjectionState } from './model-selection.ts'
export type * from './projection.ts'
export * from './consumed-work.ts'
// 事件分发原语。
export { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

// 模块扩充：把 agents 服务挂到 cordis Context 上。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // agents 服务实例。
    agents: AgentRegistry
  }
}

/**
 * Synchronous finalizer returned by unpublished Agent setup when its
 * contributions need validation at the exact publication commit point.
 */
export interface AgentSetupCommit {
  /**
   * Validate and commit the prepared setup immediately before publication.
   * @throws when publication must roll the unpublished Agent back.
   */
  // 在发布前的精确时点校验并提交准备好的装配。
  commit(): void
}

/**
 * Compose an unpublished Agent scope and optionally return its publication commit.
 * @param agentCtx - unpublished Agent scope.
 * @param agent - unpublished Agent being composed.
 * @returns an optional synchronous commit invoked after setup awaits settle and immediately before publication.
 */
// 组装未发布的 Agent 作用域，可选返回发布提交对象。
export type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/**
 * Options for programmatically creating an agent through the registry factory
 * ({@link AgentRegistry.create}). The caller supplies the single live
 * `sessionId` shared by the agent registry and session log (e.g. an
 * ACP-generated id), plus optional session metadata (the validated `cwd`, fork
 * lineage); the factory creates the session and agent under that identity.
 */
export interface CreateAgentOptions {
  /** The live agent/session identity. */
  // 存活的智能体/会话共享身份。
  readonly sessionId: SessionId
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, the `isSeeded` fork marker, the coarse `origin`
   * classification, and the `delegationDepth` recursion budget. Mirrors the
   * `cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it). This is durable session data,
   * so the session boundary validates and snapshots it before asynchronous
   * setup begins.
   */
  // 会话创建元数据：校验过的绝对 cwd、分叉谱系、isSeeded 标记、粗粒度来源
  // 与委派深度预算。内部专用的 createdAt 刻意排除（工厂调用者永不设置）。
  // 这些是持久会话数据，异步 setup 开始前由会话边界校验并快照。
  readonly meta?: {
    // 工作目录。
    readonly cwd?: string
    // 分叉父会话。
    readonly parentSession?: SessionId
    // 分叉种子标记。
    readonly isSeeded?: boolean
    // 粗粒度来源分类。
    readonly origin?: 'subagent'
    // 委派深度预算。
    readonly delegationDepth?: number
    // 智能体预设名。
    readonly agentPreset?: string
  }
  /** Exact fork-inherited prefix length when the session metadata sets `isSeeded`. */
  // isSeeded 时的精确分叉继承前缀长度。
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Initial replay/fork history, contiguous from seq 0 with lossless-JSON data.
   * A fork supplies an exact parent prefix, its inherited marker, and closers
   * for the open tail. Previously closed steps and turns remain unchanged.
   * The factory validates and snapshots the seed before publication.
   */
  // 初始重放/分叉历史：从序号 0 连续、数据无损 JSON。
  // 分叉供给精确的父前缀、继承标记与开放尾部的收尾事件。
  // 工厂在发布前校验并快照种子。
  readonly seed?: readonly SessionEvent[]
  /** Route fallback and output controls; see {@link AgentOptions} for live accessor semantics. */
  // 路由回退与输出控制（存活访问器语义见 AgentOptions）。
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  // 可选的"仅创建期"取消信号；句柄可见前即脱离。
  readonly signal?: AbortSignal
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx`, entering the SessionStore, and completing
   * `session/created`. The Session
   * accepts live events during setup; the Agent remains outside its registry
   * until setup completes. Agent creation is announced after setup. Setup may return an {@link AgentSetupCommit}; the factory invokes its
   * synchronous `commit()` after every setup await settles and immediately
   * before registry publication. This lets mutable provisioning revalidate at
   * the exact publication boundary. Everything registered through `agentCtx`
   * (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited
   * child plugins) exists before `agent/created`,
   * and the first prompt assembly. A setup
   * throw/rejection, commit throw, or owner disposal rolls the scope back
   * without announcing Agent creation. Already committed Session events remain stored.
   *
   * **Setup composes, it never drives**: the callback is trusted same-process
   * code and receives the full scoped context, so this is a contract rather
   * than a runtime restriction. Drive the agent only after creation resolves.
   */
  readonly setup?: AgentSetup
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
// 在持久会话上恢复智能体的选项。
export interface ResumeAgentOptions {
  /** The persisted session id to load and use as the live agent/session identity. */
  // 要加载的持久会话 id，作为存活的智能体/会话身份。
  readonly resumeSessionId: SessionId
  /** Route fallback and output controls; see {@link AgentOptions} for live accessor semantics. */
  // 路由回退与输出控制。
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  // 持久化加载/setup 的可选取消信号；返回前脱离。
  readonly signal?: AbortSignal
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the factory then enters and announces the reconstructed Session and awaits
   * setup in the fresh `agentCtx` before registering the Agent. The callback has the
   * same trusted composition-only contract and optional synchronous
   * publication commit as {@link CreateAgentOptions.setup}: all registrations
   * exist before Agent creation is announced, and rejection, commit failure,
   * or owner disposal unwinds the transaction while preserving pending inbox input.
   */
  // 恢复时的作用域组装：持久化先加载；工厂先进入并广播重建的会话，
  // 再在新的 agentCtx 里等待 setup。契约与创建时相同——失败回退并保留收件箱输入。
  readonly setup?: AgentSetup
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The registered factory provider is
 * also a structural owner because the scoped agent depends on that provider's
 * service API; provider unload stops and drains every live handle it made.
 * `dispose()` stops the loop, awaits its exit, unregisters the agent, removes
 * its session from the store, and finally unwinds its scoped world.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
 */
// 持有者所有的智能体与其拆除器。拆除器是一种"能力"：消费者中只有持有者
// 能拆除该智能体。注册工厂的 provider 也是结构性所有者——provider 卸载会
// 停止并排空它创建的所有存活句柄。dispose 做四件事：停循环、注销、
// 移除会话、退绕作用域。
export interface AgentHandle {
  // 智能体本身。
  agent: Agent
  // 共享拆除器。
  dispose(): Promise<void>
}

/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
export interface AgentFactory {
  /**
   * Create a new agent on a caller-supplied session id. Async because creation
   * enters and announces the Session, awaits setup and its optional synchronous commit,
   * inserts the Agent, and awaits serial
   * `agent/created` listeners before releasing queued work. The sequence is
   * rollback-covered, but notifications delivered before a later listener
   * failure remain observable; every agent or session creation announcement
   * that began is paired by `agent/disposed` or `session/disposed` during
   * rollback. Once Agent initialization begins, failures reject after its
   * scope and acquired write handle finish cleanup. Cancellation during
   * persistence acquisition may reject before a late handle is available to close.
   * The owner disposes the resolved handle to stop/drain,
   * unregister, remove the session, and unwind the scope.
   * The registry passes a context carrying the `create()` caller's fiber and
   * scope as `ownerCtx`. The implementation attaches the unpublished
   * transaction and resulting lifecycle to that owner; it must not infer
   * ownership from the factory object's registration context.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, and setup.
   * @returns the owned handle after setup and both creation announcements complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Resume an agent on a persisted session. Async because it opens the
   * persisted session for write, reads and repairs the log, publishes it, and
   * awaits the optional unpublished setup transaction; must be called after
   * `ctx.sessionPersistence` exists (consumers inject `sessionPersistence`).
   * Initialization cleanup and publication follow the same timing as
   * {@link createAgent}.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/** All mutable lifecycle state for one exact registry entry. */
// 名册条目的全部可变生命周期状态。
interface AgentEntry {
  // 共享 id。
  readonly id: SessionId
  // 智能体。
  readonly agent: Agent
  // 作用域载体（subject 即智能体）。
  readonly carrier: Scoped<Agent>
  // 是否已广播创建。
  announced: boolean
  // 是否正在广播创建。
  announcing: boolean
  // 广播期间是否有推迟的拆除请求。
  detachRequested: boolean
}

/** One tracked boundary plus its inherited nesting chain. */
// 一个被跟踪的边界及其继承嵌套链。
interface InitiatorRun {
  // 边界是否仍存活。
  active: boolean
  // 父边界。
  readonly parent: InitiatorRun | undefined
}

/** Plain holder prevents Cordis from tracing the factory field before the caller context is known. */
// 普通对象持有工厂：防止 Cordis 在调用者上下文未知前追踪该字段。
interface FactorySlot {
  // 具体工厂目标。
  readonly target: AgentFactory
}

/**
 * Agent service (`ctx.agents`): tracks live agents and carries the initiating
 * Agent through one process-local asynchronous driver chain. Agent *creation*
 * is provided by whichever plugin implements the {@link AgentFactory}
 * (`@deepseek-ai/dsh-agent-loop`), registered via {@link setFactory}.
 *
 * Initiator methods provide same-process causal attribution only. Ambient
 * presence is neither liveness proof nor authorization; subjects and owners
 * remain explicit, as does identity at worker, process, persistence, and wire
 * boundaries. Returned Promise boundaries drain during teardown, except a
 * nested lineage that starts an owning-fiber unload is excluded from its own drain.
 */
export class AgentRegistry extends Service {
  // 声明依赖：会话投影服务。
  static inject = ['sessionProjections']

  // 轮次边界投影句柄（init 后赋值）。
  private turnBoundaryProjectionHandle!: ProjectionHandle<TurnBoundaryProjection>
  // 存活智能体名册：id -> 条目。
  private store = new Map<SessionId, AgentEntry>()
  // 工厂槽位（普通对象防追踪）。
  private factory: FactorySlot | undefined
  // 发起者边界存储。
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  // 发起者运行跟踪存储。
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  // 发起者作用域状态机。
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  // 存活的发起者运行计数。
  private activeInitiatorRuns = 0
  // 排空栅栏（计数归零时 resolve）。
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  // 记忆化的发起者处置 promise。
  private initiatorDisposal: Promise<void> | undefined

  // 构造：注册 typert 解析、监听 fiber 卸载、装发起者生命周期 effect、装归档准入。
  constructor(ctx: Context) {
    super(ctx, 'agents')
    // 注入 typert 服务注册远程类型解析：线上 agentId <-> 本进程 Agent。
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('agent', {
        parameter: 'agent',
        wire: 'agentId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
      typeCtx.typert.contexts.registerHost('agent', {
        wire: 'agentId',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resource: 'session',
        resolve: sessionId => this.get(sessionId)?.ctx,
      })
    })
    // 监听内部状态：本服务生命周期的 fiber 开始卸载时关闭发起者边界。
    ctx.on('internal/status', (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    // 发起者生命周期的有序拆除：先排空、再关闭。
    ctx.effect(function* (this: AgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), 'agents.initiatorLifecycle()')
    // Archive admission: the Workspace registry asks what still runs for a
    // Session before hiding it; a running turn answers here, for every Agent.
    // 归档准入：Workspace 在隐藏会话前询问还有什么在跑；运行中的轮次
    // 在这里作答（对所有 Agent 生效）。
    installTurnArchiveAdmission(ctx, sessionId => this.get(sessionId))
  }

  protected async [Service.init](): Promise<void> {
    // 注册轮次边界投影。
    this.turnBoundaryProjectionHandle = await this.ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  }

  /**
   * Read the turn and step positions recorded in a Session.
   * @param session - Session whose committed events are read.
   * @returns the current turn and step positions; do not mutate the returned value.
   */
  turnBoundaryOf(session: Session): TurnBoundaryProjection {
    // 从投影读取会话的轮/步位置。
    return this.turnBoundaryProjectionHandle.stateOf(session)
  }

  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * Use this optional form for logging, tracing, metrics, or host attribution
   * that also supports agentless calls. When a parent creates a child, setup
   * reports the causal parent while the setup callback's Agent parameter
   * identifies the child.
   * @returns the inherited Agent, or `undefined` outside an initiator boundary
   *   and inside an explicit clearing boundary.
   * @throws when this service instance has been disposed.
   */
  currentInitiator(): Agent | undefined {
    // 服务已处置则不可读。
    this.assertInitiatorsReadable()
    // 读继承的发起者。
    return this.initiators.getStore()
  }

  /**
   * Read the initiating Agent and fail when no initiator boundary is active.
   * Use this for private helpers contractually below a driver, or for a
   * deployment-owned outbound request whose contract forbids agentless calls.
   * Generic or direct-call paths use optional lookup or explicit request fields.
   * @returns the inherited Agent.
   * @throws when no initiator is active or this service instance has been disposed.
   */
  requireInitiator(): Agent {
    // 无发起者边界：硬性报错。
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /**
   * Run an operation with one exact Agent as its process-local initiator. The
   * exact synchronous value or Promise returned by the operation is preserved.
   * Custom drivers and test harnesses wrap their complete returned foreground
   * lifetime.
   * A queue or wire receiver may establish this boundary only after validating
   * explicit identity and resolving the exact live Agent; this method does neither.
   * Detached work remains owned by the subsystem that starts it.
   * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    // 建立发起者边界（返回值原样保留）。
    return this.runWithInitiator(agent, operation)
  }

  /**
   * Run an operation inside a boundary that hides any inherited initiating
   * Agent. The exact synchronous value or Promise is preserved.
   * Use this while creating lazy shared timers, queue pumps, pool maintenance,
   * watchers, or exporters so they do not inherit the first Agent that happens
   * to initialize them. It clears only initiator attribution, not explicit
   * fields, and does not own or drain detached resources.
   * @param operation - synchronous or asynchronous operation to invoke without an initiator.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withoutInitiator<T>(operation: () => T): T {
    // 建立清除边界：惰性共享资源不继承首个碰巧初始化它的 Agent。
    return this.runWithInitiator(undefined, operation)
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). A traced Cordis service is canonicalized to its concrete
   * target; each create/resume call is then traced through that caller's
   * context so ownership follows the caller without stacking proxy layers.
   * Throws if a factory is already registered. Returns the disposer; on
   * dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => void {
    // 以 effect 作用域登记工厂槽位（循环插件构造时调用）。
    const dispose = this.ctx.effect(() => {
      // 重复注册：报错。
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // Avoid stacking two Cordis shadow layers when a caller passes a Service
      // already read through a context. Calls are re-traced through their
      // actual owner context below.
      // 调用方传入已被上下文读取过的 Service 时避免叠加两层 Cordis 影子；
      // 调用会在下方经其实际所有者上下文重新追踪。
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      // 填入槽位。
      this.factory = { target }
      // 拆卸时清槽。
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // The exact cordis effect disposer (the agents.register() convention): a
    // caller's composite effect can yield it for in-order teardown; the
    // loop's constructor effect returns it directly, identity-nesting the
    // registration under that effect.
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** Return the active creation factory. */
  private requireFactory(): FactorySlot {
    // 未注册工厂：提示加载 agent-loop 插件。
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /**
   * Create and publish a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Rejects if no factory is
   * registered or creation/setup fails. The resolved {@link AgentHandle} lets
   * the owner tear down exactly this agent.
   * @param options - shared identity, session seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    // 以本服务上下文作为所有者上下文。
    const ownerCtx = this.ctx
    // Re-trace a Service-backed factory through the accessing context
    // explicitly. This preserves AgentLoop's dependency origin while binding
    // its effects to ownerCtx; plain factories receive ownerCtx as an explicit
    // capability and need no Cordis tracker magic.
    // 显式经访问上下文重新追踪 Service 型工厂：既保留 AgentLoop 的依赖来源，
    // 又把其 effect 绑定到 ownerCtx；普通工厂把 ownerCtx 当显式能力接收，
    // 无需 Cordis 追踪魔法。
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    // 以追踪后的接收器调用工厂创建。
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, configuration, and setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    // 与 create 相同的所有者与追踪路径，只是走 resume。
    const ownerCtx = this.ctx
    const { target } = this.requireFactory()
    const receiver = getTraceable(ownerCtx, target)
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
    return Reflect.apply(target.resume, receiver, [ownerCtx, options])
  }

  /**
   * Register a live agent with source `startup`. Rejects if the id is already registered or a
   * serial `agent/created` listener fails. Emits `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). Await registration before using the agent.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the awaitable Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
   */
  register(agent: Agent): ReturnType<Context['effect']> {
    // 组合 effect：先不广播插入，再以 startup 来源广播创建。
    return this.ctx.effect(async function* (this: AgentRegistry) {
      yield this.enter(agent)
      await this.announce(agent, 'startup')
    }.bind(this), 'agents.register()')
  }

  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   `agent/created` listener, removal and disposal wait until the serial
   *   creation dispatch settles.
   */
  enter(agent: Agent): () => void {
    // 校验智能体 id 与会话 id 一致（共享身份前提）。
    const id = agent.id
    if (id !== agent.session.id) {
      throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
    }
    // 以智能体为 subject 的作用域载体。
    const carrier = scopeTarget(agent, agent)
    // This is the authoritative collision boundary. Concurrent create/resume
    // operations may both prepare, but only one exact entry can publish.
    // 这是权威的冲突边界：并发的 create/resume 都可能准备，
    // 但只有一个精确条目能发布。
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    // 组装名册条目。
    const entry: AgentEntry = {
      id,
      agent,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    // 插入名册。
    this.store.set(id, entry)
    // 单次有效标记。
    let entered = true
    // 拆卸闭包：幂等；广播进行中则推迟到创建分发落定。
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Every callback reached by this creation dispatch must observe the same
      // live entry, and disposal must follow creation. A listener may own
      // the advanced detach capability, so make that ordering structural:
      // visibility and the paired disposal are deferred until announce()'s
      // serial dispatch has settled.
      // 创建分发触达的每个回调都必须观察到同一个存活条目，
      // 拆除必须晚于创建。监听器可能持有高级 detach 能力，
      // 所以把这一顺序做成结构性的：推迟到 announce() 的串行分发落定。
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      // 直接拆除。
      this.detachEntered(entry)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  // 移除一个精确的已插入智能体；已广播过的配对发出 agent/disposed。
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // A stale capability can never delete a later same-id lifecycle. The
    // captured entry identity is the final boundary.
    // 过期的能力永远删不掉之后同 id 的新生命周期；捕获的条目身份是最终边界。
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    // 从名册移除。
    this.store.delete(entry.id)
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    // announce 前回滚的插入从未对外创建过，发出 disposed 会虚构不可能的
    // 生命周期边。标记先于 created 发出：若后续 created 监听器抛错，
    // 先前的监听器可能已观察到创建，必须能看到配对的拆除。
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  // 经条目的稳定载体发出配对的销毁边（监听器失败只告警）。
  private emitDisposed(entry: AgentEntry): void {
    // 组装事件参数。
    const args: unknown[] = [entry.carrier, 'agent/disposed', { agent: entry.agent }]
    // 以 emit 模式派发并逐个调用监听器。
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        // 异步拒绝兜底告警。
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        // 同步抛错同样只告警。
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @param source - fresh creation, resume, clear, or compaction source.
   * @param signal - optional factory initialization cancellation signal passed to listeners.
   * @returns completion of the serial creation listeners; a listener failure rejects.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  async announce(agent: Agent, source: SessionStartSource, signal?: AbortSignal): Promise<void> {
    // 校验该智能体确为名册中此 id 的精确存活条目。
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      // 已广播过（或广播中）：拒绝重复。
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    // 在分发之前先打标记，监听器就无法递归制造第二个生命周期边；
    // detach 仍会与部分送达的第一条边配对。
    entry.announcing = true
    entry.announced = true
    try {
      // 串行派发 agent/created（监听器逐个执行，失败即拒绝）。
      await this.ctx.serial(entry.carrier, 'agent/created', {
        agent: entry.agent,
        source,
        ...signal === undefined ? {} : { signal },
      })
    } finally {
      // 复位广播标记并执行被推迟的拆除。
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * Look up a live agent.
   * @param id - the shared agent/session id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: SessionId): Agent | undefined {
    // 按共享 id 查存活智能体。
    return this.store.get(id)?.agent
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    // 按注册顺序导出全新数组。
    return [...this.store.values()].map(entry => entry.agent)
  }

  /** Reject new initiator boundaries while inherited continuations drain. */
  // 关闭发起者作用域：继承中的续体排空期间拒绝新边界。
  private closeInitiators(): void {
    if (this.initiatorState === 'active') this.initiatorState = 'closing'
  }

  /** Wait for returned-Promise boundaries, then invalidate retained references. */
  // 处置发起者作用域：等返回 Promise 的边界落定，然后使保留引用失效。
  private disposeInitiators(): Promise<void> {
    // 记忆化：只处置一次。
    return (this.initiatorDisposal ??= (async () => {
      // 先进入 closing。
      this.closeInitiators()
      // 把发起本次拆除的边界链从它自己的排空中排除。
      this.releaseReentrantInitiatorRuns()
      // 仍有存活的发起者运行：等排空栅栏。
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      // 全部排空：标记 disposed 并禁用两个存储。
      this.initiatorState = 'disposed'
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  /** Establish one tracked initiator or clearing boundary. */
  // 建立一个被跟踪的发起者或清除边界（内部原语）。
  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== 'active') throw new Error(DISPOSED_INITIATOR_MESSAGE)
    // 记录本次运行及其继承链。
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    // 计数 +1。
    this.activeInitiatorRuns += 1
    let result: T
    try {
      // 双层运行：run 跟踪层 + 发起者值层。
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      // 同步抛错：立即释放计数。
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        // Promise 结果：落定后释放（成败皆可）。
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        // A branded Promise may expose a failing @@species. Observer setup did
        // not attach, so preserve the exact return without leaking the run.
        // 品牌化 Promise 的 @@species 可能失败：观察器没挂上，
        // 保留原样返回值并释放运行，避免泄漏。
        this.releaseInitiatorRun(run)
      }
    } else {
      // 同步结果：立即释放。
      this.releaseInitiatorRun(run)
    }
    return result
  }

  /** Whether one unloading fiber owns this service's lifecycle. */
  // 判断某个正在卸载的 fiber 是否拥有本服务的生命周期（沿父链上溯）。
  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      // 到达根（父指向自身）：没有祖先匹配。
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    // 已处置：读取不再可靠。
    if (this.initiatorState === 'disposed') throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  /** Exclude the boundary chain that initiated this teardown from its own drain. */
  // 把发起本次拆除的边界链排除在自己的排空之外（防止自等待死锁）。
  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    // 幂等释放。
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    // 计数归零：放开排空栅栏。
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

// 默认导出：AgentRegistry 服务类。
export default AgentRegistry
