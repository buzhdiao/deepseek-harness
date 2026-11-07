// 对外的 sessions 服务门面：即 ctx.sessions 暴露给功能包的能力面；传输入口与实现内部都留在具体类上。
/**
 * The outward sessions-service face — what `ctx.sessions` exposes to feature
 * packages. Transport entry points and implementation internals stay on
 * the concrete class. Widening this interface is the
 * explicit act of widening what features may do to the sessions domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentContext } from '../scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type { SessionBinding, SessionListState } from '../sessions/service.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionReferenceSource } from '../index.ts'

export type { AgentContext } from '../scope.ts'

// 已知的 Session 身份，或持久的直接父级 subagent 地址；地址本身不拥有生命周期。
/** Known Session identity or durable direct-parent subagent address; an address owns no lifetime. */
export type SessionTarget = SessionId | SubagentAddress

// 一次独立使用某个精确 Client 代（generation）的引用，不持有 Host Agent 所有权。
/** One independent use of an exact Client generation, without Host Agent ownership. */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  // 共享绑定；引用释放或代销毁后访问会失败。
  /** Shared binding; access fails after reference release or generation disposal. */
  readonly binding: SessionBinding
  // 本引用可取消的等待：共享的首次 Session.open() 尝试落定。
  /** This reference's cancellable wait for the shared initial `Session.open()` attempt to settle. */
  readonly ready: Promise<SessionBinding>
  // 只能释放一次；最后一个引用会启动本地 scope 与历史拆除。
  /** Release once; the final reference starts local scope and history teardown. */
  release(): void
}

// 一次获取等待的消费者身份与可选取消。
/** Consumer identity and optional cancellation of one acquisition waiter. */
export interface SessionRetainOptions {
  // 消费者来源标签。
  readonly source: SessionReferenceSource
  // 可选的等待取消信号。
  readonly signal?: AbortSignal | undefined
}

// 本地所有权计数，独立于目录成员关系，绝不持久化。
/** Local ownership counts, independent of catalog membership and never persisted. */
export interface SessionRetainInfo {
  // 当前引用总数。
  readonly referenceCount: number
  // 只统计正数的来源；没有引用的来源不出现。
  /** Positive source counts only; a source without references is absent. */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

// 注入为 ctx.sessions 的 sessions 服务门面。
/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  // Host 目录与本地引用来源计数；导航归视图所有者管。
  /** Host catalog and local reference-source counts; navigation belongs to view owners. */
  readonly list: ObservableSnapshot<SessionListState>
  // 保留一个精确 Client 代并启动其共享的首次历史打开；返回值立即持有，需要等待首次打开落定时再 await reference.ready。
  /**
   * Retain an exact Client generation and start its shared initial history opening.
   * @param target - known identity or durable direct-parent address.
   * @param options - required consumer source and optional independent waiter cancellation.
   * @returns an owned reference immediately; await `reference.ready` when the initial open attempt must settle first.
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  // 在回调结算期间持有引用，覆盖同步与异步失败路径；获取与回调失败原样传播。
  /**
   * Hold one reference through callback settlement, including synchronous and asynchronous failures.
   * @param target - Session to acquire.
   * @param options - source and acquisition cancellation.
   * @param operation - callback using the reference only until its returned value or Promise settles.
   * @returns the callback result after release; acquisition and callback failures propagate unchanged.
   */
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  // 只观察本地引用计数：不保留、不建 scope、不打开历史；同 id 各代之间身份保持稳定，直到 Client 根销毁前始终存在。
  /**
   * Observe local reference counts without retaining, creating a scope, or opening history.
   * The returned source keeps stable identity across same-id generations and remains allocated
   * until the Client root is disposed, even after its final subscriber leaves.
   * @param id - explicit Session identity; Host existence is not implied.
   * @returns a stable read-only source across same-id generations, with zero counts when none is live.
   */
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  // 由线协议（wire schema）固定的 session.search 结果上限，作为注入数据暴露给呈现层；不是按连接的状态：所有传输（含 fixture）报告同一个数。
  /**
   * The `session.search` result bound the wire schema fixes, exposed to
   * presentation as injected data. Not per-connection state: every transport
   * (fixture included) reports the same number.
   */
  readonly searchResultLimit: number
  // 在 Host 上为新会话创建 Session：同名空白会话仍可复用则复用，否则另建；会话运行指定预设，未指定则用 Host 默认。
  /**
   * Create a Session for a new conversation on the Host. The Host reuses the
   * named blank Session while it is reusable and otherwise creates another; the
   * Session runs the named preset, or the Host default when none is named.
   * @param opts - target workspace or directory, an optional blank Session to reuse, and an optional Agent preset.
   * @returns the catalogued identity the Host created or reused; retain it before borrowing its binding.
   */
  create(opts?: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
  }): Promise<SessionId>
  // 解析一个已发现的直接父级地址，但不打开它。
  /**
   * Resolve an already discovered direct-parent address without opening it.
   * @param id - possible addressed child id.
   * @returns a retained, catalog-derived, or unknown-mode listed address, without retaining a new selection or scope.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined

  // 读取投影但不启动迁移；对失败或因迁移推迟的读取可重试。
  /**
   * Read projections without starting migration; retry failed or migration-deferred reads.
   * @param sessionId - Session to inspect without opening its conversation.
   * @returns completion of the current or newly started refresh.
   */
  refreshProjections(sessionId: SessionId): Promise<void>

  // 刷新 Host 权威的 Session 列表。
  /**
   * Refresh the Host-authoritative Session list.
   * @returns completion of the current or newly started Session-list refresh.
   */
  refresh(): Promise<void>
  // 搜索 Host 可见的消息内容索引；结果只属于本次请求，列表快照仍是元数据权威。
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  // 从源的精确前缀（含边界）分叉出一个会话；解析成功后子会话进入目录，可被显式保留。
  /**
   * Fork a session from an exact inclusive prefix of the source; on
   * resolution the child is catalogued and can be explicitly retained.
   * @param opts - source session id, the optional exact inclusive boundary
   *   seq (a real event seq the caller already knows; a cut inside an open
   *   turn is balanced Host-side with synthetic closers, and omission selects
   *   the latest completed-turn prefix), and whether to increment an
   *   inherited durable title, skipping numbers Host-listed titles already use,
   *   before resolving. `onCreated` observes the catalogued child before that optional rename.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
    onCreated?: (childId: SessionId) => void
    /** False refuses source migration; omission preserves the Host default. */
    allowMigration?: boolean
  }): Promise<SessionId>
  // 借用已保留的 Agent 作用域 Context，但不延长其生命周期。
  /**
   * Borrow an already-retained Agent-scoped Context without extending its lifetime.
   * @param id - session id.
   * @returns the live scoped Context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined
  // 从 context 上读取 Agent 作用域标签（服务方法边界：fetch 包必须经 ctx.sessions 到达作用域解析）。
  /**
   * Read the Agent scope tag off a context (service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined
  // 解析 Agent 作用域 context 背后的会话门面。
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - an Agent-scoped context.
   * @returns the matching live Session, or undefined for an untagged, foreign, or ended generation.
   */
  sessionOf(ctx: Context): SessionFace | undefined
  // 借用已保留的 Session 绑定，但不延长其生命周期。
  /**
   * Borrow an already-retained Session binding without extending its lifetime.
   * @param id - session id.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined
}
