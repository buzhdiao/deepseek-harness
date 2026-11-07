// 模块说明：`ctx.jobs` 客户端服务——`job` 命名空间上的引用计数流：
// 每个被观察会话一条 `job.list` 花名册流、每个被观察任务一条 `job.follow` 流，
// 使重叠的查看者共享流、重连后花名册整集恢复、观察从模型游标续读；
// 外加经 `job.kill` 的人工击杀透传。
/**
 * The `ctx.jobs` client service: reference-counted streams over the `job`
 * namespace — one `job.list` roster stream per watched session and one
 * `job.follow` stream per observed job — so overlapping viewers share a
 * stream, rosters resume whole after a reconnect, and observations resume
 * from the model's cursor, plus the human kill passthrough over `job.kill`.
 * @module @deepseek-ai/dsh-api-job-controller/client/service
 */

// Cordis 的 Service（服务基类）与 Context（上下文）类型。
import { Service, type Context } from '@deepseek-ai/cordis'
// 网关客户端：载体流错误类型与 ClientRemote（$stream 流工厂）类型。
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Typert 协议的远端结果类型：kill 透传的返回形状。
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// JobId（任务 id）品牌类型。
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
// SessionId（会话 id）类型。
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 本包线上类型：list/follow/kill 的请求与帧。
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from '../types.ts'
// 共享客户端任务模型：流的落点（rows/observation 状态）。
import type { ClientJobsModel, JobsSource } from './model.ts'

// 流运行器（stream runner）驱动的生成 `job` 命名空间面。
/** The generated `job` namespace face the stream runners drive. */
export interface JobRemote {
  // 打开一个花名册（roster）世代。
  /**
   * Open one roster generation.
   * @param request - the session whose visible set to mirror.
   * @param signal - generation cancellation.
   * @returns the whole-set frame sequence of one generation.
   */
  list(request: JobListRequest, signal?: AbortSignal): AsyncIterable<JobListFrame>
  // 打开一个观察（observation）世代。
  /**
   * Open one observation generation.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - generation cancellation.
   * @returns the frame sequence of one generation.
   */
  follow(request: JobFollowRequest, signal?: AbortSignal): AsyncIterable<JobFollowFrame>
  // 代表人类终止一个任务；返回注册表回执或业务/传输失败。
  /**
   * Kill one job on the human's behalf.
   * @param request - the session whose list carries the job, and the job id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(request: JobKillRequest): Promise<RemoteResult<JobKillValue>>
}

// 运行器驱动的远端面：网关流工厂加 `job` 命名空间。
/** Remote faces the runners drive: the Gateway stream factory and the `job` namespace. */
export interface JobsRemote {
  // 网关的流工厂。
  readonly $stream: ClientRemote['$stream']
  // 生成的 `job` 命名空间。
  readonly job: JobRemote
}

// 客户端 jobs 服务面。
/** The client jobs service face. */
export interface IJobs {
  // 花名册与按任务的观察状态。
  /** Rosters and per-job observation state. */
  readonly state: JobsSource
  /**
   * Keep one session's roster current; reference-counted, so two watchers of
   * the same session share one stream and the rows leave with the last.
   * @param sessionId - the session whose visible jobs to mirror.
   * @returns stop function releasing this watcher's reference.
   */
  watchRows(sessionId: SessionId): () => void
  /**
   * Start observing one job's live output; reference-counted, so two viewers
   * of the same job share one stream.
   * @param sessionId - owning session used for the fenced read; undefined for an unowned job.
   * @param id - job to observe.
   * @returns stop function releasing this observer's reference.
   */
  observe(sessionId: SessionId | undefined, id: JobId): () => void
  /**
   * Kill one background job from a session's job list. Pure RPC passthrough:
   * row state converges through the roster stream, and the caller (the
   * job-list control) owns error presentation.
   * @param sessionId - session whose job list carries the job.
   * @param id - the job row's registry id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>>
}

// 一条带引用计数的流。
/** One reference-counted stream. */
interface StreamEntry {
  // 当前引用数。
  refs: number
  // 流是否已被停止。
  stopped: boolean
  // 释放该流的清理函数。
  dispose: () => Promise<void>
}

// 模块扩充：在 Cordis Context 上登记客户端 jobs 服务。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // 不依赖 React 的客户端任务花名册与观察控制。
    /** React-free client job rosters and observation control. */
    jobs: IJobs
  }
}

