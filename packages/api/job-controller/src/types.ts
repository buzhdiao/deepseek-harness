// 模块说明：生成的 `job` 远端（Remote）命名空间的线上（wire）类型：
// 按会话的花名册流、按任务的观察流，以及人工击杀。客户端安全：不含 Host 侧导入。
/**
 * Wire types of the generated `job` Remote namespace: the per-session roster
 * stream, the per-job observation stream, and the human kill. Client-safe: no
 * Host imports.
 * @module @deepseek-ai/dsh-api-job-controller/types
 */

// JobId（任务 id）品牌类型：任务在注册表中的标识。
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
// JobChunk（任务输出块）与 JobView（任务视图）：观察流的载荷与任务行投影。
import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'
// SessionId（会话 id）类型：花名册与击杀请求的目标会话。
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// 原样转发任务视图与输出块类型：客户端可直接引用而不必感知 jobs 包内部。
export type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'

// 一条 `job.list` 流的目标：流将镜像该会话可见的任务集合。
/** Target of one `job.list` stream: the session whose visible jobs the stream mirrors. */
export interface JobListRequest {
  // 目标会话 id。
  readonly sessionId: SessionId
}

// 一帧 `job.list`：某次生命周期变更之后该会话可见的完整集合
// （其自有任务加上全部无主任务）。整集替换，因此重连后的第一帧即真实状态。
/**
 * One `job.list` frame: the complete set the session can see — its own jobs
 * plus every unowned job — after a lifecycle change. Whole-set replacement,
 * so a reconnect's first frame is already the truth.
 */
export interface JobListFrame {
  // 帧类型判别字段：rows 表示整集任务行。
  readonly type: 'rows'
  // 当前可见任务视图的只读数组。
  readonly jobs: readonly JobView[]
}

// 由人发起的、对一条会话可见后台任务的取消（kill）请求。
/** Human-initiated cancellation of one background job visible to a session. */
export interface JobKillRequest {
  // 提供该任务列表的会话；围栏（fenced）查找会以此身份进行。
  /** Session whose job list carries the job; the fenced lookup reads as it. */
  readonly sessionId: SessionId
  // 要取消的任务 id。
  readonly jobId: JobId
}

// 注册表接受人工击杀请求后的回执。
/** Receipt after the registry accepted the human kill request. */
export interface JobKillValue {
  // 结果：requested 表示已登记取消；already-finished 表示任务早已结束。
  readonly outcome: 'requested' | 'already-finished'
}

// 模块扩充：登记 job 远端命名空间的错误详情类型映射。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    // 该会话的任务列表下已不存在该 id 的可击杀行。
    /** The session's job list no longer carries a killable row under that id. */
    'job/not-found': { readonly sessionId: SessionId; readonly jobId: JobId }
  }
}

// 一条 `job.follow` 流的目标：任务、其拥有会话，以及可选的续读偏移。
/** Target of one `job.follow` stream: the job, its owning session, and an optional resume offset. */
export interface JobFollowRequest {
  // 围栏读取的拥有会话。无主任务省略此字段，任何调用方都可观察。
  /**
   * Owning session for the fenced read. Omitted for an unowned job, which any
   * caller may observe.
   */
  readonly sessionId?: SessionId
  // 要观察的任务 id。
  readonly jobId: JobId
  // 续读的绝对字节偏移（取自上一帧的 `next`）。省略时从保留的最旧字节开始。
  /**
   * Absolute byte offset to resume from (a prior frame's `next`). Omitted, the
   * stream starts at the oldest retained byte.
   */
  readonly from?: number
}

// 任务观察流的帧序列：先是一帧携带任务投影（打开时刻的 `output.earliest` 与
// `output.total`）的 `opened` 锚点及首帧 `output` 的续读偏移，随后是合并后的
// `output` 批次，最后——任务结算且环形缓冲排空后——是一帧终态 `status`（带结算后
// 投影），之后流正常关闭。状态与输出走同一条流，因此结算永远不会与仍在打开的
// 输出通道产生竞态。
/**
 * Job observation stream frames: one `opened` anchor carrying the job's
 * projection (its `output.earliest` and `output.total` at open time) and the
 * offset the first `output` frame continues from, then coalesced `output`
 * batches, then — once the job has settled and its ring is drained — one
 * terminal `status` carrying the settled projection, after which the stream
 * closes normally. Status rides the same stream as output so settlement can
 * never race a still-open output channel.
 */
export type JobFollowFrame =
  // opened 帧：流的锚点，给出打开时刻的任务投影。
  | {
    // 判别字段：opened。
    readonly type: 'opened'
    // 打开时刻的任务视图。
    readonly job: JobView
    // 第一帧 `output` 将从此偏移继续。
    /** Offset the first `output` frame continues from. */
    readonly from: number
  }
  // output 帧：合并后的输出块批次。
  | {
    // 判别字段：output。
    readonly type: 'output'
    // 本批输出块。
    readonly chunks: readonly JobChunk[]
    // 本帧之后的续读偏移。
    /** Offset to resume from after this frame. */
    readonly next: number
    // 请求偏移与 chunks 之间的字节已被逐出（有损续读）。
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true
  }
  // status 帧：终态帧，携带结算后的任务投影。
  | {
    // 判别字段：status。
    readonly type: 'status'
    // 结算后的任务视图。
    readonly job: JobView
  }
