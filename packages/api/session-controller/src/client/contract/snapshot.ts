// Session 自有的可观察状态，不含会话目标（Conversation target）数据。
/** Session-owned observable state excluding Conversation target data. */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '../../types.ts'

// 本地提交回声在持久准入前显示的一张图片。
/** One image displayed by a local submission echo before durable admission. */
export interface PendingSubmissionImage {
  // 浏览器侧预览 URL；其生命周期属于提交者，与本快照无关。
  /** Browser-owned preview URL; its lifecycle belongs to the submitter, never this snapshot. */
  readonly previewUrl: string
  // 浏览器文件名（文件有名字时）。
  /** Browser file name, when the file had one. */
  readonly name?: string
  // 固有像素宽度（提交者已探测时）。
  /** Intrinsic pixel width, when the submitter has probed it. */
  readonly width?: number
  // 固有像素高度（提交者已探测时）。
  /** Intrinsic pixel height, when the submitter has probed it. */
  readonly height?: number
}

// 本地提交回声附件的图片分支。
/** Image branch of a local submission echo attachment. */
export interface PendingSubmissionImageAttachment {
  readonly type: 'image'
  readonly value: PendingSubmissionImage
}

// 本地提交回声附件的文件分支。
/** File branch of a local submission echo attachment. */
export interface PendingSubmissionFileAttachment {
  readonly type: 'file'
  readonly value: FileAttachmentRef
}

// 本地提交回声显示的一个附件，按 prompt 顺序排列。
/** One attachment displayed by a local submission echo, in prompt order. */
export type PendingSubmissionAttachment =
  | PendingSubmissionImageAttachment
  | PendingSubmissionFileAttachment

// 本地提交开始时选定的客户端呈现面（placement）。
/** Client surface selected when a local submission begins. */
export type PendingSubmissionPlacement = 'transcript' | 'queued' | 'steering'

// 一条本地 prompt 提交回声：提交开始时登记，Host 接受 prompt 后发布，让会话在持久准入完成前就能显示消息；仅存于客户端内存——重载与重连只凭持久事件重建会话。
/**
 * One local prompt-submission echo: registered when a submission begins and
 * published once the Host accepts the prompt, so the conversation shows the
 * message before its durable admission completes. Client-memory only — reload
 * and reconnect rebuild the conversation from durable events alone.
 */
export interface PendingSubmission {
  // prompt RPC 身份；持久 user/message 事件以 rpcId 回指它。
  /** The prompt RPC identity; the durable `user/message` source echoes it as `rpcId`. */
  readonly requestId: SessionRequestId
  // 提交时固定的呈现面；Inbox 接受不会把 Chat 回声挪进 dock。
  /** Surface fixed at submission time; Inbox acceptance does not move a Chat echo into the dock. */
  readonly placement: PendingSubmissionPlacement
  // 提交开始时的客户端墙钟毫秒数。
  /** Client wall-clock ms when the submission began. */
  readonly time: number
  // 即将发送的 prompt 文本（单个文本块）。
  /** Prompt text exactly as it will be sent (one text block). */
  readonly text: string
  // 与 prompt 附件对应的有序图片预览与持久文件元数据。
  /** Ordered image previews and durable file metadata matching the prompt attachments. */
  readonly attachments: readonly PendingSubmissionAttachment[]
}

// Session 事件窗口的历史打开生命周期。
/** History-open lifecycle of a Session event window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

// Session 消费者看到的发送/停止失败。
/** Send/stop failure surfaced by Session consumers. */
export interface PromptError {
  // 失败的操作：send 或 stop。
  readonly op: 'send' | 'stop'
  // 远端失败详情。
  readonly error: RemoteFailure
}

// 不可变的 Session 生命周期与控制快照。
/** Immutable Session lifecycle and control snapshot. */
export interface SessionSnapshot {
  // 会话的 Host 身份。
  readonly sessionId: SessionId
  // Host 已接受、且尚未观察到对应持久事件或队列行的本地提交回声。
  /** Local prompt-submission echoes the Host accepted and that are not yet observed as durable events or queue occurrences. */
  readonly pendingSubmissions: readonly PendingSubmission[]
  // Agent 是否正在运行。
  readonly running: boolean
  // 作为子代理时的地址信息；非子会话为 null。
  readonly subagent: {
    readonly address: SubagentAddress
  } | null
  // 会话已从 Host 目录移除。
  readonly removed: boolean
  // 历史窗口打开生命周期。
  readonly openState: OpenState
  // 打开失败时的远端错误。
  readonly openError: RemoteFailure | null
  // 是否还有更早的历史未加载。
  readonly hasMore: boolean
  /** This Client Session has exposed an incomplete history window; remains true across replacements. */
  readonly historyWasPartial: boolean
  /** Whether historyLoadStatus is loading, including Turn-jump requests. */
  readonly loadingOlder: boolean
  /** History request status; pendingConsumption retains an unpublished ordinary page. */
  readonly historyLoadStatus: 'idle' | 'loading' | 'pendingConsumption' | 'error'
  readonly promptError: PromptError | null
  // 会话尚无任何消息（空白会话）。
  readonly blank: boolean
  // 最近一次 Agent 失败描述；无则为 null。
  readonly lastAgentError: string | null
  // 本 Client Session 对象上已发起过 prompt 调用。
  /** A prompt call has begun on this Client Session object. */
  readonly promptAttempted: boolean
  // 首个被接受的 prompt 尚未落成持久 turn/start 事件。
  /** The first accepted prompt has not reached a durable `turn/start` event. */
  readonly awaitingFirstTurn: boolean
}
