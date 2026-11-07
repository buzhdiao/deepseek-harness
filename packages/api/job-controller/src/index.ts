// 模块说明：Host 侧 job 远端拥有者——通过生成的 `job` 命名空间向浏览器流式输出
// 一个会话可见的后台任务花名册与单个任务的保留输出，并代表人类停止任务。
// 这些流都是 `ctx.jobs` 的投影；模型的消费游标与通知状态不会感知它们，
// 人工击杀也不是模型发起的，因此完成通知仍会送达拥有该任务的代理。
/**
 * Host job Remote owner: streams the background-job roster one session can
 * see and one job's retained output to browsers over the generated `job`
 * namespace, and stops a job on a human's behalf. The streams are
 * projections of `ctx.jobs`; the model's consuming cursor and notice state
 * never observe them, and a human kill is not the model's own, so the
 * completion notice still reaches the owning agent.
 * @module @deepseek-ai/dsh-api-job-controller
 */

// Cordis 的 Context（上下文）：服务构造与类型扩充的目标。
import { Context } from '@deepseek-ai/cordis'
// schemastery 的 z：声明服务的配置 schema。
import z from '@deepseek-ai/schemastery'
// 空类型导入：引入 jobs 包的模块扩充（注册表与事件类型）。
import type {} from '@deepseek-ai/dsh-jobs'
// Typert 远端协议：Remote（远端方法装饰器）、RemoteError（远端错误）、TypertRemoteService（远端服务基类）。
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 单任务输出观察流：follow 方法的实现。
import { observeJobOutput } from './observe.ts'
// 按会话的任务花名册流：list 方法的实现。
import { streamJobRows } from './rows.ts'
// 本包线上类型：list/follow/kill 的请求与帧类型。
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from './types.ts'

// 原样转发全部线上类型，供客户端引用。
export type * from './types.ts'

// 模块扩充：在 Cordis Context 上登记 job 远端命名空间的宿主服务。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // Host 侧 job 远端命名空间的拥有者。
    /** Host job Remote namespace owner. */
    jobController: JobController
  }
}

// 两次读取之间的默认合并（coalescing）窗口，单位毫秒。
/** Default coalescing window between reads, in milliseconds. */
const DEFAULT_OBSERVE_FLUSH_MS = 100

// 每个输出帧的默认软字节预算（64 KiB）。
/** Default soft byte budget per output frame. */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

// Job Controller 的部署策略配置。
/** Job Controller deployment policy. */
export interface Config {
  // 注册表一次提交后、下一次任务行或输出读取前的合并窗口，毫秒（默认 100）。
  /** Coalescing window after a registry commit before the next rows or output read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  // 每个观察输出帧的软字节预算（默认 65536）；单个超预算的块整体发出。
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}

// 支撑生成的 `ctx.remote.job` 命名空间的 Host 服务。
/** Host service backing the generated `ctx.remote.job` namespace. */
export class JobController extends TypertRemoteService {
  // 声明服务依赖：jobs（任务注册表）与 typert（协议设施）。
  static inject = ['jobs', 'typert']

