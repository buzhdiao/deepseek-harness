// 对外的 Session 门面（face）：功能包从不接触具体 Session 类，组件经 useSession 读生命周期状态，编排代码只调用下面的行为动词。
/**
 * The outward session face. Feature packages never see the concrete Session
 * class: components read lifecycle state through `useSession` (the
 * ObservableSnapshot half), and orchestration code calls the behavior verbs
 * below — nothing else. Widening this interface is the explicit act of
 * widening what features may do to a session (and what every test fixture
 * must stub); implementation-internal entry points (history staging, wire-frame
 * dispatch) stay on the class, invisible out here.
 */
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PromptContentPart, QueueAction, SessionRequestId } from '../../types.ts'
import type { PendingSubmissionAttachment, SessionSnapshot } from './snapshot.ts'

// 本地提交回声（echo）离开快照的原因：observed=已观察到其持久 user/message 事件或 Host 队列行（附件引用按 prompt 顺序给出）；failed=被拒绝、抛错或在准入前中止。
/**
 * Why a local submission echo left the snapshot: `observed` when its durable
 * `user/message` event or host queue occurrence arrived (with the admitted
 * attachment references in prompt order), `failed` when the prompt was rejected,
 * threw, or was aborted before acceptance.
 */
export type PendingSubmissionRetirement =
  | {
    readonly reason: 'observed'
    readonly attachments: readonly (ImageAttachmentRef | FileAttachmentRef)[]
  }
  | { readonly reason: 'failed' }

// 在 prompt 调用之前登记一条本地提交回声的输入。
/** Input registering one local submission echo ahead of its prompt call. */
export interface BeginSubmissionInput {
  // 即将进行的 prompt 所用的投递模式。
  /** Delivery mode used with the upcoming prompt. */
  readonly mode: 'queue' | 'steer'
  // 与即将发送的 prompt 完全一致的文本。
  /** Prompt text exactly as the upcoming prompt will send it. */
  readonly text: string
  // 与即将发送的 prompt 附件对应的有序图片预览与持久文件元数据。
  /** Ordered image previews and durable file metadata matching the upcoming prompt attachments. */
  readonly attachments: readonly PendingSubmissionAttachment[]
  // Host 接受 prompt 时恰好调用一次，与回声发布处在同一次更新中（无论凭据先到还是 Inbox 行先到）。
  /**
   * Called once when the Host accepted the prompt, in the same update that
   * publishes the echo, whether the receipt or an Inbox row showed it first.
   */
  readonly onAccept?: () => void
  // 回声退休（retire）时恰好触发一次的结算回调。
  /** Settlement callback fired exactly once when the echo retires. */
  readonly onRetire?: (retirement: PendingSubmissionRetirement) => void
}

// 一条已登记的提交回声：其 prompt 必须携带的身份，外加 prompt 之前的逃生通道。
/** One registered submission echo: the identity its prompt must carry, and the pre-prompt escape hatch. */
export interface SubmissionHandle {
  // prompt RPC 身份；传给 ISession.prompt。
  /** The prompt RPC identity; pass it to {@link ISession.prompt}. */
  readonly requestId: SessionRequestId
  // 调用方无法到达 prompt()（序列化失败）时把回声结算为失败；其他结算之后再调用是空操作。
  /** Retire the echo as failed when the caller cannot reach prompt() (serialization failure); no-op after any other settlement. */
  abandon(): void
}

// 按键寻址的投影（projection）读取门面（useProjection 的解析路径，见 ProjectionValueStore）。
/** Key-addressed projection read face (the useProjection resolution path; see ProjectionValueStore). */
export interface ProjectionsFace {
  // 某个投影键的身份稳定裸可观察对象；键缺失也是 undefined 快照，绝不会缺门面。
  /**
   * The identity-stable bare observable for one projection key (absence is
   * an `undefined` snapshot, never a missing face).
   * @param key - projection key.
   * @returns the key's value face.
   */
  faceOf(key: string): ObservableSnapshot<unknown>
}

