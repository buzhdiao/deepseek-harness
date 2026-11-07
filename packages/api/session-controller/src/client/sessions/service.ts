// 客户端目录（catalog）与带来源标记的所有权：管理精确的 Session（会话）世代（generation）。
/** Client catalog and source-labelled ownership of exact Session generations. */

// cordis 的 Context 与 Fiber（纤维）类型：上下文与轻量作用域执行单元。
import type { Context, Fiber } from '@deepseek-ai/cordis'
// SubagentAddress（子代理地址）：直连子代理会话的寻址类型。
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
// 会话序号品牌与会话 id 类型。
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
// 从工作区路径推导展示标题的工具。
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
// WorkspaceId（工作区 id）品牌类型。
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
// 搜索结果上限常量。
import { SESSION_SEARCH_RESULT_LIMIT } from '../../types.ts'
// 投影摘要值类型：列表行携带的投影子集。
import type { SessionProjectionSummaryValues } from '@deepseek-ai/dsh-session-projection/types'
// 客户端存储原语：快照存储创建、订阅者通知与可观察快照类型。
import {
  createSnapshotStore, notifySubscribers, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
// 远程失败与远程结果类型。
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// 会话事件源类型。
import type { SessionEventSource } from '../contract/events.ts'
// 会话对外接口（face）。
import type { SessionFace } from '../contract/session.ts'
// 会话契约类型：代理上下文、目录接口、引用、保留信息与选项、目标。
import type {
  AgentContext, ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from '../contract/sessions.ts'
// 引用来源类型（gateway 等来源标记）。
import type { SessionReferenceSource } from '../index.ts'
// 作用域（scope）原语：创建、身份读取与作用域标记读取。
import { createScope, scopeIdentityOf, scopeOf as scopeTagOf } from '../scope.ts'
// SessionManager（会话管理器）：对象层实例簇与帧分发入口。
import { SessionManager } from './manager.ts'
// 生成的远程命名空间集合类型。
import type { SessionRemotes } from './remotes.ts'
// 管理器快照类型：列表阶段、搜索结果项与投影快照。
import type { SessionListPhase, SessionSearchResultItem, SessionProjectionSnapshot } from './manager.ts'
// Session 对象类类型。
import type { Session } from './session.ts'
// 谱系统计的列表条目类型。
import type { SessionListEntry } from './lineage.ts'

// 会话列表行：宿主列表 RPC 结果与实时流增量的投影。
/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  // 会话 id。
  id: SessionId
  // 最新持久日志支持的标题；宿主投影出之前缺省。
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  // 面向人的标签：持久标题、项目目录名，最后回退到会话 id。
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  // 工作目录（可选）。
  cwd?: string
  // 父会话 id（子代理行携带）。
  parentId?: SessionId
  // 粗粒度的持久来源标记（子代理），供导航过滤；不代表续聊能力。
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  // 宿主列表提供的格式分类（可用时）。
  /** Format classification supplied by the Host list, when available. */
  formatStatus?: SessionListEntry['formatStatus']
  // `ids` 成员的宿主运行态；其他行仅作展示回退。
  /** Host running state for `ids` members; a display fallback for other rows. */
  running: boolean
  // 本地所有权计数；宿主元数据刷新不能覆盖。
  /** Local ownership counts; Host metadata refreshes cannot overwrite them. */
  readonly retainedBy: SessionRetainInfo['retainedBy']
  /**
   * New Session presentation and reuse eligibility, derived from the Host
   * summary, `sessionListMetadata`, and client acceptance/running observations.
   * New Session and Workspace reconnection may reuse a blank in the same workspace. Filtering
   * stays with the consumer: the store carries every row, while the Workspace
   * browser shows only the selected blank entry.
   */
  // 新会话展示与复用资格：由宿主摘要、sessionListMetadata 与客户端接受/运行观察共同推导。
  blank: boolean
  // 最近更新时间戳。
  updatedAt: number
  /**
   * The row's summary projection values retained by the object layer, never the
   * full projection set. A connected Session's store may hold more values from
   * its control/follow baseline; those are outside the list contract.
   */
  // 该行的摘要投影值（对象层保留），绝非完整投影集合。
  projectionValues?: Readonly<Partial<SessionProjectionSummaryValues>>
}

// 目录元数据与本地来源计数；目录成员身份不拥有客户端世代。
/** Catalog metadata and local source counts; catalog membership owns no Client generation. */
export interface SessionListState {
  // 宿主列表顺序；每个 id 在同一快照中都有对应的 byId 行。
  /** Host list order; every id has a matching byId row in the same snapshot. */
  ids: SessionId[]
  // 宿主/目录行加上保留的子代理回退行；只有 `ids` 表达宿主列表成员身份。
  /** Host/catalog rows plus retained subagent fallbacks; only `ids` expresses Host-list membership. */
  byId: Record<SessionId, SessionSummary>
  // 到达生命周期，1:1 投影自管理器快照；ready 且为空即"确实没有会话"。
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  // 共享投影值与显式读取状态，包含未打开的会话。
  /** Shared projection values and explicit-read state, including unopened Sessions. */
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
}

// 结构化的会话创建失败。
/** Structured session-create failure. */
export class SessionCreateError extends Error {
  // 覆盖错误名，便于识别。
  override readonly name = 'SessionCreateError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param requestedSessionId - caller-preallocated id used for later stream/list reconciliation.
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly requestedSessionId: SessionId | undefined,
  ) {
    // 错误消息带上失败码与描述。
    super(`session create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

// 结构化的会话分叉失败。
/** Structured session-fork failure. */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param sourceSessionId - the session the fork was cut from.
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly sourceSessionId: SessionId,
  ) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

// 一个已物化客户端 Session 的身份稳定逻辑绑定。
/** Identity-stable logical binding for one materialized Client Session. */
export interface SessionBinding {
  // 会话 id。
  readonly sessionId: SessionId
  // 只暴露对外会话接口（face），功能代码永远接触不到具体类。
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  // 预留给会话视图（Conversation）组装的连续事件窗口。
  /** Contiguous event window reserved for Conversation assembly. */
  readonly eventSource: SessionEventSource
  // 代理作用域上下文。
  readonly ctx: AgentContext
}

// Scope primitives live in ../scope.ts (the client mirror of host
// dsh-scope, keyed by Agent identity); re-exported here so existing
// consumers keep their import site.
// 作用域原语位于 ../scope.ts（宿主 dsh-scope 的客户端镜像，以 Agent 身份为键）；
// 这里重新导出，让既有消费者保持导入位置不变。
export { scopeOf } from '../scope.ts'

/**
 * Display title projection: durable title, project directory basename, then
 * the raw id.
 */
// 展示标题投影：持久标题 > 项目目录名 > 原始 id。
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  // 有持久标题直接用。
  if (title !== undefined) return title
  if (cwd !== undefined && cwd !== '') {
    // 取项目目录基名。
    const base = workspaceTitleOf(cwd)
    // 基名非空则使用。
    if (base !== '') return base
  }
  // 最后回退到会话 id。
  return id
}

/**
 * Increment the fork number until the candidate is not taken.
 * @param title - source session's durable title.
 * @param taken - durable titles of Host-listed sessions.
 * @returns the title assigned to the fork child.
 */
// 递增分叉编号直到候选标题未被占用。
function increasedForkTitle(title: string, taken: ReadonlySet<string>): string {
  // 先递增一次。
  let next = incrementedTitle(title)
  // 仍被占用则继续递增。
  while (taken.has(next)) next = incrementedTitle(next)
  return next
}

/**
 * Increment a trailing fork number while preserving its half-width or
 * full-width parentheses; an unnumbered title starts with ` (1)`.
 * @param title - title to increment.
 * @returns the title with the next fork number.
 */
// 递增标题尾部编号，保留半角/全角括号；无编号标题从 ` (1)` 开始。
function incrementedTitle(title: string): string {
  // 半角括号编号匹配。
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    // 用 BigInt 递增避免大数精度问题，回写半角括号。
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  // 全角括号编号匹配。
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    // 用 BigInt 递增并保留全角括号。
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  // 无编号标题：追加 ` (1)`。
  return `${title} (1)`
}

// 来源标签作为字典键，包括与 Object.prototype 同名的键。
/** Source labels are dictionary keys, including names also present on Object.prototype. */
function freezeRetainedBy(counts: Partial<Record<SessionReferenceSource, number>>): SessionRetainInfo['retainedBy'] {
  // 去掉原型，防止键名冲突（如 "constructor"）。
  Object.setPrototypeOf(counts, null)
  // 冻结为只读。
  return Object.freeze(counts)
}

// 空保留信息常量：零引用且无来源。
const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: freezeRetainedBy({}) })

// 作用域记录：一个已物化世代的全部本地状态。
interface ScopeRecord {
  // 作用域纤维。
  fiber: Fiber
  // 代理作用域上下文。
  ctx: AgentContext
  // 会话绑定。
  binding: SessionBinding
  // Session 对象实例。
  session: Session
  // 当前保留信息。
  retention: SessionRetainInfo
  // 存活标志：世代是否仍然有效。
  live: boolean
}

// 保留观察者：对外可观察的保留信息及其订阅者。
interface RetentionObserver {
  // 可观察快照源。
  readonly source: ObservableSnapshot<SessionRetainInfo>
  // 订阅者集合。
  readonly listeners: Set<() => void>
  // 上次发布值：用于去重。
  published: SessionRetainInfo
}

// 等待打开：被取消的等待者只释放自己的引用，不影响共享的打开过程。
/** A cancelled waiter releases only its own reference, not the shared opening. */
async function waitForOpen(opening: Promise<void>, signal?: AbortSignal): Promise<void> {
  // 无取消信号：直接等待打开完成。
  if (signal === undefined) return opening
  // 用可外界解决的 Promise 表示取消。
  const aborted = Promise.withResolvers<never>()
  // 取消回调：以取消原因拒绝。
  const onAbort = (): void => { aborted.reject(signal.reason) }
  // 注册一次性 abort 监听。
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    // 监听前可能已取消：立即触发。
    if (signal.aborted) onAbort()
    // 打开与取消竞速：先到者胜。
    await Promise.race([opening, aborted.promise])
  } finally {
    // 无论结果如何都移除监听。
    signal.removeEventListener('abort', onAbort)
  }
}

// 客户端会话引用：对外返回的可释放句柄。
class ClientSessionReference implements SessionReference {
  // 释放信号控制器。
  private readonly released = new AbortController()
  // 就绪（readiness）的可外界解决对。
  private readonly readiness = Promise.withResolvers<SessionBinding>()
  // 对外暴露的就绪 Promise。
  readonly ready = this.readiness.promise

  constructor(
    readonly sessionId: SessionId,
    private record: ScopeRecord | undefined,
    private releaseReference: (() => void) | undefined,
  ) {
    // 预挂 catch：释放导致的拒绝是有意的，避免 unhandled rejection。
    void this.ready.catch(() => {})
  }

  // 读取绑定；引用已释放则报错。
  get binding(): SessionBinding {
    if (this.record === undefined || !this.record.live) throw new Error(`Session reference "${this.sessionId}" is released`)
    return this.record.binding
  }

  // 挂接打开过程：打开成功即兑现就绪 Promise；等待被取消则拒绝。
  attachOpening(opening: Promise<void>, signal?: AbortSignal): void {
    // 等待信号：调用方信号与释放信号合并。
    const waitSignal = signal === undefined
      ? this.released.signal
      : AbortSignal.any([this.released.signal, signal])
    void waitForOpen(opening, waitSignal).then(
      () => {
        try {
          // 先确认不是取消路径的胜利。
          waitSignal.throwIfAborted()
          // 兑现绑定。
          this.readiness.resolve(this.binding)
        } catch (error: unknown) {
          // 取消或其他失败：拒绝就绪。
          this.readiness.reject(error)
        }
      },
      (error: unknown) => { this.readiness.reject(error) },
    )
  }

  // 释放引用：中止等待、拒绝就绪并交还保留计数。
  release(): void {
    // 释放原因。
    const reason = new Error(`Session reference "${this.sessionId}" is released`)
    // 取出释放回调。
    const release = this.releaseReference
    // 广播释放信号。
    this.released.abort(reason)
    // 拒绝就绪 Promise。
    this.readiness.reject(reason)
    // 清空记录，绑定不再可访问。
    this.record = undefined
    this.releaseReference = undefined
    // 执行释放回调（归还保留计数）。
    release?.()
  }

  // 支持 using 语法：作用域退出时自动释放。
  [Symbol.dispose](): void {
    this.release()
  }
}

// 宿主目录与本地引用分配器；视图选择留在控制器之外。
/** Host catalog and local reference allocator; view selection remains outside the Controller. */
export class ClientSessions implements ISessions {
  /**
   * The wire schema's own result bound, re-exposed for presentation plugins as
   * injected data. Not per-connection state: the `session.search` response
   * schema caps `items` at this constant, so every transport (fixture included)
   * reports the same number.
   */
  // 搜索结果上限：线上协议自身的界限，重新暴露给展示插件注入使用。
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  // 目录元数据与本地引用来源投影的快照存储。
  /** Catalog metadata and local reference-source projection. */
  readonly list: SnapshotStore<SessionListState>
  // 对象层实例簇与帧分发入口。
  /** The object-layer instance cluster and frame dispatch entry. */
  private readonly manager: SessionManager
  // 会话 id 到作用域记录的映射：当前存活的世代。
  private readonly scopes = new Map<SessionId, ScopeRecord>()
  // 按 id 稳定保留的来源观察者：跨越世代替换持续存活。
  /** Stable per-id sources retained for the Client root lifetime, including across generation replacement. */
  private readonly retainObservers = new Map<SessionId, RetentionObserver>()
  // 进行中的作用域销毁 Promise 集合。
  private readonly scopeDrops = new Set<Promise<void>>()
  // 控制器是否已关闭。
  private closed = false

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param remote - generated Remote namespaces shared with every Session.
   */
  constructor(
    private readonly rootCtx: Context,
    remote: SessionRemotes,
  ) {
    // 创建会话管理器。
    this.manager = new SessionManager(remote)
    // 创建列表快照存储：初始为 pending 阶段的空目录。
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, phase: 'pending', projectionsBySession: {},
    })
    // 订阅管理器变更：任何列表相关变化都重新投影。
    const disposeManagerProjection = this.manager.subscribe(() => { this.projectList() })
    // 注册清理副作用：根上下文销毁时收敛全部世代。
    rootCtx.effect(() => async () => {
      // 标记关闭，拒绝新的保留请求。
      this.closed = true
      // 先退订管理器投影。
      disposeManagerProjection()
      // 取出全部作用域记录并清空映射。
      const scopes = [...this.scopes]
      this.scopes.clear()
      for (const [, record] of scopes) {
        // 标记记录不再存活。
        record.live = false
        // 解绑会话的作用域上下文。
        record.session.unbindScope()
      }
      // 启动管理器销毁。
      const managerDisposal = this.manager.dispose()
      for (const [id, record] of scopes) {
        // 启动每个作用域的异步销毁。
        this.startScopeDrop(id, record)
        // 并发布最终的保留信息。
        this.publishRetention(id)
      }
      // 等待全部作用域销毁收敛。
      await this.drainScopeDrops()
      // 再等待管理器销毁完成。
      await managerDisposal
    }, 'session-controller.client.sessions')
    // 向根上下文反射注册自己，供跨插件包解析。
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  // 保留（retain）一个会话引用：同步登记，异步等待打开。
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const { source, signal } = options
    // 已取消的调用立刻失败。
    signal?.throwIfAborted()
    // 已关闭的控制器不再接受保留。
    if (this.closed) throw new Error('Session Controller is disposed')
    // 解析目标为会话 id。
    const id = this.manager.resolveTarget(target)
    // 同步登记作用域与保留计数。
    const reference = this.retainScope(id, source)
    try {
      // 挂接打开过程（幂等：在途/已打开返回既有 Promise）。
      reference.attachOpening(this.manager.get(id).open(), signal)
      return reference
    } catch (error) {
      // 失败时释放刚登记的引用。
      reference.release()
      throw error
    }
  }

  // 作用域化使用：保留、等待就绪、执行操作后必然释放。
  async using<T>(
    target: SessionTarget,
    options: SessionRetainOptions,
    operation: (reference: SessionReference) => T | Promise<T>,
  ): Promise<T> {
    // 先保留引用。
    const reference = this.retain(target, options)
    try {
      // 等待绑定就绪。
      await reference.ready
      // 执行操作。
      return await operation(reference)
    } finally {
      // 无论成败都释放。
      reference.release()
    }
  }

  // 读取某会话的保留信息可观察源（懒创建观察者）。
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let observer = this.retainObservers.get(id)
    if (observer === undefined) {
      // 新建订阅者集合。
      const listeners = new Set<() => void>()
      observer = {
        listeners,
        // 初始发布值为当前保留快照。
        published: this.retentionSnapshot(id),
        source: {
          // 读取当前快照。
          getSnapshot: () => this.retentionSnapshot(id),
          // 订阅变更；返回退订函数。
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      }
      this.retainObservers.set(id, observer)
    }
    return observer.source
  }

  /**
   * Resolve an already discovered direct-parent address without opening it.
   * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
   * @param id - possible addressed child id.
   * @returns A retained, catalog-derived, or unknown-mode listed address, without retaining a new selection or scope.
   */
  // 解析已发现的直连父地址而不打开会话：供持久化子视图避免 Agent 绑定的 RPC。
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * Read projections without starting migration; retry failed or migration-deferred reads.
   * @param sessionId - Session to inspect without opening its conversation.
   */
  // 读取投影而不触发迁移；失败或被迁移推迟的读取可重试。
  refreshProjections(sessionId: SessionId): Promise<void> {
    return this.manager.refreshProjections(sessionId)
  }

  /**
   * Refresh the real Session baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started baseline pull.
   */
  // 刷新真实会话基线；复用在途的拉取。
  refresh(): Promise<void> {
    return this.manager.refreshList()
  }

  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results or a business/transport error.
   */
  // 搜索宿主的可见消息内容索引；结果只属于本次请求，列表快照仍是元数据权威。
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.manager.search(query, signal)
  }

  /**
   * Apply one Session Controller live-control frame.
   * @param frame - baseline or live control replacement.
   */
  // 应用一帧会话控制器的实时控制帧（基线或更新）。
  handleControlFrame(frame: Parameters<SessionManager['handleControlFrame']>[0]): void {
    this.manager.handleControlFrame(frame)
  }

  /**
   * Apply one remotely forwarded Session-list addition.
   * @param summary - current Host summary for the added Session.
   */
  // 应用一帧远程转发的会话新增。
  handleSessionAdded(summary: Parameters<SessionManager['handleSessionAdded']>[0]): void {
    this.manager.handleSessionAdded(summary)
  }

  /**
   * Apply one remotely forwarded Session removal.
   * @param sessionId - removed Session identity.
   */
  // 应用一帧远程转发的会话移除。
  handleSessionRemoved(sessionId: Parameters<SessionManager['handleSessionRemoved']>[0]): void {
    this.manager.handleSessionRemoved(sessionId)
  }

  /**
   * Apply one remotely forwarded running-state change.
   * @param args - Session identity and current Agent running state.
   */
  // 应用一帧远程转发的运行态变化。
  handleSessionStatus(...args: Parameters<SessionManager['handleSessionStatus']>): void {
    this.manager.handleSessionStatus(...args)
  }

  /**
   * Apply one remotely forwarded list-activity change.
   * @param args - Session identity and durable activity timestamp.
   */
  // 应用一帧远程转发的列表活跃度变化。
  handleSessionActivity(...args: Parameters<SessionManager['handleSessionActivity']>): void {
    this.manager.handleSessionActivity(...args)
  }

  /**
   * Apply one remotely forwarded Agent failure.
   * @param args - Session identity and caller-visible failure description.
   */
  // 应用一帧远程转发的 Agent 失败。
  handleSessionError(...args: Parameters<SessionManager['handleSessionError']>): void {
    this.manager.handleSessionError(...args)
  }

  // 连接（重连）后重建会话基线与所有已打开的事件窗口。
  /** Rebuild the Session baseline and every opened window after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  /**
   * Create a Host Session and publish its catalog row before resolving.
   * Callers retain the returned identity before borrowing its binding.
   * @param opts - target workspace or directory, an optional blank Session to reuse, and an optional Agent preset.
   * @returns the created or reused session id.
   * @throws {SessionCreateError} with the requested id.
   */
  // 创建宿主会话：解析前先发布目录行；失败抛出携带请求 id 的结构化错误。
  async create(opts: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
  } = {}): Promise<SessionId> {
    // 委托管理器创建。
    const result = await this.manager.create(opts)
    if (!result.ok) throw new SessionCreateError(result.error, opts.sessionId)
    // 创建成功后重新投影列表。
    this.projectList()
    return result.value.sessionId
  }

  /**
   * Fork a session from an exact inclusive prefix of the source (same
   * synchronous-addressability guarantee as {@link ClientSessions.create}:
   * on resolution the child is catalogued and may be explicitly retained).
   * @param opts - source session id, the optional exact inclusive boundary
   *   seq (a real event seq the caller already knows; a cut inside an open
   *   turn is balanced Host-side with synthetic closers, and omission selects
   *   the latest completed-turn prefix), and whether to increment an
   *   inherited durable title, skipping numbers Host-listed titles already use,
   *   before resolving, plus permission to start source migration.
   * @returns the child session id.
   * @throws {SessionForkError} with the source id.
   * @throws {Error} when a requested child-title rename fails after creation.
   */
  // 从源会话的精确前缀分叉；解析时子会话已入目录，可显式保留。
  async fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
    onCreated?: (childId: SessionId) => void
    allowMigration?: boolean
  }): Promise<SessionId> {
    // 需要递增标题时，先取源会话的持久标题。
    const sourceTitle = opts.increaseTitle
      ? this.list.getSnapshot().byId[opts.sessionId]?.title
      : undefined
    // 委托管理器分叉。
    const result = await this.manager.fork({
      sessionId: opts.sessionId,
      ...(opts.atSeq === undefined ? {} : { atSeq: SessionSeq(opts.atSeq) }),
      ...(opts.allowMigration === undefined ? {} : { allowMigration: opts.allowMigration }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    // 分叉成功后重新投影列表。
    this.projectList()
    // 取子会话 id。
    const childId = result.value.sessionId
    // 通知调用方子会话已创建。
    opts.onCreated?.(childId)
    if (sourceTitle !== undefined) {
      // 收集宿主列表中已被占用的持久标题。
      const list = this.list.getSnapshot()
      const taken = new Set(list.ids.flatMap(id => list.byId[id]?.title ?? []))
      // 为子会话重命名：递增编号直到未被占用。
      const renamed = await this.manager.rename(childId, increasedForkTitle(sourceTitle, taken))
      if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
    }
    return childId
  }

  /**
   * Borrow an already-retained Agent-scoped Context.
   * @param id - session id (the agent identity — 1:1 same axis).
   * @returns the scoped Context, or undefined without a retained generation.
   */
  // 借用已保留的 Agent 作用域上下文；无保留世代时返回 undefined。
  scope(id: SessionId): AgentContext | undefined {
    return this.scopes.get(id)?.ctx
  }

  /**
   * Retain a validated Gateway identity synchronously, without history or catalog I/O.
   * @param id - Host-projected Session identity, possibly not yet catalogued.
   * @returns a Gateway-source reference owned by the invocation.
   */
  // 同步保留一个已校验的 Gateway 身份：不做历史或目录 I/O。
  retainAgentScope(id: SessionId): SessionReference {
    if (this.closed) throw new Error('Session Controller is disposed')
    // 以 gateway 来源登记保留。
    return this.retainScope(id, 'gateway')
  }

  /**
   * Read the Agent scope tag off a context. Service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions — a cross-bundle
   * value import of the standalone helper would inline a second module
   * instance whose private tag Symbol never matches.
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  // 从上下文读取 Agent 作用域标记；必须是服务方法边界，保证私有 tag Symbol 一致。
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeTagOf(ctx)
  }

  /**
   * Resolve the business Session behind an Agent-scoped context — the one
   * hop every scoped consumer (event listeners, per-session controllers)
   * takes from ctx-space into object-space (the client mirror of host
   * `agent.session`). Same service-method boundary as
   * {@link ClientSessions.scopeOf}.
   * @param ctx - an Agent-scoped context.
   * @returns the matching live Session, or undefined for an untagged or ended generation.
   */
  // 解析 Agent 作用域上下文背后的业务 Session：ctx 空间到对象空间的一跳。
  sessionOf(ctx: Context): SessionFace | undefined {
    // 先读作用域标记。
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    // 取对应作用域记录。
    const record = this.scopes.get(id)
    // 身份一致才返回其会话（防止旧世代串扰）。
    return record !== undefined && scopeIdentityOf(record.ctx) === scopeIdentityOf(ctx)
      ? record.binding.session
      : undefined
  }

  /**
   * Borrow an already-retained binding without extending its lifetime.
   * @param id - Session identity.
   * @returns the live binding, or undefined without a retained generation.
   */
  // 借用已保留的绑定而不延长其生命周期。
  binding(id: SessionId): SessionBinding | undefined {
    return this.scopes.get(id)?.binding
  }

  // 登记作用域保留：递增引用计数与来源计数，返回新引用。
  private retainScope(id: SessionId, source: SessionReferenceSource): ClientSessionReference {
    // 取既有记录或物化新作用域。
    const record = this.scopes.get(id) ?? this.materializeScope(id)
    // 取保留前值。
    const previous = record.retention
    // 计入本次引用与来源。
    record.retention = Object.freeze({
      referenceCount: previous.referenceCount + 1,
      retainedBy: freezeRetainedBy({ ...previous.retainedBy, [source]: (previous.retainedBy[source] ?? 0) + 1 }),
    })
    // 创建引用：释放回调负责归还计数并可能退休作用域。
    const reference = new ClientSessionReference(id, record, () => {
      // 记录已不存活：无需处理。
      if (!record.live) return
      // 递减总引用数。
      const count = record.retention.referenceCount - 1
      const { [source]: sourceCount = 0, ...otherSources } = record.retention.retainedBy
      // 该来源还有剩余引用则递减，否则整项移除。
      const retainedBy = sourceCount > 1 ? { ...otherSources, [source]: sourceCount - 1 } : otherSources
      record.retention = count === 0
        ? EMPTY_RETAIN_INFO
        : Object.freeze({ referenceCount: count, retainedBy: freezeRetainedBy(retainedBy) })
      if (count === 0) this.retireScope(id, record)
      else this.publishRetention(id)
    })
    // 保留了一个目录中不存在但可寻址的子代理：立即补投影。
    if (this.list.getSnapshot().byId[id] === undefined && this.manager.subagentAddress(id) !== undefined) {
      this.projectList()
    }
    // 发布保留变化。
    this.publishRetention(id)
    return reference
  }

  // 读取保留快照：无记录时回退到空保留信息。
  private retentionSnapshot(id: SessionId): SessionRetainInfo {
    return this.scopes.get(id)?.retention ?? EMPTY_RETAIN_INFO
  }

  // 发布保留信息变化：更新列表行并通知观察者。
  private publishRetention(id: SessionId): void {
    // 取当前列表状态。
    const state = this.list.getSnapshot()
    const row = state.byId[id]
    const retainedBy = this.retentionSnapshot(id).retainedBy
    if (row !== undefined && row.retainedBy !== retainedBy) {
      // 行存在且保留信息变化：不可变更新该行。
      this.list.set({ ...state, byId: { ...state.byId, [id]: { ...row, retainedBy } } })
    }
    // 同步独立观察者。
    const observer = this.retainObservers.get(id)
    const snapshot = this.retentionSnapshot(id)
    if (observer === undefined || observer.published === snapshot) return
    observer.published = snapshot
    notifySubscribers(observer.listeners, '[session-controller] reference sources')
  }

  // 退休作用域：解除存活标志、解绑会话并启动异步销毁。
  private retireScope(id: SessionId, record: ScopeRecord, disposeFiber = true): void {
    // 幂等：已退休则忽略。
    if (!record.live) return
    record.live = false
    // 若映射中仍是该记录则移除。
    if (this.scopes.get(id) === record) this.scopes.delete(id)
    // 解绑作用域上下文。
    record.session.unbindScope()
    // 启动会话对象销毁。
    const sessionDisposal = this.manager.drop(id, record.session)
    // 重新投影列表与保留信息。
    this.projectList()
    this.publishRetention(id)
    // 启动作用域的异步销毁。
    this.startScopeDrop(id, record, disposeFiber, sessionDisposal)
  }

  // 物化作用域：调用方已确认该 id 可被寻址之后才会到达。
  /** Materialize one scope after its caller establishes that the id may be addressed. */
  private materializeScope(id: SessionId): ScopeRecord {
    // 在根上下文下创建代理作用域。
    const { fiber, ctx } = createScope(this.rootCtx, id)
    // 取会话对象。
    const session = this.manager.get(id)
    // The Session owns its scoped dispatch point (host Agent.loopCtx mirror);
    // mint and bind are one step so a live scope record implies a bound actx.
    // Session 拥有自己的作用域分发点（宿主 Agent.loopCtx 的镜像）；
    // 铸造与绑定一步完成，存活记录即意味着 actx 已绑定。
    session.bindScope(ctx)
    // 构建绑定。
    const binding: SessionBinding = { sessionId: id, session, eventSource: session.eventSource, ctx }
    // 构建作用域记录。
    const record: ScopeRecord = {
      fiber,
      ctx,
      binding,
      session,
      retention: EMPTY_RETAIN_INFO,
      live: true,
    }
    // 登记进映射。
    this.scopes.set(id, record)
    // 作用域自身销毁时退休记录（不再重复销毁纤维）。
    ctx.effect(() => () => { this.retireScope(id, record, false) }, 'session-controller: exact generation')
    return record
  }

  // 把管理器的列表快照投影进存储；标题推导只影响展示。
  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    // 取上一次快照的行集合用于回退。
    const previousById = this.list.getSnapshot().byId
    const {
      items, phase, projectionsBySession,
    } = this.manager.getListSnapshot()
    // 重建 id 顺序与行映射。
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      // 维护宿主列表顺序。
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        // 推导展示标题。
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        // 取本地保留计数。
        retainedBy: this.retentionSnapshot(entry.sessionId).retainedBy,
        blank: entry.blank,
        updatedAt: entry.updatedAt,
        formatStatus: entry.formatStatus,
        ...(entry.projectionValues === undefined
          ? {}
          : { projectionValues: entry.projectionValues }),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      }
    }
    // 合并子代理目录：给子会话补行或更新标题。
    for (const [parentId, projection] of Object.entries(projectionsBySession)) {
      for (const child of projection.values.subagentCatalog ?? []) {
        // 外部（external）子代理不进列表。
        if (child.mode === 'external') continue
        const childId = child.id
        const summary = byId[childId]
        // 取投影值：行上已有则复用，否则向管理器查询。
        const projectionValues = summary?.projectionValues ?? this.manager.projectionValues(childId)
        // 投影出的标题（非空字符串才有效）。
        const projectedTitle = projectionValues?.title
        const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : undefined
        const displayTitle = title ?? child.label ?? childId
        if (summary === undefined) {
          // 目录中无此行：新建子代理回退行。
          byId[childId] = {
            id: childId, displayTitle, parentId: parentId as SessionId,
            origin: 'subagent', running: this.scopes.get(childId)?.session.getSnapshot().running ?? false, blank: false, updatedAt: 0,
            retainedBy: this.retentionSnapshot(childId).retainedBy,
            ...(projectionValues === undefined ? {} : { projectionValues }),
            ...(title === undefined ? {} : { title }),
          }
        } else if (summary.displayTitle !== displayTitle || summary.projectionValues !== projectionValues) {
          // 已有行但标题或投影值变化：原地更新这两个字段。
          byId[childId] = {
            ...summary,
            displayTitle,
            ...(projectionValues === undefined ? {} : { projectionValues }),
          }
        }
      }
    }
    // 补充"已保留但不在目录"的子代理行。
    for (const [id, record] of this.scopes) {
      // 目录已有行则跳过。
      if (byId[id] !== undefined) continue
      // 只处理可寻址的子代理。
      const address = this.manager.subagentAddress(id)
      if (address === undefined) continue
      // 取上一快照的旧行作回退。
      const previous = previousById[id]
      // 取会话当前快照。
      const snapshot = record.session.getSnapshot()
      const projectionValues = this.manager.projectionValues(id)
      const projectedTitle = projectionValues?.title
      const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : previous?.title
      byId[id] = {
        ...(previous ?? { id, displayTitle: id, updatedAt: 0 }),
        running: snapshot.running,
        retainedBy: record.retention.retainedBy,
        blank: snapshot.blank,
        parentId: address.parentSessionId,
        origin: 'subagent',
        ...(projectionValues === undefined ? {} : { projectionValues }),
        ...(title === undefined ? {} : { title, displayTitle: title }),
      }
    }
    // 整体写入新快照。
    this.list.set({ ids, byId, phase, projectionsBySession })
  }

  // 启动一次作用域销毁：登记 Promise 并在结算后自动移出集合。
  private startScopeDrop(
    id: SessionId,
    record: ScopeRecord,
    disposeFiber = true,
    sessionDisposal = this.manager.drop(id, record.session),
  ): void {
    const drop = this.dropScope(record, disposeFiber, sessionDisposal)
    this.scopeDrops.add(drop)
    void drop.then(
      () => { this.scopeDrops.delete(drop) },
      () => { this.scopeDrops.delete(drop) },
    )
  }

  // 等待全部在途作用域销毁收敛（循环以覆盖期间新增的销毁）。
  private async drainScopeDrops(): Promise<void> {
    while (this.scopeDrops.size > 0) {
      await Promise.allSettled([...this.scopeDrops])
    }
  }

  // 等待已撤回的 Session 与作用域清理全部落定。
  /** Await the already-withdrawn Session and scoped cleanup to quiescence. */
  private async dropScope(
    record: ScopeRecord,
    disposeFiber: boolean,
    sessionDisposal: Promise<void>,
  ): Promise<void> {
    // 并行等待会话销毁与（可选的）纤维销毁，失败也吞掉。
    await Promise.allSettled([sessionDisposal, ...disposeFiber ? [record.fiber.dispose()] : []])
  }
}
