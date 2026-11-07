// Host 目录、持久投影缓存与显式保留的 Client 实例。
/** Host catalog, durable projection caches, and explicitly retained Client instances. */

import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap, SessionProjectionViewValues } from '@deepseek-ai/dsh-session-projection/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionHints,
  SessionRenameValue,
  SessionSummary,
} from '../../types.ts'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionListEntry, TitledSessionSummary } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
// Type-only merge edge: the title domain's client-namespace outlet declares
// the 'title' projection key this manager projects into list rows (and any
// useProjection('title') consumer reads). Zero value imports by construction.
import type {} from '@deepseek-ai/dsh-session-title/client'
import { Notifier } from './notifier.ts'
import { ProjectionValueStore } from './projection-store.ts'
import { Session } from './session.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionTarget } from '../contract/sessions.ts'

// 把数值转换为 SessionSeqCursor：-1 作为"无游标"哨兵透传，其余加品牌类型。
function sessionSeqCursor(value: number): SessionSeqCursor {
  return value === -1 ? -1 : SessionSeq(value)
}

// 列表到达生命周期，与拉取活动的 state 轴正交：pending（尚无成功拉取——空 items 表示"还没到达"而非"不存在"）→ ready（至少一次拉取落定）；单调不回退——后续失败与重连重拉走 state/error 轴。
/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

// 返回给侧栏搜索消费者的请求内（request-local）内容命中。
/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  // 命中的会话 id。
  sessionId: SessionId
  // 内容片段。
  snippet: string
}

// 供 useSessionList 使用的不可变会话列表快照。
/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  // 渲染顺序的列表行。
  items: readonly SessionListEntry[]
  // 拉取活动状态：idle/loading/error。
  state: 'idle' | 'loading' | 'error'
  // 到达生命周期（见 SessionListPhase）；state 仍是拉取活动轴。
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  // 最近一次拉取失败。
  error: RemoteFailure | null
  // 各会话的投影快照。
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>

}

// 存储当前持有的全部投影值（剥去摘要标记）及其显式基线读取的生命周期；这是已附加会话的完整集合，不是列表行的摘要契约（见 SessionListEntry.projectionValues）。
/**
 * Every projection value the store currently holds, with the summary mark
 * stripped, and the lifecycle of its explicit baseline read. This is the full
 * attached-Session set, not a list row's summary contract (see
 * `SessionListEntry.projectionValues`).
 */
export interface SessionProjectionSnapshot {
  // 键 → 当前值。
  readonly values: Readonly<Partial<SessionProjectionViewValues>>
  // 基线读取生命周期。
  readonly state: 'idle' | 'loading' | 'ready' | 'migration-required' | 'error'
  // 读取失败。
  readonly error: RemoteFailure | null
}

// 进行中的投影读取：promise 与取消控制器。
interface ProjectionInflight {
  readonly promise: Promise<void>
  readonly controller: AbortController
}

// 投影读取状态（不含值）。
type ProjectionLoad = Omit<SessionProjectionSnapshot, 'values'>

// 列表行变更的内部记录：立即应用，并在列表响应在途时保留以便重放。
type SessionListMutation =
  // 新增或占位：带 Host 摘要上行。
  | { kind: 'upsert' | 'placeholder'; summary: SessionSummary }
  // 整行移除。
  | { kind: 'remove'; sessionId: SessionId }
  // 运行状态变更。
  | { kind: 'status'; sessionId: SessionId; running: boolean; agentAvailable: boolean }
  // 活动时间变更。
  | { kind: 'activity'; sessionId: SessionId; updatedAt: number }
  // 本地首发翻转：发送方不等 Host 帧就清掉空白标记。
  /** Local first-send flip: the sender clears blank without waiting for a host frame. */
  | { kind: 'engaged'; sessionId: SessionId }

// 实例簇 + 帧入口 + 会话列表。
/** Instance cluster + frame entry + the session list. */
export class SessionManager {
  // 常驻会话实例（按会话 id）。
  private readonly sessions = new Map<SessionId, Session>()
  // 进行中的会话销毁在实例离开 sessions 后仍登记在此，让管理器销毁能等待静默（quiescence）。
  /** In-flight Session disposals remain here after instances leave `sessions`, so manager disposal can await quiescence. */
  private readonly sessionDisposals = new Set<Promise<void>>()
  // 已接受/运行中的呈现必须挺过此后可能到来的空历史列表响应：Host 断言的运行态先于任何持有者（行、实例、地址）登记——持有它的列表可能尚未落地；而客户端本地的接受回调要求当前确有持有者，因为它可能来自被替换或已丢弃的会话。
  /**
   * Accepted/running presentation must survive a later empty-history list
   * response. Host-asserted running is recorded even before a row, instance, or
   * address holds the identity — the listing that would hold it may not have
   * landed yet — while the client-local acceptance callback requires a current
   * holder, because it can arrive from a replaced or already-dropped Session.
   */
  private readonly engagedSessions = new Set<SessionId>()
  // 管理器是否已开始销毁。
  private disposed = false
  // 按会话的投影值存储独立于实例到达而保留（标题快照先例的推广）：推送帧落在这里，无论会话是否实例化（列表行读取 title 键）；实例化的会话采用同一存储，让历史基线播种与帧汇聚到同一行集。
  /** Per-session projection value stores, retained independently of instance arrival (the
   *  title-snapshot precedent, generalized): push frames land here whether or not the Session
   *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
   *  same store so history-baseline seeding and frames converge on one row set. */
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  // 当前目录行（合并后的 Host 摘要）。
  private summaries: SessionSummary[] = []
  // 列表拉取活动状态。
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  // 到达阶段：首次成功拉取时翻到 ready（见 SessionListPhase）。
  /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
  private listPhase: SessionListPhase = 'pending'
  // 最近一次列表拉取失败。
  private listError: RemoteFailure | null = null
  // 进行中的列表拉取（同一 Host 代内单飞）。
  private listInflight: Promise<void> | null = null
  // 当前列表请求的变更日志；其身份同时在重连后拦截过期完成。
  /** Active list request's mutation log; its identity also fences completion after reconnect. */
  private listMutations: SessionListMutation[] | null = null
  // 已解析的子代理地址（按子会话 id）。
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  // 按会话的投影读取状态。
  private readonly projectionLoads = new Map<SessionId, ProjectionLoad>()
  // 按会话的进行中投影读取。
  private readonly projectionInflight = new Map<SessionId, ProjectionInflight>()