// 拥有裸任务快照以及按会话与按任务的流。
/** Owns the bare jobs snapshot and the per-session and per-job streams. */
export class ClientJobs extends Service implements IJobs {
  // 对外暴露的共享状态（即模型）。
  readonly state: JobsSource
  // 花名册流的引用计数表：按会话 id 键。
  private readonly rowsEntries = new Map<string, StreamEntry>()
  // 观察流的引用计数表：按任务 id 键。
  private readonly observations = new Map<string, StreamEntry>()

  /**
   * @param ctx - client root Context.
   * @param remote - the Gateway stream factory plus the generated `job` namespace, both resolved by the caller.
   * @param model - shared client jobs model.
   */
  constructor(
    ctx: Context,
    private readonly remote: JobsRemote,
    private readonly model: ClientJobsModel,
  ) {
    // 调用服务基类：服务名 jobs。
    super(ctx, 'jobs')
    // 状态即共享模型。
    this.state = model
    // 注册卸载效果：纤程卸载时停止并清理所有流。
    ctx.effect(() => async () => {
      // 汇集所有仍打开的流条目。
      const open = [...this.rowsEntries.values(), ...this.observations.values()]
      // 立即清空两张表。
      this.rowsEntries.clear()
      this.observations.clear()
      // 先全部标记停止，防止新的消费再进入。
      for (const entry of open) entry.stopped = true
      // Cordis awaits an async disposer, so the fiber stays unloading until
      // every carrier iterator has closed and a successor plugin instance
      // cannot overlap one. A carrier whose teardown fails is stopped all the
      // same; its failure has no consumer here.
      // Cordis 会等待异步清理器，因此纤程在所有载体迭代器关闭之前保持卸载中，
      // 后继插件实例也就不会与之一同重叠。清理失败的载体同样被停止；
      // 其失败在此处没有消费者。
      await Promise.allSettled(open.map(entry => entry.dispose()))
    }, 'job-controller.client.streams')
  }

  // 人工击杀透传：直接转发到远端 kill。
  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>> {
    return this.remote.job.kill({ sessionId, jobId: id })
  }

  // 让某会话的花名册保持最新：引用计数，两个观察者共享一条流。
  watchRows(sessionId: SessionId): () => void {
    return this.acquire(
      this.rowsEntries,
      // 键为会话 id 的字符串形式。
      String(sessionId),
      // 首个引用到来时启动花名册流。
      () => this.startRows(sessionId),
      // 最后一个引用离开且无后继时清空模型花名册。
      () => { this.model.rowsDropped(sessionId) },
    )
  }

  // 开始观察一个任务的实时输出：引用计数，两个查看者共享一条流。
  observe(sessionId: SessionId | undefined, id: JobId): () => void {
    return this.acquire(
      this.observations,
      // 键为任务 id 的字符串形式。
      String(id),
      // 首个引用到来时启动观察流。
      () => this.startObservation(sessionId, id),
      // 最后一个引用离开且无后继时通知模型观察已停止。
      () => { this.model.observeStopped(id) },
    )
  }

  // 复用 `key` 下仍存活的条目或启动新条目，并交回其释放函数。
  /** Share the live entry under `key` or start one, and hand back its release. */
  private acquire(
    entries: Map<string, StreamEntry>,
    key: string,
    start: () => StreamEntry,
    cleared: () => void,
  ): () => void {
    // 查找现存条目。
    const existing = entries.get(key)
    // 存活条目存在：仅增加引用并复用。
    if (existing !== undefined && !existing.stopped) {
      existing.refs += 1
      return this.releaser(entries, key, existing, cleared)
    }
    // 无存活条目：启动一条新流并登记。
    const entry = start()
    entries.set(key, entry)
    return this.releaser(entries, key, entry, cleared)
  }

  // 释放闭包绑定其诞生时的确切条目，而不是映射的当前占用者：
  // 同一键上后来的 acquire 可能已替换掉一个已停止的条目，
  // 只凭键做递减或清理会拆掉新流的引用。
  /**
   * Release closures bind the exact entry they were minted for, never the
   * map's current occupant: a later acquire on the same key may have replaced
   * a stopped entry, and decrementing or disposing through the key alone
   * would tear down that newer stream's references.
   */
  private releaser(entries: Map<string, StreamEntry>, key: string, entry: StreamEntry, cleared: () => void): () => void {
    // 幂等保护：本释放函数只能生效一次。
    let released = false
    return () => {
      // 已释放过：直接返回。
      if (released) return
      released = true
      // 减少本条目的引用数。
      entry.refs -= 1
      // 仍有其他引用：流继续存活。
      if (entry.refs > 0) return
      // 仅当映射中该键仍指向本条目时才移除（可能已被后继替换）。
      if (entries.get(key) === entry) entries.delete(key)
      // 标记停止，阻止后续消费。
      entry.stopped = true
      // 异步释放流；完成后视情况清理模型状态。
      void entry.dispose().then(() => {
        // Clear the state only while no successor holds the key: a re-acquire
        // inside the dispose round-trip already refilled the model, and a
        // stale clear would blank it for good.
        // 只有在没有后继占用该键时才清理状态：清理往返期间的重取
        // 已经重新填充了模型，过期的清理会把它永久清空。
        if (entries.has(key)) return
        cleared()
      })
    }
  }