// 身份加上功能包可对会话施加的行为动词集合。
/** Identity plus the behavior verbs features may invoke on a session. */
export interface ISession {
  // 会话的 Host 身份（与 agent id 同轴）。
  /** The session's host identity (agent id — same axis). */
  readonly sessionId: SessionId
  // Host 计算的按键投影值（useProjection 的落点）。
  /** Host-computed projection values by key (the useProjection seat). */
  readonly projections: ProjectionsFace
  // 在调用方序列化并发送 prompt 之前登记一条本地提交回声；此后与 Host 事件调和，Host 接受 prompt 后进入快照的 pendingSubmissions。
  /**
   * Register one local submission echo before the caller serializes and sends
   * the prompt. The echo reconciles against Host events from then on, and
   * enters `snapshot.pendingSubmissions` once the Host accepted the prompt:
   * when {@link prompt} reports the receipt or an Inbox row carrying the
   * request id arrives, whichever comes first. The Chat echoes persist until
   * durable admission; transcript identities also wait for the Inbox claim
   * watermark so stale queue rows stay suppressed. Queued echoes retire on
   * queue acceptance. Identified failures retire submissions that have not
   * already reached durable admission.
   * @param input - echo content and the optional settlement callback.
   * @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle
  // 向会话发送一条 prompt；Host 可在其准入阶段扣住它，调用因此可能保持打开；接受时发布回声并把空白会话推进 engaging。
  /**
   * Send a prompt into the session. The Host can hold the prompt at its
   * admission stage, so the call can stay open; acceptance publishes the
   * prompt's echo and moves a blank Session to engaging, before the call
   * returns when an Inbox row carrying the request id arrives first.
   * @param content - text plus browser-owned temporary image uploads.
   * @param mode - 'queue' appends a turn; 'steer' interrupts the running one.
   * @param signal - optional caller cancellation for the complete admission round-trip.
   * @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
   * @returns acceptance, or the business error (also mirrored into snapshot.promptError).
   */
  prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>>
  // 使用本会话的网关权限范围解析一张已存储的图片。
  /**
   * Resolve one stored image using this Session's gateway permission scope.
   * @param attachment - complete image reference from the folded session log.
   * @returns the supplied reference after storage verification, and decoded bytes.
   */
  readAttachment(
    attachment: ImageAttachmentRef,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
  // 对仍在排队的队列条目（occurrence）应用编辑、移除或 Steer 操作。
  /**
   * Apply one edit, remove, or Steer action to a still-pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns acceptance, or a business/transport error.
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>>
  // 取消正在运行的回合；已排队的工作保留，并在 Host 达到取消静默后按 FIFO 顺序恢复。
  /**
   * Cancel the running turn. Pending queued work remains and resumes in FIFO
   * order after the Host reaches cancellation quiescence.
   * @returns acceptance, or the business error.
   */
  cancel(): Promise<RemoteResult<{ accepted: true }>>
  // 重命名会话（显式用户标题；固定标题以防自动再生成）。
  /**
   * Rename this session (explicit user title; pins it against automatic
   * regeneration).
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the normalized accepted title and its event seq, or the business error.
   */
  rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>>
  // 向更早方向扩展历史：至少 50 条消息与两个回合（Turn）起点，含窗口开头的一个部分回合；到 500 条或历史尽头即停；发布一次 prepend。
  /**
   * Extend history by at least 50 messages and two Turn starts, including a
   * partial Turn at the window's beginning. Stop at 500 messages or history
   * exhaustion even when those minima cannot be met. Publish one prepend.
   * @returns completion; failures land in snapshot.openState/loadingOlder.
   */
  loadOlder(): Promise<void>
  // 向回翻页直到窗口覆盖 seq（含）——回合跳转加载器；进行中的跳转可被后续调用降低共享目标并复用在途完成。
  /**
   * Page history backwards until the window covers `seq` (inclusive) — the
   * turn-jump loader. Repeated calls while a jump is paging lower its shared
   * target and return the in-flight completion; `snapshot.loadingOlder` is
   * the busy signal for the whole jump.
   * Each page uses the same Turn alignment as loadOlder, with a 200-message
   * minimum. The 500-message limit applies per page, not to the whole jump.
   * Older pages publish together at completion, including successful pages
   * before a later failure; live events remain independently visible.
   * @param seq - durable event seq the window must reach (a turn's `turn/start` seq).
   * @returns completion once covered, exhausted, superseded, or failed soft.
   */
  loadThrough(seq: SessionSeq): Promise<void>
  // 对本会话的 agent 执行一行斜杠命令——纯准入语义（Host 执行器负责把生命周期持久记录）。
  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle).
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the Remote face's error branch.
   */
  command(line: string): Promise<RemoteResult<{ matched: boolean }>>
}

// 完整对外门面：行为动词加上 Session 生命周期读取侧（useSession 钩子的数据源）；由 SessionBinding.session 与 provide 通道携带。
/**
 * The full outward face: behavior verbs plus the Session lifecycle read side
 * (the `useSession` hook source). This is the type carried by
 * `SessionBinding.session` and the provide channel.
 */
export type SessionFace = ISession & ObservableSnapshot<SessionSnapshot>