  // 列表快照缓存（脏时惰性重建）。
  private listSnapshotCache: SessionListSnapshot
  // 行身份缓存（引用稳定性）：列表重建时逐字段比较并复用上一版行对象——线刷新铸造全新摘要对象，必须按值恢复身份，否则每个 SessionListItem 的 memo 每次刷新都失效。
  /** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh. */
  private entryCache = new Map<SessionId, SessionListEntry>()
  // 行数组的引用稳定缓存。
  private itemsCache: readonly SessionListEntry[] = []
  // 列表通知器：脏时重建快照缓存。
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  // 注入目录与历史读取所用的 Remote 命名空间。
  /** @param remote - generated Remote namespaces used by catalog and history readers. */
  constructor(private readonly remote: SessionRemotes) {
    // 构造初始空快照。
    this.listSnapshotCache = this.buildListSnapshot()
  }

  // 解析获取目标但不实例化会话。
  /**
   * Resolve an acquisition target without materializing a Session.
   * @param target - known identity or durable direct-parent address.
   * @returns the resolved identity with its explicit or catalog-derived history route installed.
   */
  resolveTarget(target: SessionTarget): SessionId {
    // 从身份或地址取出子会话 id。
    const id = typeof target === 'string' ? target : target.childSessionId
    // 字符串目标需自行解析地址；地址目标即地址本身。
    const address = typeof target === 'string' ? this.subagentAddress(id) : target
    // 字符串目标必须有据可查：实例、目录行或地址任一存在。
    if (typeof target === 'string'
      && !this.sessions.has(id)
      && !this.summaries.some(summary => summary.sessionId === id)
      && address === undefined) {
      // 无任何证据：拒绝获取。
      throw new Error(`sessions.retain: unknown session ${id}`)
    }
    // 缓存解析出的地址，供后续导航使用。
    if (address !== undefined) this.addresses.set(id, address)
    // 已有实例时同步其子代理配置。
    this.sessions.get(id)?.configureSubagent(address)
    return id
  }

  // 为面包屑导航解析地址，不取得传输权威。
  /**
   * Resolve an address for breadcrumb navigation without retaining transport authority.
   * @param sessionId - possible child id in received Session metadata.
   * @returns A retained address, then a catalog address, then an unknown-mode address
   *   from a listed subagent header; undefined without that evidence.
   */
  subagentAddress(sessionId: SessionId): SubagentAddress | undefined {
    // 优先使用已保留的地址。
    const retained = this.addresses.get(sessionId)
    // 命中即返回。
    if (retained !== undefined) return retained
    // 其次扫描各父会话的子代理目录。
    for (const parentSessionId of this.projectionStores.keys()) {
      // 在该父会话的目录里查找目标子会话。
      const child = this.projectionStores.get(parentSessionId)?.values().subagentCatalog
        ?.find(entry => entry.id === sessionId)
      // 找到且非 external 模式：构成目录来源的地址。
      if (child !== undefined && child.mode !== 'external') {
        return {
          parentSessionId,
          childSessionId: sessionId,
          mode: child.mode,
        }
      }
    }
    // 最后查 Host 列表摘要。
    const summary = this.summaries.find(summary => summary.sessionId === sessionId)
    // 非子代理或缺父 id：无地址证据。
    if (summary?.origin !== 'subagent' || summary.parentSessionId === undefined) return undefined
    // 仅凭列表头得出 unknown 模式地址。
    return {
      parentSessionId: summary.parentSessionId,
      childSessionId: sessionId,
      mode: 'unknown',
    }
  }

  // ---- 实例管理 ----
  // ---- Instance management ----

  // 在运行拆除回调之前撤销一个精确的 Client 实例。
  /**
   * Withdraw an exact Client instance before running its teardown callbacks.
   * @param sessionId - identity to withdraw.
   * @param expected - instance being released; a replacement is left untouched.
   * @returns completion of the detached instance's stream teardown.
   */
  drop(sessionId: SessionId, expected: Session): Promise<void> {
    // 取常驻实例。
    const session = this.sessions.get(sessionId)
    // 已被替换：本次释放无事可做。
    if (session !== expected) return Promise.resolve()
    // 撤销常驻。
    this.sessions.delete(sessionId)
    // 一并撤销其地址。
    this.addresses.delete(sessionId)
    // 无持有者时遗忘其参与标记。
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    // 启动并跟踪流拆除。
    return this.startSessionDisposal(session)
  }

  // 停止目录请求并销毁所有常驻会话。
  /**
   * Stop catalog requests and dispose every resident Session.
   * @returns once catalog requests and every Session stream have stopped.
   */
  async dispose(): Promise<void> {
    // 标记销毁开始。
    this.disposed = true
    // 丢弃待重放的列表变更。
    this.listMutations = null
    // 丢弃进行中的拉取。
    this.listInflight = null
    // 清空参与账本。
    this.engagedSessions.clear()
    // 快照进行中的投影读取。
    const reads = [...this.projectionInflight.values()]
    // 全部取消。
    for (const { controller } of reads) controller.abort()
    // 清空登记。
    this.projectionInflight.clear()
    // 等待取消后的读取落定。
    await Promise.all(reads.map(read => read.promise))
    // 快照常驻实例。
    const sessions = [...this.sessions.values()]
    // 清空常驻表。
    this.sessions.clear()
    // 清空地址表。
    this.addresses.clear()
    // 逐个启动销毁（不逐个等待）。
    for (const session of sessions) void this.startSessionDisposal(session)
    // 等待全部销毁静默。
    await this.drainSessionDisposals()
  }