  // 启动某会话的花名册流条目。
  private startRows(sessionId: SessionId): StreamEntry {
    // 流名称：用于诊断。
    const name = `job rows ${String(sessionId)}`
    // 建立底层载体流：打开时调用远端 list。
    const stream = this.remote.$stream<JobListFrame>({
      // 流名称。
      name,
      // 打开函数：以给定信号请求花名册流。
      open: signal => this.remote.job.list({ sessionId }, signal),
      // The roster has no natural end while it is watched: an end after the
      // first frame is a carrier interruption (a Host reload closes the
      // generation) and the next generation's whole set loses nothing. An end
      // before the first frame is terminal.
      // 被观察期间花名册没有自然终点：首帧之后的结束是载体中断
      // （Host 重载会关闭世代），下一世代的整集不会丢失任何内容。
      // 首帧之前的结束则是终态失败。
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before release`)
        : new Error(`${name} ended before its first frame`),
    })
    // 组装流条目：初始引用 1，清理即释放载体流。
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    // 后台消费循环：把每帧整集写入模型并确认。
    void (async () => {
      try {
        // 逐帧消费流。
        for await (const item of stream) {
          // 整集替换该会话的花名册。
          this.model.rowsReplaced(sessionId, item.value.jobs)
          // 确认该帧已处理。
          item.accept()
        }
      } catch {
        // A terminal stream failure leaves nothing current to show; the model
        // drops the roster rather than keeping a stale set on screen.
        // 终态流失败后没有可展示的当前状态；模型直接丢弃花名册，
        // 而不是让屏幕上留着过期集合。
        if (!entry.stopped) this.model.rowsDropped(sessionId)
      } finally {
        // 收尾：标记停止并释放流。
        entry.stopped = true
        void entry.dispose()
      }
    })()
    // 返回条目供引用计数。
    return entry
  }

  // 启动某任务的观察流条目。
  private startObservation(sessionId: SessionId | undefined, id: JobId): StreamEntry {
    // 流名称：用于诊断。
    const name = `job observation ${String(id)}`
    // 建立底层载体流：打开时从模型游标处续读。
    const stream = this.remote.$stream<JobFollowFrame>({
      // 流名称。
      name,
      // 打开函数：取模型当前游标，缺省时从最旧保留字节开始。
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.job.follow(
          {
            jobId: id,
            // 有拥有会话则带上；无主任务省略。
            ...sessionId !== undefined ? { sessionId } : {},
            // 有游标则从该偏移续读；否则由服务端从最旧字节开始。
            ...from !== undefined ? { from } : {},
          },
          signal,
        )
      },
      // A premature end after the anchor is retryable (a Host reload closes the
      // generation); resuming from the cursor loses nothing. An end before the
      // anchor is terminal.
      // 锚点之后的过早结束可重试（Host 重载会关闭世代）；从游标续读不丢内容。
      // 锚点之前的结束则是终态失败。
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before settlement`)
        : new Error(`${name} ended before its anchor`),
    })
    // 组装流条目：初始引用 1，清理即释放载体流。
    const entry: StreamEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    // 后台消费循环：按帧类型分派到模型。
    void (async () => {
      try {
        // 逐帧消费流。
        for await (const item of stream) {
          // 取出当前帧。
          const frame = item.value
          // opened 锚点帧：登记观察打开并确认。
          if (frame.type === 'opened') {
            this.model.observeOpened(id, frame)
            item.accept()
            continue
          }
          // output 帧：追加输出到模型。
          if (frame.type === 'output') {
            this.model.observeOutput(id, frame)
            continue
          }
          // Terminal status: leave the loop before the generation end is
          // classified, then close the stream for good.
          // 终态 status 帧：在世代结束被分类之前就退出循环，并彻底关闭流。
          this.model.observeSettled(id)
          break
        }
      } catch (error) {
        // 非主动停止的失败：通知模型观察失败。
        if (!entry.stopped) this.model.observeFailed(id, error)
      } finally {
        // 收尾：标记停止并释放流。
        entry.stopped = true
        void entry.dispose()
      }
    })()
    // 返回条目供引用计数。
    return entry
  }
}
