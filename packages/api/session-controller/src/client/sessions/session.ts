// 会话（Session）在创建后保持常驻，使其打开的 Remote 源在后台持续运行。
// Sessions remain resident after creation so their open Remote sources keep running off-screen.

// cordis 的 Context 类型：代理作用域上下文。
import type { Context } from '@deepseek-ai/cordis'
// Agent 收件箱状态与目标类型。
import type { InboxState, InboxTarget } from '@deepseek-ai/dsh-agent/types'
// randomUUID：生成请求 id。
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// 图片与文件附件引用类型。
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// SubagentAddress（子代理地址）：直连子代理会话寻址。
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
// 消息 id 品牌类型。
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
// 用户消息类型。
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// 日志偏移与会话序号品牌类型。
import { SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
// SessionEventStream（会话事件流）： addressed 的分页/跟随流。
import { SessionEventStream } from '../transport.ts'
// 日志变更类型。
import type { SessionJournalChange } from '../transport.ts'
// 本包类型：提示内容部件、队列动作、地址、助手流基线、投影基线与请求 id。
import type {
  PromptContentPart,
  QueueAction,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionProjectionBaseline,
  SessionRequestId,
} from '../../types.ts'
// 会话契约类型：提交输入、退役载荷、对外接口与提交句柄。
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, SessionFace, SubmissionHandle,
} from '../contract/session.ts'
// 快照契约类型：打开状态、待定提交、提示错误与会话快照。
import type {
  OpenState, PendingSubmission, PromptError, SessionSnapshot,
} from '../contract/snapshot.ts'
// 可变会话事件源：窗口内容的持有者。
import { MutableSessionEventSource } from '../contract/events.ts'
// 事件类型：类事件、事件条目与存活事件条目。
import type {
  SessionEventLike, SessionEventLikeEntry, SessionLiveEventEntry,
} from '../contract/events.ts'
// Notifier（通知器）：订阅与脏快照刷新。
import { Notifier } from './notifier.ts'
// isRemoteFailure：判断错误是否为远程失败。
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
// RemoteError（远程错误）与失败/结果类型。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// 生成的远程命名空间集合。
import type { SessionRemotes } from './remotes.ts'
// 投影值存储与其基线类型。
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
// 浏览器时区解析。
import { resolvedClientTimeZone } from '../time-zone.ts'
// 客户端助手流与其结果类型。
import {
  ClientAssistantStream,
  type ClientAssistantStreamResult,
} from './assistant-stream.ts'

// 把宿主投影基线归一化为客户端基线形状（asOfSeq 收窄为品牌序号）。
function projectionsBaseline(value: SessionProjectionBaseline): ProjectionsBaseline {
  return {
    ...value,
    // 序号 -1 表示尚无历史，其余收窄为 SessionSeq。
    asOfSeq: value.asOfSeq === -1 ? -1 : SessionSeq(value.asOfSeq),
  }
}

// 普通历史窗口的最小消息数。
/** Minimum message count for ordinary history windows. */
export const PAGE_MESSAGES = 50

// 常规历史分页选项：单页最多 500 条消息，且至少覆盖 50 条消息与 2 个回合起点。
const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }

// 回合跳转（turn jump）向后翻页时每页的最小消息数。
/** Minimum messages per page while a turn jump loops backwards. */
export const JUMP_PAGE_MESSAGES = 200

// 跳转分页选项：在常规选项基础上放大 turnWindow.minMessages。
const JUMP_PAGE_OPTIONS = {
  ...HISTORY_PAGE_OPTIONS,
  turnWindow: { ...HISTORY_PAGE_OPTIONS.turnWindow, minMessages: JUMP_PAGE_MESSAGES },
}

// 待定历史：跳转循环收集中的分页状态。
interface PendingHistory {
  // 下一页的上界序号。
  beforeSeq: SessionLogOffset
  // 是否仍有更早历史。
  hasMore: boolean
  // 已收集的各页条目。
  readonly pages: (readonly SessionEventLikeEntry[])[]
}

interface OlderHistoryRequest {
  readonly generation: number
  readonly beforeSeq: SessionLogOffset
  page: { readonly entries: readonly SessionEventLikeEntry[]; readonly hasMore: boolean } | null
  invalidated: boolean
  recovering: boolean
  consuming: boolean
  promise?: Promise<void>
}

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  // 目录发现的地址：选择非激活的子代理传输路径。
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /**
   * Publish each accepted prompt to the Manager, including after this Session
   * object is replaced. Acceptance converts display state, but does not
   * establish that a turn started or reached durable history.
   */
  // 每次被接受的提示都通知管理器（包括本对象被替换之后）。
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  // 采用管理器持有的投影值存储；缺省时自建私有存储（裸对象层构造）。
  projections?: ProjectionValueStore
}

/**
 * Owns a session's event window, lifecycle state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are Session Controller internals.
 */