  // 启动会话销毁并登记，便于管理器销毁时统一等待。
  private startSessionDisposal(session: Session): Promise<void> {
    // 发起销毁。
    const disposal = session.dispose()
    // 登记到在途集合。
    this.sessionDisposals.add(disposal)
    // 落定（成功或失败）后移出集合。
    void disposal.then(
      () => { this.sessionDisposals.delete(disposal) },
      () => { this.sessionDisposals.delete(disposal) },
    )
    // 返回销毁 promise 供调用方等待。
    return disposal
  }

  // 循环等待，直到在途销毁集合清空（等待期间可能新增）。
  private async drainSessionDisposals(): Promise<void> {
    while (this.sessionDisposals.size > 0) {
      // 等待当前全部落定（失败也不中断）。
      await Promise.allSettled([...this.sessionDisposals])
    }
  }

  // 惰性构建：返回既有实例或新建（不自动打开——引用分配器在绑定作用域后打开历史）；新实例返回前调和保留的元数据。
  /**
   * Lazy build: return the existing instance or construct one (no auto-open —
   * the reference allocator opens history after binding the scope).
   * New instances reconcile retained metadata before returning.
   * @param sessionId - the session to get.
   * @returns the resident instance.
   */
  get(sessionId: SessionId): Session {
    // 先查常驻。
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      // 构造实例。
      session = this.createSession(sessionId)
      // 登记常驻。
      this.sessions.set(sessionId, session)
      // Sync the running and blank bits from the list snapshot into the new
      // instance (consistency when the list precedes open).
      // 把列表快照中的运行/空白位同步进新实例（列表先于 open 时的一致性）。
      // 查目录行。
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) {
        // 有目录行：以其为准同步。
        // 同步空白位（考虑本地参与标记）。
        session.handleBlank(this.effectiveBlank(summary))
        // 同步运行位。
        session.handleRunning(summary.running)
      } else {
        // 无目录行：查子代理地址。
        const address = this.addresses.get(sessionId)
        // 尝试从父会话的子代理目录定位该会话。
        const child = address === undefined ? undefined : this.projectionStores.get(address.parentSessionId)?.values().subagentCatalog
          ?.find(entry => entry.id === sessionId)
        if (child !== undefined && child.mode !== 'external') {
          // A catalogued child exists only after its delegated session has
          // durable history, even though child rows do not carry `blank`.
          // 已编目的子会话只在其委派会话有持久历史后才出现，即使子行不带 blank。
          // 非空白。
          session.handleBlank(false)
          // 未运行。
          session.handleRunning(false)
        } else {
          // Retained metadata may have notified before this Session existed.
          // 保留的元数据可能在本实例存在前就通知过：默认视为空白。
          session.handleBlank(true)
        }
      }
    }
    return session
  }

  // 构造会话实例并挂上管理器回调。
  private createSession(sessionId: SessionId): Session {
    // 读取已解析的子代理地址。
    const address = this.addresses.get(sessionId)
    // 构造会话：传入可选地址与回调。
    return new Session(sessionId, this.remote, {
      ...(address === undefined ? {} : { address }),
      // The sender's local first-send flip mirrors into the list row so the
      // session surfaces (lists filter on blank) before any host frame lands.
      // 发送方的本地首发翻转镜像进列表行，让会话在任何 Host 帧落地前就浮现（列表按空白过滤）。
      onEngaged: (engaged) => {
        // 已销毁或该身份不再被任何行/实例/地址持有：忽略。
        if (this.disposed || !this.retainedIds(this.summaries).has(engaged.sessionId)) return
        // An identity already on the ledger needs no second row mutation.
        // 已在账本上的身份无需二次行变更。
        if (!this.engagedSessions.has(engaged.sessionId)) {
          // 登记参与。
          this.engagedSessions.add(engaged.sessionId)
          // 记录列表变更（清空白）。
          this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId })
        }
        // 同步常驻实例的空白位。
        this.sessions.get(engaged.sessionId)?.handleBlank(false)
      },
      // 注入（共享的）按会话投影存储。
      projections: this.projectionStore(sessionId),
    })
  }

  // 计算展示空白位：目录空白位且本地未参与首发。
  private effectiveBlank(summary: SessionSummary): boolean {
    // 参与过首发的会话不再显示为空白。
    return summary.blank && !this.engagedSessions.has(summary.sessionId)
  }

  // 一次参与仍可能属于的身份集合：给定列表行、常驻实例与保留的子地址。
  /**
   * Identities an engagement may still belong to: the given list rows, resident
   * Session instances, and retained child addresses.
   * @param summaries - list rows of the caller's snapshot.
   * @returns the retained identity set.
   */
  private retainedIds(summaries: readonly SessionSummary[]): Set<SessionId> {
    // 从列表行收集。
    const retained = new Set(summaries.map(summary => summary.sessionId))
    // 加上常驻实例的身份。
    for (const sessionId of this.sessions.keys()) retained.add(sessionId)
    // 加上保留地址的身份。
    for (const sessionId of this.addresses.keys()) retained.add(sessionId)
    return retained
  }

  // 遗忘不再被任何保留身份持有的参与标记。
  /**
   * Forget one engagement that no retained identity holds.
   * @param sessionId - identity whose engagement may be dropped.
   * @param retained - identities from {@link retainedIds} for the caller's snapshot.
   */
  private pruneEngagement(sessionId: SessionId, retained: ReadonlySet<SessionId>): void {
    // 无持有者：删除。
    if (!retained.has(sessionId)) this.engagedSessions.delete(sessionId)
  }

  // 常驻的按会话投影存储（按需创建；比实例化更长寿）。
  /** Resident per-session projection store (create-on-demand; outlives instantiation). */
  private projectionStore(sessionId: SessionId): ProjectionValueStore {
    // 先查缓存。
    let store = this.projectionStores.get(sessionId)
    if (store === undefined) {
      // 未创建则新建。
      store = new ProjectionValueStore()
      // 闭包内使用的别名。
      const projections = store
      // 订阅任意键变更。
      store.subscribeAny(() => {
        // Newer history or control metadata corrects a resident Session's stale list hint.
        // 更新的历史或控制元数据修正常驻会话的过期列表提示。
        if (projections.values().sessionListMetadata?.blank === false) {
          // 元数据断言非空白：清掉常驻实例的空白位。
          this.sessions.get(sessionId)?.handleBlank(false)
        }
        // 列表行读取投影值：标记列表重建。
        this.notifier.markDirty()
      })
      // 缓存存储。
      this.projectionStores.set(sessionId, store)
    }
    return store
  }

  // 读取投影但不启动迁移；失败或因迁移推迟的读取可重试。
  /**
   * Read projections without starting migration; retry failed or migration-deferred reads.
   * @param sessionId - Session to inspect without opening its conversation.
   * @returns completion of the current or newly started read.
   */
  refreshProjections(sessionId: SessionId): Promise<void> {
    // 已有进行中的读取：直接复用。
    const existing = this.projectionInflight.get(sessionId)
    if (existing !== undefined) return existing.promise
    // 已就绪：无需重读。
    if (this.projectionLoads.get(sessionId)?.state === 'ready') return Promise.resolve()
    // 新建取消控制器。
    const controller = new AbortController()
    // 取（或建）该会话的存储。
    const store = this.projectionStore(sessionId)
    // 记录读取前的值快照，用于判定"缺失"结论是否仍然成立。
    const initialValues = store.values()
    // 进入加载状态。
    this.projectionLoads.set(sessionId, { state: 'loading', error: null })
    // 通知列表快照更新。
    this.notifier.markDirty()
    // 读取主体（异步 IIFE）。
    const operation = (async () => {
      try {
        // 发起投影读取。
        const result = await this.remote.session.projections({ sessionId }, controller.signal)
        // 已取消：直接返回，不更新状态。
        if (controller.signal.aborted) return
        if (result.ok) {
          const value = result.value
          // Host 返回了投影数据。
          if (value !== null) {
            switch (value.kind) {
              case 'sequenced':
                // sequenced：按一致性切点播种。
                store.seed({ values: value.values, asOfSeq: sessionSeqCursor(value.asOfSeq) })
                break
              case 'migration-required':
                // 迁移未完成：只作 cached 填充。
                store.applyCached(value.values)
                break
              default:
                // 未知分支：编译期穷尽性保护。
                assertNever(value, 'session projections result')
            }
          } else if (store.values() === initialValues) {
            // A later frame proves existence independently of an earlier missing read.
            // 返回 null（缺失）且期间没有任何新值落地：清空旧代残留——后续帧可以独立于早先的缺失读证明存在。
            store.clear()
          }
          // 记录读取结果状态（迁移未完成则保持 migration-required）。
          this.projectionLoads.set(sessionId, {
            state: value?.kind === 'migration-required' ? 'migration-required' : 'ready',
            error: null,
          })
        } else {
          // 业务失败：记录错误状态。
          this.projectionLoads.set(sessionId, { state: 'error', error: result.error })
        }
      } catch (error: unknown) {
        // 已取消：静默返回。
        if (controller.signal.aborted) return
        // 非远端失败（编程错误）：继续抛出。
        if (!isRemoteFailure(error)) throw error
        // 远端失败：记录错误状态。
        this.projectionLoads.set(sessionId, { state: 'error', error })
      } finally {
        if (!controller.signal.aborted) {
          // 未被取消：清排在途登记并刷新快照。
          this.projectionInflight.delete(sessionId)
          this.notifier.markDirty()
        }
      }
    })()
    // 登记在途读取（单飞）。
    this.projectionInflight.set(sessionId, { promise: operation, controller })
    return operation
  }

  // ---- 列表 API ----
  // ---- List API ----

  // 通过 session.list 全量刷新（同一 Host 代内单飞）。
  /** Full refresh via session.list (single-flight within one Host generation). */
  refreshList(): Promise<void> {
    // 已有进行中的拉取：复用其 promise。
    if (this.listInflight !== null) return this.listInflight
    // 进入加载状态。
    this.listState = 'loading'
    // 清除旧错误。
    this.listError = null
    // 记录既有的目录行（基线合并基准）。
    const established = this.summaries
    // 本轮请求的变更日志。
    const mutations: SessionListMutation[] = []
    // 挂到实例上：拉取期间的即时变更记入日志，日志身份同时拦截过期完成。
    this.listMutations = mutations
    // 通知 loading 态。
    this.notifier.markDirty()
    // 拉取主体。
    this.listInflight = (async () => {
      try {
        // 发起列表拉取。
        const result = await this.remote.session.list({})
        // 日志身份已变（重连或新请求）：本次结果作废。
        if (this.listMutations !== mutations) return
        if (result.ok) {
          // 首次拉取直接采用 Host 顺序；之后按稳定基线合并，避免可见顺序跳动。
          const baseline: SessionSummary[] = this.listPhase === 'pending'
            ? [...result.value.items]
            : mergeOrderedBaseline(established, result.value.items, summary => summary.sessionId)
          // A removal supersedes running observed in the pull, including after re-addition.
          // 移除事件优先于拉取中观察到的运行态，包括重新添加之后。
          // 收集拉取期间发生的移除。
          const removedSincePull = new Set<SessionId>()
          // 扫描变更日志。
          for (const mutation of mutations) {
            // 记录被移除的身份。
            if (mutation.kind === 'remove') removedSincePull.add(mutation.sessionId)
          }
          // 把拉取结果中的运行态并入参与账本。
          for (const s of baseline) {
            // 运行中且未被移除：登记参与。
            if (s.running && !removedSincePull.has(s.sessionId)) this.engagedSessions.add(s.sessionId)
          }
          // 重放变更日志，得到最终目录行。
          const summaries = mutations.reduce(applyMutation, baseline)
          // 提交目录行。
          this.summaries = summaries
          // A full list can remove identities without a removal frame.
          // 全量列表可能在没有移除帧的情况下删掉身份。
          // 计算新的保留身份集合。
          const retained = this.retainedIds(summaries)
          // 清理失效的参与标记。
          for (const sessionId of this.engagedSessions) this.pruneEngagement(sessionId, retained)
          // 回到空闲。
          this.listState = 'idle'
          // 到达 ready 阶段（单调）。
          this.listPhase = 'ready'

          // Resident Sessions and list rows share one display blank, reconciled with the metadata projection.
          // 常驻会话与列表行共享同一展示空白位，并与元数据投影调和。
          for (const s of this.summaries) {
            // 取常驻实例。
            const session = this.sessions.get(s.sessionId)
            // 未实例化：跳过。
            if (session === undefined) continue
            // 同步空白位。
            session.handleBlank(this.effectiveBlank(s))
            // 同步运行位。
            session.handleRunning(s.running)
          }
          // Land each row's projection block in the per-session value store
          // (cold titles surface without opening the session). A list block is
          // partial — only the keys its source holds — so an absent key never
          // clears; how the present keys merge depends on the block's kind.
          // 把每行的投影块落进按会话的值存储（冷标题无需打开会话即可显示）；列表块是部分的——只含其来源持有的键，缺失键绝不清值，合并方式取决于块的类型。
          for (const s of result.value.items) {
            // 逐行应用其投影块。
            if (s.projections !== undefined) this.applyListBlock(s.sessionId, s.projections)
          }
        } else {
          // 业务失败：记录错误态。
          this.listState = 'error'
          this.listError = result.error
        }
      } catch (error) {
        // 非远端失败（编程错误）：继续抛出。
        if (!isRemoteFailure(error)) throw error
        // 日志身份已变：结果作废。
        if (this.listMutations !== mutations) return
        // 远端失败：记录错误态。
        this.listState = 'error'
        this.listError = error
      } finally {
        if (this.listMutations === mutations) {
          // 仍为本轮请求：清排单飞状态并刷新快照。
          this.listMutations = null
          this.listInflight = null
          this.notifier.markDirty()
        }
      }
    })()
    return this.listInflight
  }

  // 搜索可见的会话消息内容，不给列表快照添加临时查询状态。
  /**
   * Search visible session message content without adding transient query
   * state to the list snapshot.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for superseded UI queries.
   * @returns the Host result or a folded transport error.
   */
  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    // 转发 Host 搜索。
    const result = await this.remote.session.search({ query }, signal)
    // 失败原样透传。
    if (!result.ok) return result
    // 拷贝结果数组：请求本地数据不与 Host 响应共享引用。
    return {
      ok: true,
      value: {
        items: [...result.value.items],
        hasMore: result.value.hasMore,
      },
    }
  }

  // 契约 session.create；成功后立即合并进目录（不等下次刷新）；新建会话按定义是空白（实体诞生先于第一条消息）。
  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh). A created session is blank by definition
   * (entity birth precedes the first message).
   * @param opts - target workspace or working directory, an optional blank Session to reuse, and an optional Agent preset.
   * @returns the create result, naming the Session the Host created or reused.
  */
  async create(
    opts: {
      workspaceId?: WorkspaceId
      cwd?: string
      sessionId?: SessionId
      agentPreset?: string
    } = {},
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    // 组装公共字段：可选的会话 id 复用与 Agent 预设。
    const shared = {
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      ...(opts.agentPreset === undefined ? {} : { agentPreset: opts.agentPreset }),
    }
    // 按 workspaceId 或 cwd 二选一构造载荷。
    const payload = opts.workspaceId !== undefined
      ? { workspaceId: opts.workspaceId, ...shared }
      : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared }
    // 发起创建。
    const result = await this.remote.session.create(payload)
    if (result.ok) {
      // 立即插入占位行（空白、未运行），让会话在下次刷新前可见。
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      } })
    } else {
      // 从附着失败错误中提取已发布的会话 id。
      const publishedSessionId = workspaceAttachSessionId(result.error)
      // Publication precedes attachment. The error's id is a real Session,
      // so expose it immediately as Ungrouped while the caller keeps the
      // prompt buffer and decides whether to retry attachment.
      // 发布先于附着。错误里的 id 是真实会话：立即以"未分组"暴露它，调用方保留输入缓冲并决定是否重试附着。
      if (publishedSessionId !== undefined) {
        // 插入已发布但未附着的占位行。
        this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
          sessionId: publishedSessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
        } })
      }
    }
    return result
  }

  // 契约 session.fork；成功后立即合并子会话（与 create 相同的同步可寻址保证）；空白位先置 true，等权威 Host 摘要在首个 turn/start 前的精确切点后校正；子会话与源没有持久的续写关系；附着失败前已发布的子会话也调和进列表。
  /**
   * Contract session.fork; on success merge the child into summaries
   * immediately (same synchronous-addressability guarantee as create).
   * Blankness starts provisionally true so the authoritative Host summary can
   * preserve it or lower it after an exact cut before the first `turn/start`;
   * the fork has no durable source relationship. A child published before Workspace
   * attachment fails is also reconciled into the list.
   * @param opts - source session, optional exact inclusive boundary seq, and permission to start migration.
   * @returns the fork result (the child session id).
   */
  async fork(
    opts: { sessionId: SessionId; atSeq?: SessionSeq; allowMigration?: boolean },
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    // 读取源行（继承 cwd 等元数据）。
    const source = this.summaries.find(s => s.sessionId === opts.sessionId)
    // 发起分叉；可选字段仅在提供时携带。
    const result = await this.remote.session.fork({
      sessionId: opts.sessionId,
      ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
      ...opts.allowMigration === undefined ? {} : { allowMigration: opts.allowMigration },
    })
    // 成功取子 id；失败时尝试从附着错误中提取已发布的子 id。
    const childId = result.ok
      ? result.value.sessionId
      : workspaceAttachSessionId(result.error)
    if (childId !== undefined) {
      // 插入子会话占位行（暂按空白处理，等 Host 摘要校正）。
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: childId, updatedAt: Date.now(), running: false, blank: true,
        ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
      } })
    }
    return result
  }

  // 重命名会话并更新其标题投影，无需打开历史。
  /**
   * Rename a Session and update its title projection without opening its history.
   * @param sessionId - Session to rename.
   * @param title - raw title text for Host normalization.
   * @returns the accepted title and event position, or the Remote failure.
   */
  async rename(sessionId: SessionId, title: string): Promise<RemoteResult<SessionRenameValue>> {
    // 发起重命名。
    const result = await this.remote.session.rename({ sessionId, title })
    if (result.ok) {
      // 以事件 seq 为水位更新标题投影。
      this.projectionStore(sessionId).apply('title', result.value.title, SessionSeq(result.value.seq))
    }
    return result
  }

  // 合并 Host 摘要：替换活跃状态并填充缺失元数据；本地 create/fork 占位只填已有行的元数据。
  /**
   * Merge a Host summary, replacing live state and filling missing metadata.
   * Local create/fork placeholders only fill metadata on an existing row.
   */
  private mergeSummary(summary: SessionSummary): void {
    // 记录 upsert 变更。
    this.recordMutation({ kind: 'upsert', summary })
  }

  // 立即应用变更，并在列表响应在途时保留以便重放。
  /** Apply immediately and retain for replay when a list response is in flight. */
  private recordMutation(mutation: SessionListMutation): void {
    // 已销毁：忽略。
    if (this.disposed) return
    // 记入日志，供在途拉取完成后重放。
    this.listMutations?.push(mutation)
    // 立即应用到目录行。
    this.summaries = applyMutation(this.summaries, mutation)
    // 刷新列表快照。
    this.notifier.markDirty()
  }

  // ---- 订阅 API（供 useSessionList 使用） ----
  // ---- Subscription API (for useSessionList) ----

  // useSessionList 的 uSES 订阅入口。
  /**
   * uSES subscription entry for useSessionList.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    // 挂到列表通知器。
    return this.notifier.subscribe(listener)
  }

  // 缓存的列表快照（脏且无监听者时惰性重建）。
  /**
   * Cached list snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getListSnapshot(): SessionListSnapshot {
    // 读取前确保快照新鲜。
    this.notifier.ensureFresh()
    return this.listSnapshotCache
  }

  // 读取一个可能只存在于已加载子代理目录中的会话的投影值。
  /**
   * Read cached projection values for a Session that may exist only in a loaded subagent catalog.
   * @param sessionId - Session whose control or history baseline supplied projections.
   * @returns current values, or undefined before any projection store exists.
   */
  projectionValues(sessionId: SessionId): Readonly<Partial<SessionProjectionMap>> | undefined {
    // 存储不存在即 undefined。
    return this.projectionStores.get(sessionId)?.values()
  }

  // ---- 实时控制与 Host 事件入口 ----
  // ---- Live control and Host-event sinks ----

  // 应用完整控制基线或其后的单事件投影帧。
  /**
   * Apply a complete control baseline or one later per-event projection frame.
   * @param frame - baseline or live per-event projection change from Session Controller.
   */
  handleControlFrame(frame: SessionControlFrame): void {
    // 基线帧：整体替换。
    if (frame.type === 'baseline') {
      this.replaceControlBaseline(frame.value)
      return
    }
    // 取（或建）该会话的存储。
    const store = this.projectionStore(frame.sessionId)
    // 帧携带的事件序号作为水位。
    const seq = SessionSeq(frame.seq)
    // 逐键应用变更（高 seq 胜）。
    for (const change of frame.changes) store.apply(change.key, change.val, seq)
    // 刷新列表快照。
    this.notifier.markDirty()
  }

  // 用控制基线重建各会话的投影行。
  private replaceControlBaseline(baseline: SessionControlBaseline): void {

    // 逐会话应用其投影块。
    for (const [sessionId, block] of Object.entries(baseline.projections)) {
      // 取（或建）存储。
      const store = this.projectionStore(sessionId as SessionId)
      // 转换切点序号。
      const asOfSeq = sessionSeqCursor(block.asOfSeq)
      // 按切点播种（清 cached、比 seq）。
      store.seed({ ...block, asOfSeq })
    }
    // 刷新列表快照。
    this.notifier.markDirty()
  }

  // 应用经 ctx.remote.$on 转发的一次会话新增。
  /**
   * Apply one Session-list addition forwarded through `ctx.remote.$on`.
   * @param summary - current Host summary for the added Session.
   */
  handleSessionAdded(summary: SessionSummary): void {
    // 合并目录行。
    this.mergeSummary(summary)
    // 运行中的新增：登记参与。
    if (!this.disposed && summary.running) this.engagedSessions.add(summary.sessionId)
    // 同步常驻实例的空白位。
    this.sessions.get(summary.sessionId)?.handleBlank(this.effectiveBlank(summary))
    // 应用随附的投影块。
    if (summary.projections !== undefined) this.applyListBlock(summary.sessionId, summary.projections)
  }

  // 按块声明的序列空间合并一个列表面投影块：sequenced 块来自 Host 对已附加会话的活动注册表，逐键按高 seq 胜与该会话的基线/帧合并；cached 块来自仅列表头的检查点视图，其水位与本连接的 seq 不可比，只填无 sequenced 行的键。
  /**
   * Merge one list-surface projection block by the sequence space it declares.
   * A `sequenced` block came from the Host's live registry for an attached
   * Session, so each key lands under higher-seq-wins against that Session's
   * baselines and frames. A `cached` block was viewed from the persisted
   * checkpoint by a header-only listing: its watermark is not comparable with
   * this connection's seqs, so it only fills keys no sequenced row holds.
   */
  private applyListBlock(sessionId: SessionId, block: SessionProjectionHints): void {
    // 取（或建）存储。
    const store = this.projectionStore(sessionId)
    switch (block.kind) {
      case 'sequenced': {
        // 转换块切点序号。
        const seq = sessionSeqCursor(block.asOfSeq)
        // 逐键按高 seq 胜应用。
        for (const [key, value] of Object.entries(block.values)) store.apply(key, value, seq)
        return
      }
      case 'cached':
        // cached：只填无 sequenced 行的键。
        store.applyCached(block.values)
        return
      default:
        // 未知块类型：编译期穷尽性保护。
        assertNever(block.kind, 'session list projection block kind')
    }
  }

  // 应用经 ctx.remote.$on 转发的一次会话移除。
  /**
   * Apply one Session removal forwarded through `ctx.remote.$on`.
   * @param sessionId - removed Session identity.
   */
  handleSessionRemoved(sessionId: SessionId): void {
    // 判断是否为持久的子代理身份（地址可解析，或列表行标记为子代理）。
    const durableSubagent = this.subagentAddress(sessionId) !== undefined
      || this.summaries.some(summary => summary.sessionId === sessionId && summary.origin === 'subagent')
    // 持久子代理只降状态不删行；普通会话整行移除。
    this.recordMutation(durableSubagent
      ? { kind: 'status', sessionId, running: false, agentAvailable: false }
      : { kind: 'remove', sessionId })
    // 子代理：仅停运行位。
    if (durableSubagent) this.sessions.get(sessionId)?.handleRunning(false)
    // 普通会话：标记实例已移除。
    else this.sessions.get(sessionId)?.handleRemoved()
    // 查看其子代理目录。
    const catalog = this.projectionStores.get(sessionId)?.values().subagentCatalog
    // 非持久子代理且无目录内容：回收投影存储。
    if (!durableSubagent && (catalog === undefined || catalog.length === 0)) {
      this.projectionStores.delete(sessionId)
    }
    // 清理参与标记。
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    // 取消其进行中的投影读取。
    this.projectionInflight.get(sessionId)?.controller.abort()
    // 清排在途登记。
    this.projectionInflight.delete(sessionId)
    // 清除读取状态。
    this.projectionLoads.delete(sessionId)
  }

  // 应用一次实时的 Agent 运行状态变更。
  /**
   * Apply one live Agent running-state change.
   * @param sessionId - Session whose Agent state changed.
   * @param running - current Agent running state.
   */
  handleSessionStatus(sessionId: SessionId, running: boolean): void {
    // 进入运行：登记参与（防止后续空列表把会话藏回空白）。
    if (!this.disposed && running) this.engagedSessions.add(sessionId)
    // 记录状态变更。
    this.recordMutation({ kind: 'status', sessionId, running, agentAvailable: true })
    // 同步常驻实例。
    this.sessions.get(sessionId)?.handleRunning(running)
  }

  // 由一条用户创作的持久消息推进列表活动时间。
  /**
   * Advance Session-list activity from one user-authored durable message.
   * @param sessionId - Session whose activity changed.
   * @param updatedAt - durable message timestamp.
   */
  handleSessionActivity(sessionId: SessionId, updatedAt: number): void {
    // 记录活动变更。
    this.recordMutation({ kind: 'activity', sessionId, updatedAt })
  }

  // 把一次实时 Agent 失败呈现到已实例化的会话上。
  /**
   * Surface one live Agent failure on an already-materialized Session.
   * @param sessionId - Session whose Agent failed.
   * @param message - caller-visible failure description.
   */
  handleSessionError(sessionId: SessionId, message: string): void {
    // 转发给常驻实例。
    this.sessions.get(sessionId)?.handleAgentError(message)
  }

  // 用可查询基线修复重建后的 Host 事件代：新查询之前丢弃旧投影切点，包括进程本地控制基线中缺席的冷会话；已打开的会话 follow 流经 API Gateway 独立恢复。
  /**
   * Repair one re-established Host-event generation with queryable baselines.
   * Discard old projection cuts before new queries, including cold Sessions
   * absent from the process-local control baseline.
   * Opened Session follow streams resume independently through API Gateway.
   */
  handleConnected(): void {
    // 清空全部旧代投影值。
    for (const store of this.projectionStores.values()) store.clear()
    // 丢弃旧请求的变更日志。
    this.listMutations = null
    // 解除旧单飞。
    this.listInflight = null
    // 立即重拉列表。
    void this.refreshList()
    // 收集需要重读投影的父会话（此前有读取状态的）。
    const parents = new Set(this.projectionLoads.keys())
    // 常驻子会话的父会话也要重读（目录随基线重建）。
    for (const id of this.sessions.keys()) {
      // 取其子代理地址。
      const address = this.addresses.get(id)
      // 记录其父 id。
      if (address !== undefined) parents.add(address.parentSessionId)
    }
    // 取消全部在途投影读取。
    for (const { controller } of this.projectionInflight.values()) controller.abort()
    // 清排在途登记。
    this.projectionInflight.clear()
    // 清除读取状态（强制重新查询）。
    this.projectionLoads.clear()
    // 重新发起各父会话的投影读取。
    for (const parentSessionId of parents) void this.refreshProjections(parentSessionId)
  }

  // 由目录行与投影存储构建列表快照（脏时才执行）。
  private buildListSnapshot(): SessionListSnapshot {
    // 合并投影信息进每行摘要。
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // List rows read the generic 'title' projection key (host-computed unit
      // value; there is no dedicated title frame).
      // 列表行读取通用的 title 投影键（Host 计算的单元值；没有专门的标题帧）。
      // 取该行的投影存储。
      const projectionStore = this.projectionStores.get(summary.sessionId)
      // 读取标题投影值。
      const title = projectionStore?.get('title')
      // 取全部当前投影值（作摘要快照）。
      const projectionValues = projectionStore?.values()
      // 读取列表元数据投影。
      const metadata = projectionValues?.sessionListMetadata
      return {
        ...summary,
        // Cached list hints can precede a history opening or control update.
        // 缓存的列表提示可能早于历史打开或控制更新。
        // 展示空白位：目录空白、本地未参与，且元数据未断言非空白。
        blank: this.effectiveBlank(summary) && metadata?.blank !== false,
        // 活动时间取目录值与元数据的较大者。
        updatedAt: Math.max(summary.updatedAt, metadata?.lastPromptAt ?? 0),
        // 标题非空字符串时才覆盖。
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        // 有投影值时才附上摘要。
        ...(projectionValues === undefined ? {} : { projectionValues }),
      }
    })
    // 计算谱系缩进后的渲染行。
    const fresh = flattenLineage(merged)
    // 逐行恢复身份（引用稳定性）。
    const items = fresh.map((entry) => {
      // 取上一版行。
      const prev = this.entryCache.get(entry.sessionId)
      // 全字段一致：复用旧对象，保住 memo 的引用稳定。
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.formatStatus === entry.formatStatus
        && prev.projectionValues === entry.projectionValues
      ) return prev
      // 更新身份缓存。
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    // 当前行身份集合。
    const itemIds = new Set(items.map(entry => entry.sessionId))
    // 清理已消失身份的缓存项。
    for (const id of this.entryCache.keys()) {
      if (!itemIds.has(id)) this.entryCache.delete(id)
    }
    // 逐项引用比较，保持数组引用稳定。
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    // 有变化才替换数组。
    if (!sameOrder) this.itemsCache = items
    // 组装最终快照：行与状态 + 每会话投影快照。
    return {
      items: this.itemsCache,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
      // 每个投影存储导出一份快照（读取状态覆盖 idle 缺省）。
      projectionsBySession: Object.fromEntries([...this.projectionStores].map(([sessionId, store]) => [
        sessionId,
        { values: store.values(), state: 'idle', error: null, ...this.projectionLoads.get(sessionId) },
      ])),
    }
  }
}