  // 服务的配置 schema：两个观察参数都取自然数并回填默认值。
  static Config: z<Config> = z.object({
    // 合并窗口：至少 1 毫秒，默认 100。
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    // 每帧软字节预算：至少 1 字节，默认 64 KiB。
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  // 合并窗口（毫秒）：解析后的只读配置。
  private readonly observeFlushMs: number
  // 每帧软字节预算：解析后的只读配置。
  private readonly observeMaxFrameBytes: number

  // 构造服务：注册到 'job' 远端命名空间。
  /**
   * @param ctx - Host context carrying the live Agent registry and the job registry.
   * @param config - observation cadence and framing policy.
   */
  constructor(ctx: Context, config: Config) {
    // 调用远端服务基类：服务名 jobController，远端命名空间为 job。
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery（导出的 Config schema）已回填带默认值的字段；
    // 这个断言只是记录“已解析”这一事实，而非隐藏的回退。
    // schemastery (the exported Config schema) has already filled the defaulted
    // fields; the assertion records that resolution, not a hidden fallback.
    const resolved = config as Required<Config>
    // 保存合并窗口配置。
    this.observeFlushMs = resolved.observeFlushMs
    // 保存每帧软字节预算配置。
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  // 流式镜像一个会话可见的任务集合——其自有任务加上全部无主任务——以整集帧输出：
  // 打开时一帧，之后每批合并的生命周期提交后再来一帧。流没有自然终点，由载体（carrier）关闭。
  // 远端流方法：mode stream 表示返回异步可迭代帧序列。
  /**
   * Stream the jobs one session can see — its own plus every unowned job —
   * as whole-set frames: one on open, then one after each coalesced burst of
   * lifecycle commits. The stream has no natural end; the carrier closes it.
   * @param request - the session whose visible set to mirror.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the roster frames.
   */
  @Remote({ mode: 'stream' })
  list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    // 委托给 rows 流生成器：传入注册表、请求与合并窗口配置。
    return streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, signal)
  }

  // 从绝对字节偏移开始流式输出一个任务的保留输出，结算并排空后再给出终态投影。
  // 非消费（non-consuming）读取：面向模型的游标与通知状态永远不会感知这些读取。
  // 请求中的会话即围栏（fenced）读取的调用者：注册表会拒绝该会话不可见的任务与未知任务。
  // 远端流方法：返回观察帧序列。
  /**
   * Stream one job's retained output from an absolute byte offset, then its
   * terminal projection once settled and drained. Non-consuming: the
   * model-facing cursor and notice state never observe these reads. The
   * request's session is the fenced read's caller; the registry rejects a
   * job the session cannot see and an unknown job.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    // 委托给输出观察生成器：传入注册表、请求与观察节奏/分帧配置。
    return observeJobOutput(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
    }, signal)
  }

  // 代表人类终止一个后台任务。请求中的会话即围栏读取的调用者，因此目标任务必须是
  // 该会话可见的：注册表的拥有者围栏是唯一访问规则，子会话自己的任务也照常可从其
  // 列表中终止。击杀以 `cancelled by the user` 为理由登记；它不是模型发起的，
  // 因此拥有该任务的 Agent 仍会收到完成通知，等待该任务的 shell 工具会在自己的
  // 结果中读到该理由。
  // 远端调用方法：同步请求-应答。
  /**
   * Kill one background job on a human's behalf. The request's session is
   * the fenced read's caller, so the job must be one that session can see:
   * the registry's owner fence is the only access rule, and a child session's
   * own jobs are killable from its list like any other. The kill records
   * `cancelled by the user` as its reason; it is not one the model requested,
   * so the owning agent still receives the completion notice, and a shell
   * tool waiting on that job reads the reason in its own result.
   * @param request - Session whose job list carries the job, and the job id.
   * @returns the registry's admission of the kill request.
   */
  @Remote('kill')
  kill(request: JobKillRequest): JobKillValue {
    // 取出任务注册表。
    const jobs = this.ctx.jobs
    try {
      // 先以该会话身份做围栏查找：不可见或未知都会抛错。
      jobs.get(request.jobId, request.sessionId)
    } catch (error) {
      // `unknown job` and `belongs to another session` both mean this session's
      // list no longer carries a killable row; the client renders one story.
      // 两种失败对客户端呈现同一个故事：该 id 下已无可击杀的行。
      throw new RemoteError('job/not-found', String(error), {
        // 错误详情：会话与任务 id。
        sessionId: request.sessionId,
        jobId: request.jobId,
      })
    }
    // Same synchronous span as the lookup, so nothing can remove the job in
    // between — and a producer-cancel throw propagates per the registry
    // contract (job state unchanged) instead of masquerading as job-not-found.
    // 与查找同一同步区间内执行击杀，期间任务不可能被移除；
    // 生产者取消的抛错按注册表契约传播（任务状态不变），而不会伪装成 job-not-found。
    const outcome = jobs.kill(request.jobId, request.sessionId, 'cancelled by the user')
    // 返回注册表接受击杀请求的结果。
    return { outcome }
  }
}

// 默认导出：JobController 服务类。
export default JobController