// 拥有会话的事件窗口、生命周期状态与可观察快照；React 绑定留在该数据层之外。
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  // 窗口左端（最旧已知事件的序号）。
  private baseSeq = SessionLogOffset(0)
  // 是否仍有更早历史可加载。
  private hasMore = false
  private historyWasPartial = false
  private openState: OpenState = 'cold'
  // 打开失败时的远程错误。
  private openError: RemoteFailure | null = null
  // 在途打开 Promise（幂等去重）。
  private openPromise: Promise<void> | null = null
  /** Bumped by stream replacement to invalidate an in-flight doOpen. Stale
   *  passes drop all writes once the generation moves on. */
  // 流替换时递增，使在途 doOpen 失效；旧世代一旦过气就丢弃全部写入。
  private openGeneration = 0
  private get loadingOlder(): boolean { return this.historyLoadStatus === 'loading' }
  private historyLoadStatus: SessionSnapshot['historyLoadStatus'] = 'idle'
  private olderRequest: OlderHistoryRequest | null = null
  /** Shared low-water target of the running jump loop; null when no jump is paging. */
  private jumpTargetSeq: SessionSeq | null = null
  // 运行中跳转循环的完成 Promise；重定向目标的调用者共享它。
  /** The running jump loop's completion, shared by retargeting callers. */
  private jumpPromise: Promise<void> | null = null
  // 跳转收集中的待定历史（非 null 表示跳转进行中）。
  private pendingHistory: PendingHistory | null = null
  // 退订收件箱投影观察的函数。
  private readonly stopObservingInbox: () => void
  // 助手流聚合器：折叠持久条目与瞬时帧。
  private readonly assistantStream = new ClientAssistantStream()
  // Agent 是否运行中。
  private running = false
  // 子代理地址（普通会话为 undefined）。
  private address: SubagentAddress | undefined
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * when the Host accepts a prompt, never reset — the blank → engaging edge of
   * the phase machine (see ComposerPhase).
   */
  // 粘性发送标记：宿主接受提示后置位且不重置（阶段机的 blank → engaging 边沿）。
  private promptAttempted = false
  // 首次被接受的提示保持 engaging 阶段，直到其回合可观察。
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  // 新会话展示状态；未知的裸会话保守地视为空白。
  /** New Session display state; unknown bare sessions begin conservatively blank. */
  private blankBit = true
  // 宿主已移除该会话（api-session/removed）。
  private removed = false
  // 最近一次发送/停止失败（展示用错误条）。
  private promptError: PromptError | null = null
  // 最近一次无回合位置的 Agent 失败描述。
  private lastAgentError: string | null = null
  // 本地提交回声（echo），按插入顺序，包括宿主尚未接受的部分。
  /** Local submission echoes, insertion-ordered, including those the Host has not accepted yet. */
  private pendingSubmissions: readonly PendingSubmission[] = []
  // 已接受的回声，发布为快照的 pendingSubmissions；在接受或移除时重建。
  /** The accepted echoes, published as SessionSnapshot.pendingSubmissions; rebuilt when one is accepted or removed. */
  private acceptedSubmissions: readonly PendingSubmission[] = []
  /** Per-echo settlement state; `retiring` latches the first observation so a
   *  Inbox projection and its durable event cannot both retire one echo. */
  // 每条回声的结算状态；retiring 先到先得，防止收件箱投影与持久事件双重退役。
  private readonly submissionSettlements = new Map<SessionRequestId, {
    // 回声的队列位置类别。
    readonly placement: PendingSubmission['placement']
    /** Latest received Inbox position; null means removed from that queue. */
    receipt?: {
      // 所在队列目标。
      readonly target: InboxTarget
      // 观察到该位置时的投影序号。
      readonly seq: number
      // 队列内索引；null 表示已从该队列移除。
      readonly index: number | null
      // 消息携带的附件引用。
      readonly attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    }
    /** Durable admission may precede the Inbox projection acknowledging its claim. */
    admitted?: readonly (ImageAttachmentRef | FileAttachmentRef)[]
    /** Whether the Host accepted the prompt; the echo is published only from then on. */
    accepted: boolean
    readonly onAccept?: (() => void) | undefined
    readonly onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined
    retiring: boolean
  }>()
  // 本会话打开期间持有的分页/跟随流生命周期。
  /** Owns the addressed page/follow lifecycle while this Session is open. */
  private events: SessionEventStream | undefined

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the Host, seeded by the tail page's
   * projections block and updated by Session Controller control frames;
   * Host-sequenced writes merge under higher-seq-wins and cached list blocks
   * yield to them (projection-store.ts). Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  // 每会话投影值存储（推送模型）：宿主计算好的整值，由尾页 projections 块播种、控制帧更新。
  readonly projections: ProjectionValueStore

  // 供会话视图组装消费的连续历史与实时尾部。
  /** Contiguous history and live tail consumed by Conversation assembly. */
  readonly eventSource = new MutableSessionEventSource()
  // 缓存的快照（脏时懒重建）。
  private snapshotCache: SessionSnapshot
  // 订阅通知器。
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by ClientSessions when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  // Agent 作用域上下文：由 ClientSessions 铸造作用域时一次性绑定；未绑定或已剪除都跳过分发行为。
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  // 客户端会话始终由宿主诞生；构造时装配投影存储与快照观察。
  constructor(
    readonly sessionId: SessionId,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    // 采用管理器的存储或自建私有存储。
    this.projections = options.projections ?? new ProjectionValueStore()
    // 记录可选的子代理地址。
    this.address = options.address
    // 通知器：每次刷新时重建快照缓存。
    this.notifier = new Notifier(() => {
      this.snapshotCache = this.buildSnapshot()
    })
    // 立即构建一次初始快照。
    this.snapshotCache = this.buildSnapshot()
    // 订阅收件箱投影变化：驱动回声与队列行的对账。
    this.stopObservingInbox = this.projections.faceOf('inbox').subscribe(() => {
      this.observeSubmissionInbox()
    })
  }

  /**
   * Bind the Agent-scoped context minted by ClientSessions (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  // 绑定 ClientSessions 铸造的 Agent 作用域上下文（只允许一次）。
  bindScope(actx: Context): void {
    // 二次绑定是装配错误。
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  // 剪除时释放已绑定的作用域（之后的新绑定伴随新铸造的作用域）。
  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Register one local submission echo (see the ISession declaration). The
   * echo reconciles against Host events from now on, but it enters the
   * snapshot only once the prompt receipt or an Inbox row carrying its
   * request id shows that the Host accepted it.
   * @param input - echo content and the optional settlement callback.
   * @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
   */
  // 登记一条本地提交回声：进入快照前须等宿主接受证据。
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    // 铸造请求 id。
    const requestId = randomUUID() as SessionRequestId
    // 依运行态决定放置类别：steering（打断中）/ queued（排队）/ transcript（直接入稿）。
    const placement = this.running ? input.mode === 'steer' ? 'steering' : 'queued' : 'transcript'
    // 追加到本地回声列表。
    this.pendingSubmissions = [...this.pendingSubmissions, {
      requestId,
      placement,
      time: Date.now(),
      text: input.text,
      attachments: input.attachments,
    }]
    // 初始化结算状态：未接受、未退役。
    this.submissionSettlements.set(requestId, {
      placement, accepted: false, onAccept: input.onAccept, onRetire: input.onRetire, retiring: false,
    })
    // 返回请求 id 与提交前的放弃路径。
    return { requestId, abandon: () => { this.retireFailedSubmission(requestId) } }
  }

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's
   * promptError. The Host can hold the prompt at its admission stage, so the
   * call can stay open; the echo appears and the blank → engaging edge flips
   * only once the Host accepts the prompt.
   * @param content - text, browser-owned temporary image uploads, and staged-file receipts.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @param signal - optional caller cancellation for the complete admission round-trip.
   * @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  // 发送提示：queue/steer 1:1 透传；失败落入 promptError。
  async prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>> {
    // 清空上一条发送错误。
    this.promptError = null
    // 清空上一条 Agent 错误。
    this.lastAgentError = null
    // Before the first await, so a turn observed ahead of the receipt clears it.
    // 判定"首次提示"须在首个 await 之前：回合观察可能早于回执到达。
    const firstPrompt = this.blankBit && !this.firstPromptPendingTurn
    if (firstPrompt) this.firstPromptPendingTurn = true
    // 提示结果。
    let result: RemoteResult<{ accepted: true }>
    if (this.address === undefined) {
      // 普通会话：采集浏览器时区并发起 session.prompt。
      const clientTimeZone = resolvedClientTimeZone()
      result = await this.remote.session.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        sessionId: this.sessionId,
        mode,
        content,
        clientTimeZone,
      }, signal)
    } else if (content.some(part => part.type === 'file')) {
      // 子代理续聊不接受文件部件：直接拒绝。
      result = {
        ok: false,
        error: new RemoteError(
          'subagent/attachment-invalid',
          'subagent continuation does not accept files',
          { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
        ),
      }
    } else {
      // The preceding branch rejects file parts before the narrower subagent
      // wire type is used; this array is not filtered or reordered.
      // 窄化的子代理线上类型：文件部件已被上一分支拒绝，这里不再过滤或重排。
      const routedContent = content as Exclude<PromptContentPart, { readonly type: 'file' }>[]
      const routed = await this.remote.subagents.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        childSessionId: this.address.childSessionId,
        delivery: mode,
        content: routedContent,
        clientTimeZone: resolvedClientTimeZone(),
      }, signal)
      // 统一结果形状：成功折叠为 accepted。
      result = routed.ok ? { ok: true, value: { accepted: true } } : routed
    }
    if (!result.ok) {
      // Rejection must leave a first prompt blank and eligible for workspace reuse.
      // 失败必须回滚"首次提示"状态，保持空白以便工作区复用。
      if (firstPrompt) this.firstPromptPendingTurn = false
      // 已识别的请求：退役其回声。
      if (requestId !== undefined) this.retireFailedSubmission(requestId)
      // 记录发送错误并刷新快照。
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // 应用宿主接受。
    this.acceptPrompt(requestId)
    return result
  }

  /**
   * Apply the Host's acceptance of one prompt: publish its echo, move a blank
   * Session to engaging, and tell the submitter. The prompt receipt and an
   * Inbox row carrying the prompt's request id both prove acceptance.
   * Whichever arrives first publishes the echo; a later proof for an echo
   * still pending changes nothing.
   * @param requestId - identity from {@link beginSubmission}; absent for a prompt sent without an echo.
   */
  // 应用宿主对一次提示的接受：发布回声、把空白会话推进到 engaging 并通知提交者。
  private acceptPrompt(requestId: SessionRequestId | undefined): void {
    // 取结算状态。
    const settlement = requestId === undefined ? undefined : this.submissionSettlements.get(requestId)
    // 已接受过的回声：后续证据是空操作。
    if (settlement?.accepted === true) return
    if (settlement !== undefined) {
      // 标记接受并重建已接受回声列表。
      settlement.accepted = true
      this.refreshAcceptedSubmissions()
    }
    // 置位粘性发送标记。
    this.promptAttempted = true
    // 离开空白状态。
    this.blankBit = false
    // 刷新快照。
    this.notifier.markDirty()
    // 通知管理器（若配置）。
    this.options.onEngaged?.(this)
    // 通知提交者回调。
    settlement?.onAccept?.()
  }

  /**
   * Resolve one stored image into browser-consumable bytes using this Session's gateway permission scope.
   * @param attachment - complete image reference from the folded session log.
   * @returns the supplied reference after storage verification, and decoded bytes.
   */
  // 用本会话的网关权限读取一张存储图片为浏览器可用的字节。
  async readAttachment(
    attachment: ImageAttachmentRef,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    // 发起附件读取 RPC。
    const result = await this.remote.session.attachment({
      sessionId: this.sessionId,
      attachment,
    })
    // 失败原样返回。
    if (!result.ok) return result
    // base64 解码为二进制字符串。
    const binary = atob(result.value.data)
    // 转成字节数组。
    const data = Uint8Array.from(binary, char => char.charCodeAt(0))
    return { ok: true, value: { attachment: result.value.attachment, data } }
  }

  // 对仍待处理的队列条目应用一次操作。
  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>> {
    return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
  }

  /**
   * Stop the active turn while the Host preserves pending inbox work; failures
   * land in promptError (same error-strip display slot). A subagent address
   * routes through `subagents.interruptByUser`, authorized on the target Session
   * without requiring a live parent Agent.
   * @returns the cancel result.
   */
  // 停止当前回合但保留待处理收件箱；子代理走 interruptByUser 专用通道。
  async cancel(): Promise<RemoteResult<{ accepted: true }>> {
    // 取当前地址。
    const address = this.address
    // 子代理会话走专用中断端点；普通会话走 session.cancel。
    const result = address !== undefined
      ? await this.remote.subagents.interruptByUser(address.childSessionId)
      : await this.remote.session.cancel({ sessionId: this.sessionId })
    if (!result.ok) {
      // 失败记入 promptError（与发送共用错误条展示位）。
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the control-stream projection update.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  // 重命名：成功后用响应值本地结算 title 投影格（高序号者胜）。
  async rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>> {
    // 发起重命名 RPC。
    const result = await this.remote.session.rename({ sessionId: this.sessionId, title })
    // 失败原样返回。
    if (!result.ok) return result
    // 收窄事件序号。
    const seq = SessionSeq(result.value.seq)
    // 本地应用投影值，免去等待控制流推送。
    this.projections.apply('title', result.value.title, seq)
    return { ok: true, value: { title: result.value.title, seq } }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result.
   */
  // 执行一条斜杠命令行：纯准入语义，结果以流节点呈现。
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    // 发起命令执行 RPC。
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    // 失败原样返回。
    if (!result.ok) return result
    // 命中与否取决于返回值是否为空。
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  // 首次打开：拉取尾页（幂等：在途/已打开返回既有 Promise）。
  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    // 已打开：立即完成。
    if (this.openState === 'open') return Promise.resolve()
    // 在途：复用既有 Promise。
    if (this.openPromise !== null) return this.openPromise
    // 启动打开；结束时按身份守卫清空在途标记。
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      // 身份守卫：被取代的打开不得清掉重同步刚设置的 Promise。
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** @inheritdoc */
  async loadOlder(options?: { deferConsumption?: boolean }): Promise<void> {
    const request = this.prepareOlder()
    await request?.promise
    if (request !== null && this.olderRequest === request
      && (!options?.deferConsumption || request.page?.entries.length === 0)) this.consumeOlder()
  }

  private prepareOlder(): OlderHistoryRequest | null {
    if (this.olderRequest !== null) return this.olderRequest
    const events = this.events
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder || events === undefined) return null
    const request: OlderHistoryRequest = {
      generation: this.openGeneration,
      beforeSeq: this.baseSeq,
      page: null,
      invalidated: false,
      recovering: false,
      consuming: false,
    }
    this.olderRequest = request
    this.historyLoadStatus = 'loading'
    this.notifier.markDirty()
    request.promise = (async () => {
      try {
        await events.prepend({ beforeSeq: request.beforeSeq, ...HISTORY_PAGE_OPTIONS })
        if (this.olderRequest !== request) return
        if (request.invalidated || request.generation !== this.openGeneration || request.beforeSeq !== this.baseSeq) return
        const page = request.page
        const first = page?.entries[0]
        this.historyLoadStatus = page === null || (first === undefined ? page.hasMore : first.event.seq >= request.beforeSeq)
          ? 'error' : 'pendingConsumption'
      } catch (error) {
        if (this.olderRequest !== request) return
        request.page = null
        this.historyLoadStatus = 'error'
        if (!isRemoteFailure(error)) console.error('[session-controller] loadOlder failed:', error)
      } finally {
        if (this.olderRequest === request) {
          if (request.invalidated && this.events === events) {
            // A replacement restores the transport cursor before another page uses the visible window.
            request.recovering = true
            this.historyLoadStatus = 'loading'
            events.restart()
          } else if (this.historyLoadStatus === 'error') this.olderRequest = null
          this.notifier.markDirty()
        }
      }
    })()
    return request
  }

  /** @inheritdoc */
  consumeOlder(): boolean {
    const request = this.olderRequest
    if (request === null || request.consuming || this.historyLoadStatus !== 'pendingConsumption' || request.page === null) return false
    if (this.openState !== 'open' || request.invalidated || request.generation !== this.openGeneration
      || request.beforeSeq !== this.baseSeq) {
      this.clearOlderHistory()
      return false
    }
    const page = request.page
    // Retain the request through synchronous feed notification so subscribers cannot reenter consumption.
    request.consuming = true
    try {
      this.prependWindow(page.entries, page.hasMore)
      return true
    } catch (error) {
      if (this.olderRequest === request) this.historyLoadStatus = 'error'
      throw error
    } finally {
      if (this.olderRequest === request) {
        this.olderRequest = null
        if (this.historyLoadStatus !== 'error') this.historyLoadStatus = 'idle'
      }
      this.notifier.markDirty()
    }
  }

  private clearOlderHistory(): void {
    this.olderRequest = null
    this.historyLoadStatus = this.pendingHistory === null ? 'idle' : 'loading'
    this.notifier.markDirty()
  }

  /** Jump loader: page backwards until the window covers seq (see ISession.loadThrough). */
  loadThrough(seq: SessionSeq): Promise<void> {
    this.consumeOlder()
    if (this.olderRequest !== null) return Promise.resolve()
    if (this.openState !== 'open' || !this.hasMore || this.baseSeq <= seq) return Promise.resolve()
    if (this.jumpPromise !== null) {
      // Retarget the running loop to the lowest requested seq.
      // 已有跳转循环：把目标重定向到更低（更早）的请求序号并共享其 Promise。
      this.jumpTargetSeq = SessionSeq(Math.min(this.jumpTargetSeq ?? seq, seq))
      return this.jumpPromise
    }
    // A plain single-page pull owns the busy flag; the jump does not queue
    // behind it (the caller retries once it settles) and must leave no
    // target behind — only the loop's finally clears that field, and no
    // loop starts here.
    // 普通翻页持有忙标志：跳转不排队（调用方稍后重试），也不能留下悬空目标。
    if (this.loadingOlder) return Promise.resolve()
    // 捕获事件流。
    const events = this.events
    if (events === undefined) return Promise.resolve()
    // 初始化跳转收集状态。
    const pending: PendingHistory = {
      beforeSeq: this.baseSeq,
      hasMore: this.hasMore,
      pages: [],
    }
    // 登记待定历史（前插分页会写入它）。
    this.pendingHistory = pending
    // 设置跳转目标。
    this.jumpTargetSeq = seq
    this.historyLoadStatus = 'loading'
    this.notifier.markDirty()
    // Stale-pass guard (the doOpen pattern): a resync mid-loop replaces the
    // stream generation; this pass then stops instead of paging the new
    // generation toward its old target.
    // 过气守卫：循环中途重同步会替换流世代，本趟随即停止。
    const generation = this.openGeneration
    // 启动跳转循环。
    this.jumpPromise = (async () => {
      try {
        while (this.jumpTargetSeq !== null && pending.beforeSeq > this.jumpTargetSeq) {
          if (generation !== this.openGeneration) return
          // 记录翻页前的上界。
          const before = pending.beforeSeq
          await events.prepend({ beforeSeq: before, ...JUMP_PAGE_OPTIONS })
          if (generation !== this.openGeneration || this.pendingHistory !== pending) return
          // No-progress guard: an empty or dropped page that still claims more
          // history must end the loop, not spin it.
          if (pending.beforeSeq >= before) {
            if (pending.hasMore) this.historyLoadStatus = 'error'
            return
          }
          if (!pending.hasMore) return
        }
      } catch (error) {
        if (generation === this.openGeneration && this.pendingHistory === pending) this.historyLoadStatus = 'error'
        if (!isRemoteFailure(error)) {
          console.error('[session-controller] loadThrough failed:', error)
        }
      } finally {
        if (this.pendingHistory === pending) {
          this.jumpTargetSeq = null
          this.jumpPromise = null
          this.pendingHistory = null
          if (this.historyLoadStatus === 'loading') this.historyLoadStatus = 'idle'
          if (generation === this.openGeneration && pending.pages.length > 0) {
            this.prependWindow(pending.pages.reverse().flat(), pending.hasMore)
          }
          this.notifier.markDirty()
        }
      }
    })()
    return this.jumpPromise
  }

  /** Rebuild an opened history source after address replacement.
   *  Invalidates any in-flight open first; projection state belongs to the independently
   *  reconnecting control stream and remains untouched. */
  // 地址替换后重建已打开的历史源；投影状态归独立重连的控制流所有，不受影响。
  async resync(): Promise<void> {
    // 从未打开过：没有可重建的窗口（doOpen 会同步切到 loading，因此 cold 即意味着没有在途打开）。
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    // 递增世代使在途打开全部失效。
    this.openGeneration++
    this.clearOlderHistory()
    const events = this.events
    // 摘除事件流。
    this.events = undefined
    // 销毁旧流。
    await events?.dispose()
    // 重置打开状态。
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    // 重置窗口基线。
    this.baseSeq = SessionLogOffset(0)
    this.notifier.markDirty()
    // 重新打开。
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  // useSyncExternalStore 的订阅入口。
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached Session snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  // 读取缓存的会话快照（引用稳定直到下次刷新）。
  getSnapshot(): SessionSnapshot {
    // 确保快照新鲜。
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  // 宿主流转发的运行位（保持列表行与快照一致）。
  handleRunning(running: boolean): void {
    // Running converts display state without establishing durable turn history.
    // 运行态只转换展示状态，不代表持久回合历史。
    if (running && this.blankBit) {
      // 开始运行即离开空白。
      this.blankBit = false
      this.notifier.markDirty()
    }
    // 运行中的回合可观察：清除首次提示待回合标记。
    if (running) this.firstPromptPendingTurn = false
    // 运行位无变化则提前返回。
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   */
  // 安装或清除目录发现的传输地址；地址变化会经由新路由重建已打开窗口。
  configureSubagent(address: SubagentAddress | undefined): void {
    // 判断地址是否实际变化。
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Apply the Manager's effective display blank, further reconciled with the
   * current `sessionListMetadata` projection. Local send attempts and current
   * running state prevent re-blanking; an earlier false summary alone does not.
   * The Manager retains acceptance and earlier running observations across
   * Session-object replacement.
   * @param blank - New Session display state after Manager reconciliation.
   */
  // 应用管理器折算后的展示空白位：本地发送尝试或运行中会阻止重新置白。
  handleBlank(blank: boolean): void {
    // 与 sessionListMetadata 投影再折算：显式 false 优先。
    blank = blank && this.projections.values().sessionListMetadata?.blank !== false
    // 无变化提前返回。
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    // 应用新空白位。
    this.blankBit = blank
    this.notifier.markDirty()
  }

  // api-session/removed 转发：打标快照但保留常驻实例。
  /** `api-session/removed` relay: flag the snapshot while retaining the resident instance. */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * `api-session/error` relay: the outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  // api-session/error 转发：无回合位置实时失败的出口。
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /**
   * Stop the Session's live Remote source.
   * @returns when the Remote iterator has completed teardown.
   */
  // 停止本会话的存活 Remote 源并结算未决回声。
  async dispose(): Promise<void> {
    // 先退订收件箱观察。
    this.stopObservingInbox()
    // Unsettled echoes retire as failed so their owners can restore or
    // release browser resources; admitted echoes keep their observed outcome.
    // 未结算回声按失败退役，让所有者恢复或释放浏览器资源；已准入的按观察到结果结算。
    for (const [requestId, settlement] of [...this.submissionSettlements]) {
      if (settlement.admitted !== undefined) this.scheduleObservedRetirement(requestId, settlement.admitted)
      else this.retireFailedSubmission(requestId)
    }
    // 递增世代使后续回调失效。
    this.openGeneration++
    this.clearOlderHistory()
    const events = this.events
    this.events = undefined
    // 销毁事件流。
    await events?.dispose()
  }

  // ---- Private ----

  // 打开流程：拉取尾页并安装事件流；过气趟次不得发布。
  /** @param generation - openGeneration at launch; stale passes cannot publish after replacement. */
  private async doOpen(generation: number): Promise<void> {
    // 进入 loading 状态。
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    // 新建事件流：发布与失败回调都做世代守卫。
    const events = new SessionEventStream(this.remote, this.sessionAddress(), {
      publish: (change) => {
        // 过气或流已被替换：丢弃变更。
        if (generation !== this.openGeneration || this.events !== events) return
        this.acceptEventChange(change)
      },
      failed: (error) => {
        // 流失败进入专用处理。
        this.failEventStream(events, generation, error)
      },
    })
    // 登记为当前流。
    this.events = events
    try {
      // 打开流（拉取尾页）。
      await events.open(HISTORY_PAGE_OPTIONS)
      // 世代守卫：过气则不写状态。
      if (generation !== this.openGeneration || this.events !== events) return
      this.openState = 'open'
    } catch (error) {
      // 过气趟次不上报错误。
      if (generation !== this.openGeneration || this.events !== events) return
      // 非远程失败原样抛出（编程错误）。
      if (!isRemoteFailure(error)) throw error
      // 清流并进入错误状态。
      this.events = undefined
      this.openState = 'error'
      this.openError = error
    } finally {
      // 仅本世代有效时刷新快照。
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  // 应用一次已被 Remote 流对账的连续日志变更。
  /** Apply one contiguous journal update already reconciled by the Remote stream. */
  private acceptEventChange(change: SessionJournalChange): void {
    // 按变更类型分派。
    switch (change.type) {
      // 整窗替换：安装新窗口（含页面自带的投影/助手流元数据）。
      case 'replace':
        this.installWindow(
          change.entries,
          change.hasMore,
          change.page.projections === undefined ? undefined : projectionsBaseline(change.page.projections),
          change.page.assistantStream,
        )
        return
      // 前插一页。
      case 'prepend':
        if (this.olderRequest !== null) {
          this.olderRequest.page = { entries: change.entries, hasMore: change.hasMore }
        } else this.prependWindow(change.entries, change.hasMore)
        return
      // 追加存活事件：先过助手流聚合器再发布。
      case 'append':
        this.publishAssistantEntry(this.assistantStream.acceptDurable(change.entry))
        return
      // 助手流帧：交给聚合器处理。
      case 'assistant-stream':
        this.publishAssistantEntry(this.assistantStream.acceptFrame(change.frame))
    }
  }

  // 替换完整连续窗口并应用页面自带的投影元数据。
  /** Replace the complete contiguous window and apply page-owned projection metadata. */
  private installWindow(
    entries: readonly SessionEventLikeEntry[],
    hasMore: boolean,
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
  ): void {
    // A durable gap-repair page has no assistant baseline. Clearing transient
    // attempts makes a held notification reopen follow once for an atomic
    // page/baseline pair instead of applying it to an unrelated repair cut.
    // 持久间隙修复页不带助手流基线；清空瞬时尝试让悬挂通知以原子方式重开 follow。
    const visible = this.assistantStream.replace(entries, assistantStream)
    if (this.olderRequest !== null && this.loadingOlder && !this.olderRequest.recovering) {
      this.olderRequest.invalidated = true
      this.olderRequest.page = null
    } else this.clearOlderHistory()
    this.baseSeq = SessionLogOffset(entries[0]?.event.seq ?? 0)
    this.hasMore = hasMore
    this.historyWasPartial ||= hasMore
    if (this.pendingHistory !== null) {
      // 同步跳转收集状态：新基线、新 hasMore，并清空已收集页。
      this.pendingHistory.beforeSeq = this.baseSeq
      this.pendingHistory.hasMore = hasMore
      this.pendingHistory.pages.length = 0
    }
    // 窗口内出现回合起点：首次提示的回合已可观察。
    if (visible.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    // 用可见条目替换事件源窗口。
    this.eventSource.replace(visible, hasMore)
    // A new follow baseline replaces confirmed optimistic inputs with Host-owned rows.
    // Receipt-backed inputs are accepted, not failed, even if their history is outside this window.
    // 新跟随基线用宿主持有行替换已确认的乐观输入；有回执的输入按接受结算。
    if (projections !== undefined) {
      for (const [requestId, { receipt }] of this.submissionSettlements) {
        if (receipt !== undefined && receipt.seq <= projections.asOfSeq) {
          this.scheduleObservedRetirement(requestId, receipt.attachments)
        }
      }
    }
    // 逐条观察可见事件中的提交证据。
    for (const entry of visible) this.observeSubmissionEvent(entry.event)
    if (projections !== undefined) {
      // 用投影基线中的收件箱状态观察各队列的插入。
      const inbox = projections.values.inbox as InboxState | undefined
      for (const target of ['next-turn', 'next-step'] as const) {
        this.observeSubmissionInsertions(target, inbox?.[target] ?? [], 0, projections.asOfSeq)
      }
    }
    this.notifier.markDirty()
  }

  // 发布助手流聚合结果（rebaseline / settlement / abandonment / publish / transient）。
  private publishAssistantEntry(result: ClientAssistantStreamResult): void {
    if (result?.type === 'rebaseline') {
      // 需要重开 follow：延迟到微任务，且仅当流未被替换。
      const events = this.events
      queueMicrotask(() => {
        if (events !== undefined && this.events === events) events.restart()
      })
      return
    }
    if (result?.type === 'settlement') {
      // 尝试结算为持久条目并观察其中的提交证据。
      this.eventSource.settleAssistant(result.attemptId, result.entry)
      this.observeSubmissionEvent(result.entry.event)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'abandonment') {
      // 尝试被放弃：仅移除瞬时节点。
      this.eventSource.settleAssistant(result.attemptId)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'publish') {
      // 持久发布：追加存活条目，并按需退役旧尝试。
      const changed = this.appendLive(result.entry)
      if (result.retireAttemptId !== undefined) this.eventSource.settleAssistant(result.retireAttemptId)
      if (changed || result.retireAttemptId !== undefined) this.notifier.markDirty()
    } else if (result?.type === 'transient') {
      // 瞬时发布：仅追加到事件源。
      this.eventSource.append(result.entry)
      this.notifier.markDirty()
    }
  }

  // 前插一个经流校验的历史页。
  /** Prepend one stream-validated history page. */
  private prependWindow(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    if (this.pendingHistory !== null) {
      // 跳转进行中：页面进入收集状态而非直接入窗。
      const pending = this.pendingHistory
      pending.beforeSeq = entries[0] === undefined ? pending.beforeSeq : SessionLogOffset(entries[0].event.seq)
      pending.hasMore = hasMore
      pending.pages.push(entries)
      return
    }
    // 常规前插：更新基线与标志。
    this.baseSeq = entries[0] === undefined ? this.baseSeq : SessionLogOffset(entries[0].event.seq)
    this.hasMore = hasMore
    this.historyWasPartial ||= hasMore
    this.eventSource.prepend(entries, hasMore)
  }

  // 追加一个经流校验的存活事件。
  /** Append one stream-validated live event. */
  private appendLive(entry: SessionLiveEventEntry): boolean {
    const event = entry.event
    // 记录追加前的"首次提示待回合"状态。
    const awaitingFirstTurn = this.firstPromptPendingTurn
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    // 追加进事件源。
    this.eventSource.append(entry)
    // After the feed append: the conversation assembly's animation frame is
    // registered by the feed subscribers above, so the echo-retirement frame
    // scheduled here always runs after the durable node became renderable.
    // 在 feed 追加之后观察提交证据：保证回声退役帧在持久节点可渲染之后执行。
    this.observeSubmissionEvent(event)
    // 返回"首次提示待回合"边沿是否变化。
    return awaitingFirstTurn !== this.firstPromptPendingTurn
  }

  // 观察持久接受证据：即使插入与认领共享同一条投影通知。
  /** Observe durable acceptance even when insertion and claim share one projection notification. */
  private observeSubmissionEvent(event: SessionEventLike): void {
    // 无待结算回声：快速返回。
    if (this.submissionSettlements.size === 0) return
    if (event.type === 'agent/inbox/spliced') {
      // 收件箱拼接：更新受影响回声的队列位置。
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      for (const [requestId, settlement] of this.submissionSettlements) {
        const receipt = settlement.receipt
        // 只处理同队列、已有索引且早于本事件的回声。
        if (receipt?.target !== target || receipt.index === null || receipt.seq >= event.seq) continue
        // 该回声是否落在被移除区间。
        const removed = receipt.index >= start && receipt.index < start + removedCount
        if (removed && outcome === 'canceled') this.retireFailedSubmission(requestId)
        else settlement.receipt = {
          ...receipt,
          seq: event.seq,
          index: removed ? null : receipt.index < start ? receipt.index : receipt.index + inserted.length - removedCount,
        }
      }
      // 观察本事件插入的消息。
      this.observeSubmissionInsertions(target, inserted, start, event.seq)
      // A queued echo waits for the inbox projection the queue dock renders, which can arrive after this
      // event; retiring it here would empty the dock for a frame. A claim in the same projection notification
      // still retires it through the durable user message.
      // 排队回声等待队列坞渲染的收件箱投影，不在事件时刻退役；同通知内的认领仍会经持久消息结算。
      for (const message of inserted) this.observeSubmissionMessage(message, false, false)
      return
    }
    if (event.type === 'request/context' || event.type === 'turn/end') {
      // 队列行已消失且序号早于本事件：回声按失败退役。
      for (const [requestId, settlement] of this.submissionSettlements) {
        if (settlement.admitted === undefined && settlement.receipt?.index === null
          && settlement.receipt.seq < event.seq) this.retireFailedSubmission(requestId)
      }
      return
    }
    // 持久用户消息：按已准入观察。
    if (event.type === 'user/message') this.observeSubmissionMessage(event.data, true)
  }

  // 观察收件箱插入的用户消息：登记队列位置并在构成接受证据时应用接受。
  private observeSubmissionInsertions(target: InboxTarget, messages: readonly UserMessage[], start: number, seq: number): void {
    for (const [index, message] of messages.entries()) {
      const source = message.source
      // 只关心带 rpcId 的用户来源消息。
      if (source.kind !== 'user' || !('rpcId' in source)) continue
      const settlement = this.submissionSettlements.get(source.rpcId)
      // 无结算、已退役、或位置证据晚于已知：跳过。
      if (settlement === undefined || settlement.retiring || (settlement.receipt?.seq ?? -1) > seq) continue
      // Either proof accepts a prompt; an Inbox row can reach the Client before the prompt receipt. Later splices
      // move the recorded position, so a canceled splice that removes the row retires its echo, queued ones
      // included; a queued echo otherwise leaves once the queue dock renders its row or its message is admitted.
      // 收件箱行可先于提示回执到达；随后拼接会移动记录位置，被取消拼接移除时退役回声。
      settlement.receipt = { target, seq, index: start + index, attachments: attachmentRefsIn(message.content) }
      this.acceptPrompt(source.rpcId)
    }
  }

  // 观察一条用户消息：准入（admitted）或队列移除证据。
  private observeSubmissionMessage(message: UserMessage, admitted: boolean, retireQueued = true): void {
    const source = message.source
    // 只关心带 rpcId 的用户来源。
    if (source.kind !== 'user' || !('rpcId' in source)) return
    const settlement = this.submissionSettlements.get(source.rpcId)
    // 无结算或已退役：忽略。
    if (settlement === undefined || settlement.retiring) return
    if (!admitted) {
      // 非准入路径：排队回声在允许退役时按观察到结果结算。
      if (settlement.placement === 'queued' && retireQueued) {
        this.scheduleObservedRetirement(source.rpcId, attachmentRefsIn(message.content))
      }
      return
    }
    // 记录准入证据（附件引用）。
    settlement.admitted = attachmentRefsIn(message.content)
    // 尝试完成准入型退役。
    this.retireAdmittedSubmission(source.rpcId)
  }

  // 准入的 Chat 身份只在过期收件箱行不可能再出现后才退役。
  /** Retire admitted Chat identities only after stale Inbox rows can no longer reappear. */
  private retireAdmittedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    // 尚无准入证据：不退役。
    if (settlement?.admitted === undefined) return
    const receipt = settlement.receipt
    if (receipt?.index === null
      && (this.projections.seqOf('inbox') ?? -1) < receipt.seq) return
    // 安全：安排观察型退役。
    this.scheduleObservedRetirement(requestId, settlement.admitted)
  }

  // 收件箱投影观察：接受证据退役排队回声；水印完成准入 Chat 的交接。
  /** Inbox acceptance retires queued echoes; its watermark completes admitted Chat handoffs. */
  private observeSubmissionInbox(): void {
    if (this.submissionSettlements.size === 0) return
    // 读取收件箱投影值。
    const inbox = this.projections.get('inbox') as InboxState | undefined
    if (inbox === undefined) return
    // 读取投影序号水印。
    const seq = this.projections.seqOf('inbox')
    for (const target of ['next-turn', 'next-step'] as const) {
      // 有水印时按整体插入观察一次。
      if (seq !== undefined) this.observeSubmissionInsertions(target, inbox[target], 0, seq)
      // 逐条观察队列消息（非准入路径）。
      for (const message of inbox[target]) this.observeSubmissionMessage(message, false)
    }
    // 对全部待结算回声重试准入型退役。
    for (const requestId of this.submissionSettlements.keys()) this.retireAdmittedSubmission(requestId)
  }

  /**
   * Latch one observed settlement and remove the echo an animation frame
   * later. The delay keeps the echo in the snapshot until the frame in which
   * the durable node (whose assembly frame was registered first) is
   * renderable; the render-time rpcId dedupe hides the one-frame overlap.
   */
  // 锁存一次观察结算，并延后一个动画帧再移除回声（保证持久节点先可渲染）。
  private scheduleObservedRetirement(
    requestId: SessionRequestId,
    attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[],
  ): void {
    const settlement = this.submissionSettlements.get(requestId)
    // 无结算或已锁存：幂等返回。
    if (settlement === undefined || settlement.retiring) return
    // 先锁存，防止重复调度。
    settlement.retiring = true
    scheduleFrame(() => { this.finishSubmission(requestId, { reason: 'observed', attachments }) })
  }

  // 立即移除一条未结算回声（提示被拒、中止或销毁）。
  /** Remove one unsettled echo immediately (prompt rejection, abort, or disposal). */
  private retireFailedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    // 已退役或已准入的回声不走失败路径。
    if (settlement === undefined || settlement.retiring || settlement.admitted !== undefined) return
    settlement.retiring = true
    this.finishSubmission(requestId, { reason: 'failed' })
  }

  // 重建已接受回声列表。
  private refreshAcceptedSubmissions(): void {
    this.acceptedSubmissions = this.pendingSubmissions
      .filter(echo => this.submissionSettlements.get(echo.requestId)?.accepted === true)
  }

  // 唯一的移除点：删除回声、发布快照，再通知所有者。
  /** Single removal point: drop the echo, publish, then notify the owner. */
  private finishSubmission(requestId: SessionRequestId, retirement: PendingSubmissionRetirement): void {
    const settlement = this.submissionSettlements.get(requestId)
    // 幂等守卫：retiring 先锁存，一个结算不会完成两次。
    /* v8 ignore next -- retiring latches before every schedule, so one settlement never finishes twice. */
    if (settlement === undefined) return
    // 删除结算状态。
    this.submissionSettlements.delete(requestId)
    // 从回声列表移除。
    this.pendingSubmissions = this.pendingSubmissions.filter(echo => echo.requestId !== requestId)
    if (settlement.accepted) this.refreshAcceptedSubmissions()
    // 发布快照变化。
    this.notifier.markDirty()
    // 通知所有者回调。
    settlement.onRetire?.(retirement)
  }

  // 仅在事件流仍拥有会话时发布终结性后台失败。
  /** Publish a terminal background failure only while this stream still owns the Session. */
  private failEventStream(events: SessionEventStream, generation: number, error: unknown): void {
    // 世代守卫：过气失败直接忽略。
    if (generation !== this.openGeneration || this.events !== events) return
    // 非远程失败原样抛出。
    if (!isRemoteFailure(error)) throw error
    // 递增世代并进入错误状态。
    this.openGeneration++
    this.clearOlderHistory()
    this.events = undefined
    this.openPromise = null
    this.openState = 'error'
    this.openError = error
    // 销毁失败流。
    void events.dispose()
    this.notifier.markDirty()
  }

  // 构建可观察快照。
  private buildSnapshot(): SessionSnapshot {
    // 读取子代理身份投影。
    const identity = this.projections.values().subagent
    return {
      sessionId: this.sessionId,
      // 已接受回声。
      pendingSubmissions: this.acceptedSubmissions,
      running: this.running,
      // 子代理信息：未知模式下用身份投影补全 mode。
      subagent: this.address === undefined
        ? null
        : {
          address: this.address.mode === 'unknown' && identity != null
            ? { ...this.address, mode: identity.mode }
            : this.address,
        },
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      historyWasPartial: this.historyWasPartial,
      loadingOlder: this.loadingOlder,
      historyLoadStatus: this.historyLoadStatus,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
      promptAttempted: this.promptAttempted,
      // The flag is set before the receipt; the Session leaves blank only once the Host accepted the prompt.
      // 首次回合等待 = 待回合标记 && 已离开空白（宿主已接受提示）。
      awaitingFirstTurn: this.firstPromptPendingTurn && !this.blankBit,
    }
  }

  // 计算当前会话地址：普通会话或子代理地址。
  private sessionAddress(): SessionAddress {
    return this.address === undefined
      ? { kind: 'session', sessionId: this.sessionId }
      : { kind: 'subagent', ...this.address }
  }
}

// 下一动画帧运行回调；无帧时钟的环境退化为宏任务。
/** Run one callback on the next animation frame, or a macrotask where no frame clock exists. */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fn() })
  else setTimeout(fn, 0)
}

// 从结构化读取的内容块列表中提取附件引用（按块顺序）。
/** Attachment references in one structurally-read content block list, in block order. */
function attachmentRefsIn(content: unknown): readonly (ImageAttachmentRef | FileAttachmentRef)[] {
  // 非数组：无引用。
  if (!Array.isArray(content)) return []
  const refs: Array<ImageAttachmentRef | FileAttachmentRef> = []
  for (const block of content) {
    // 跳过非对象块。
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { readonly type?: unknown; readonly attachment?: unknown }
    if ((candidate.type === 'image' || candidate.type === 'file')
      && typeof candidate.attachment === 'object' && candidate.attachment !== null) {
      // 图像或文件块且附件为对象：收集该引用。
      refs.push(candidate.attachment as ImageAttachmentRef | FileAttachmentRef)
    }
  }
  return refs
}