// 应用单个列表变更，不推导展示顺序（顺序由 flattenLineage 决定）。
/** Apply one list mutation without deriving display order. */
function applyMutation(summaries: readonly SessionSummary[], mutation: SessionListMutation): SessionSummary[] {
  switch (mutation.kind) {
    case 'upsert':
    case 'placeholder': {
      // upsert 与 placeholder 共用新增/合并逻辑。
      // 查找已有行。
      const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId)
      // 不存在：插到最前（新会话优先显示）。
      if (existing === undefined) return [mutation.summary, ...summaries]
      // 合并出新行：活跃状态由 Host upsert 覆盖，元数据只填缺失。
      const filled: SessionSummary = {
        ...existing,
        // Blank only lowers: a stale true (session-added racing the local
        // first send) never re-hides an already-surfaced session.
        // 空白位只降不升：过期的 true（新增事件与本地首发送跑）绝不让已浮现的会话重新隐藏。
        blank: existing.blank && mutation.summary.blank,
        // 只有 Host upsert 覆盖活跃状态字段（占位不覆盖）。
        ...(mutation.kind === 'upsert' ? {
          agentAvailable: mutation.summary.agentAvailable,
          running: mutation.summary.running,
          ...(mutation.summary.formatStatus === undefined ? {} : { formatStatus: mutation.summary.formatStatus }),
        } : {}),
        // cwd 缺失才填充。
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        // 父 id 缺失才填充。
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
        // 来源缺失才填充。
        ...(existing.origin === undefined && mutation.summary.origin !== undefined
          ? { origin: mutation.summary.origin } : {}),
      }
      // 合并后无任何实际变化：返回原数组的浅拷贝（新数组实例以触发引用比较语义）。
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.origin === existing.origin && filled.blank === existing.blank
        && filled.agentAvailable === existing.agentAvailable && filled.running === existing.running
        && filled.formatStatus === existing.formatStatus
      ) return [...summaries]
      // 替换目标行。
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove':
      // remove：过滤掉目标行。
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    case 'status':
      // Running converts display state; it does not establish durable history.
      // 运行态只转换展示状态，不建立持久历史；运行中会同时清掉空白位。
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && (summary.running !== mutation.running
          || summary.agentAvailable !== mutation.agentAvailable || (mutation.running && summary.blank))
        ? { ...summary, running: mutation.running, agentAvailable: mutation.agentAvailable, blank: summary.blank && !mutation.running }
        : summary)
    case 'activity':
      // activity：仅当时间更新时推进。
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && mutation.updatedAt > summary.updatedAt
        ? { ...summary, updatedAt: mutation.updatedAt }
        : summary)
    case 'engaged':
      // engaged：清掉目标行的空白位。
      return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.blank
        ? { ...summary, blank: false }
        : summary)
  }
}

// Host 契约与客户端项目并行构建期的临时源面桥接。
/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error: RemoteFailure): SessionId | undefined {
  // 仅"工作区附着失败"错误携带已发布的会话 id。
  return error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined
}
