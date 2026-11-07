// 与 React 解耦的客户端任务状态：每个被监视会话可见的名册(roster)（由 `job.list` 帧喂入），
// 以及每个任务的累计输出视图（由 `job.follow` 帧喂入）。只有纯数据与订阅——传输接线留在客户端服务，UI 留在插槽组件。
/**
 * React-free client job state: the roster each watched session can see, fed
 * by `job.list` frames, and per-job accumulated output views fed by
 * `job.follow` frames. Pure data plus subscriptions — transport wiring stays
 * in the client service, UI stays in slot components.
 * @module @deepseek-ai/dsh-api-job-controller/client/model
 */

// 引入订阅通知助手：以类别标记唤醒监听器。
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
// 引入任务身份(J jobId)品牌类型。
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
// 引入任务视图(JobView)：名册行的只读投影。
import type { JobView } from '@deepseek-ai/dsh-jobs/view'
// 引入会话身份(SessionId)品牌类型。
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 引入 `job.follow` 的下行帧类型。
import type { JobFollowFrame } from '../types.ts'

/** Bounded per-job render tail, in UTF-16 code units. */
// 每个任务有界的渲染尾部上限，单位为 UTF-16 码元：128 Ki 字符。
const RENDER_TAIL_LIMIT = 128 * 1024

/** One observed job's live view state. */
// 单个被观测任务的实时视图状态。
export interface ObservedJob {
  // 任务身份。
  readonly jobId: JobId
  /** Accumulated output tail, bounded to the render limit. */
  // 累计输出尾部，截断到渲染上限以内。
  readonly text: string
  /** True when bytes before {@link text} were dropped (eviction, resume gap, or the render bound). */
  // 当 text 之前有字节被丢弃（环形淘汰、续传缺口或触达渲染上限）时为真。
  readonly gapBefore: boolean
  /** True while the observation stream is open and the job has not settled. */
  // 观测流仍打开且任务尚未落定(settled)时为真。
  readonly streaming: boolean
  /** Terminal observation failure, when the stream ended abnormally. */
  // 观测流异常结束时的终态失败信息。
  readonly error?: string
}

/** Immutable client job state. */
// 不可变的客户端任务快照(snapshot)。
export interface JobsSnapshot {
  /**
   * The jobs each watched session can see, keyed by session id. A session
   * nobody watches, or one that sees no job, has no key, so consumers read
   * absence rather than a sentinel.
   */
  // 每个被监视会话可见的任务，按会话 id 为键；无人监视或看不到任务的会话没有键，消费方读“缺席”而非哨兵值。
  readonly rows: Readonly<Record<string, readonly JobView[]>>
  /** Live observation state keyed by job id. */
  // 按任务 id 为键的实时观测状态。
  readonly observed: Readonly<Record<string, ObservedJob>>
}

/** Bare observable source for the client job snapshot. */
// 客户端任务快照的最小可观察(observable)源接口。
export interface JobsSource {
  /** Read the identity-stable current snapshot. */
  // 读取身份稳定（未变则同一引用）的当前快照。
  getSnapshot(): JobsSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  // 订阅快照失效回调；返回取消订阅函数。
  subscribe(listener: () => void): () => void
}

/** Mutable observation bookkeeping behind one {@link ObservedJob} view. */
// 单个 ObservedJob 视图背后的可变观测簿记。
interface ObservedState {
  // 当前对外暴露的不可变视图。
  view: ObservedJob
  /** Resume offset for the next generation's `from`. */
  // 下一观测代(generation)续传用的偏移量。
  cursor: number | undefined
}

/** Owns the per-session rosters and per-job observation state. */
// 持有按会话的名册与按任务的观测状态。
export class ClientJobsModel implements JobsSource {
  // 按会话 id 缓存的名册。
  private readonly rowsBySession = new Map<string, readonly JobView[]>()
  // 按任务 id 缓存的观测簿记。
  private readonly observedStates = new Map<string, ObservedState>()
  // 失效监听器集合。
  private readonly listeners = new Set<() => void>()
  // 快照缓存：仅在脏标记置位时重建，保证 getSnapshot 返回同一引用。
  private snapshotCache: JobsSnapshot = { rows: {}, observed: {} }
  // 脏标记：状态变更后置位，下次读取时重建快照。
  private snapshotDirty = false

  // 读取当前快照；脏时把两个 Map 摊平成普通对象并重建缓存。
  getSnapshot(): JobsSnapshot {
    if (this.snapshotDirty) {
      // 重建名册部分：Map 转普通对象。
      const rows: Record<string, readonly JobView[]> = {}
      for (const [id, jobs] of this.rowsBySession) rows[id] = jobs
      // 重建观测部分：只暴露不可变视图。
      const observed: Record<string, ObservedJob> = {}
      for (const [id, state] of this.observedStates) observed[id] = state.view
      // 写回缓存并清除脏标记。
      this.snapshotCache = { rows, observed }
      this.snapshotDirty = false
    }
    // 返回缓存的快照，引用在未变更期间保持稳定。
    return this.snapshotCache
  }

  // 注册失效监听器，返回取消订阅的闭包。
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace one session's roster with a `rows` frame's whole set. An empty
   * set is stored as an absent key.
   * @param sessionId - the watched session.
   * @param jobs - the complete visible set.
   */
  // 用 `rows` 帧的整体集合替换某个会话的名册；空集合按“无键”处理。
  rowsReplaced(sessionId: SessionId, jobs: readonly JobView[]): void {
    // 会话 id 统一转成字符串键。
    const key = String(sessionId)
    if (jobs.length === 0) {
      // 空集合：删除键；键本就不存在则无需通知。
      if (!this.rowsBySession.delete(key)) return
    } else {
      // 非空：整体替换该会话的名册。
      this.rowsBySession.set(key, jobs)
    }
    // 状态已变，通知订阅者。
    this.changed()
  }

  /**
   * Drop one session's roster after its last watcher stops or its stream fails.
   * @param sessionId - the no-longer-watched session.
   */
  // 在最后一个监视者停止或其流失败后丢弃某会话的名册。
  rowsDropped(sessionId: SessionId): void {
    // 键不存在则无事发生。
    if (!this.rowsBySession.delete(String(sessionId))) return
    this.changed()
  }

  /**
   * The resume offset for one job's next observation generation.
   * @param id - observed job.
   * @returns the last accepted `next`, or undefined for a fresh observation.
   */
  // 读取某任务下一观测代的续传偏移：最近一次接受的 `next`，全新观测则为 undefined。
  cursorOf(id: JobId): number | undefined {
    return this.observedStates.get(String(id))?.cursor
  }

  /**
   * Install or reset observation state when a generation's anchor arrives.
   * @param id - observed job.
   * @param frame - the generation's `opened` anchor.
   */
  // 当某观测代的 `opened` 锚点帧到达时，安装或重置观测状态。
  observeOpened(id: JobId, frame: Extract<JobFollowFrame, { type: 'opened' }>): void {
    // 取既有簿记（若有）。
    const existing = this.observedStates.get(String(id))
    // A fresh view anchored past offset zero starts after an evicted head
    // (fresh observations anchor at the registry's earliest retained byte), so
    // it owes the same gap mark a live observer earned from lossy reads. A
    // resume that already accumulated text keeps its recorded gap state.
    // 锚在偏移 0 之后的全新视图，开头必有一段被淘汰的头部（全新观测锚定在注册表最早保留字节），
    // 因此要像实时观察者遇到有损读取那样打上缺口标记；已累计文本的续传则保留原有缺口状态。
    const freshPastHead = (existing === undefined || existing.view.text === '') && frame.from > 0
    // 组装新视图：沿用既有文本，合并缺口标记，进入流式状态。
    const view: ObservedJob = {
      jobId: id,
      text: existing?.view.text ?? '',
      gapBefore: (existing?.view.gapBefore ?? false) || frame.from < frame.job.output.earliest || freshPastHead,
      streaming: true,
    }
    // 写回簿记，游标设为锚点偏移。
    this.observedStates.set(String(id), { view, cursor: frame.from })
    this.changed()
  }

  /**
   * Append one output frame's chunks to the bounded render tail.
   * @param id - observed job.
   * @param frame - a coalesced `output` frame.
   */
  // 把一个（已合并的）`output` 帧的文本块追加到有界渲染尾部。
  observeOutput(id: JobId, frame: Extract<JobFollowFrame, { type: 'output' }>): void {
    // 取该任务的观测簿记。
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    // 帧只会落在已跟踪任务的 opened 与 stop 之间，理论上不会缺失（测试覆盖豁免）。
    if (state === undefined) return
    // 拼接本帧全部文本块的文本。
    let text = state.view.text + frame.chunks.map(chunk => chunk.text).join('')
    // 缺口标记：沿既有标记，或本帧整体有损，或任一文本块自带缺口。
    let gapBefore = state.view.gapBefore || frame.lossy === true
      || frame.chunks.some(chunk => chunk.gapBefore === true)
    // 超过渲染上限时从头裁剪。
    if (text.length > RENDER_TAIL_LIMIT) {
      // 计算需要截掉的数量。
      let cut = text.length - RENDER_TAIL_LIMIT
      // Never split a surrogate pair at the render bound.
      // 绝不在渲染边界拆散代理对(surrogate pair)：截点落在低代理上就多裁一位。
      const unit = text.charCodeAt(cut)
      if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1
      // 执行裁剪并标记头部有丢字。
      text = text.slice(cut)
      gapBefore = true
    }
    // 以新文本生成不可变视图。
    state.view = { ...state.view, text, gapBefore }
    // 游标推进到帧携带的 `next` 偏移。
    state.cursor = frame.next
    this.changed()
  }

  /**
   * Close the live view once the terminal `status` frame arrived: the ring is
   * drained and the roster row carries the settled projection.
   * @param id - observed job.
   */
  // 终态 `status` 帧到达后关闭实时视图：环形缓冲已排空，名册行承载落定后的投影。
  observeSettled(id: JobId): void {
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    // 同上：终态帧之前必有 opened（测试覆盖豁免）。
    if (state === undefined) return
    // 仅翻转流式标记，保留文本与缺口状态。
    state.view = { ...state.view, streaming: false }
    this.changed()
  }

  /**
   * Record a terminal observation failure.
   * @param id - observed job.
   * @param error - the stream's terminal failure.
   */
  // 记录观测流的终态失败。
  observeFailed(id: JobId, error: unknown): void {
    const state = this.observedStates.get(String(id))
    if (state === undefined) {
      // A failure before the anchor — a rejected request, a job gone between
      // the click and the open — still owes the panel its notice; a later
      // successful anchor replaces this view and resumes from no cursor.
      // 锚点之前的失败（请求被拒、点击与打开之间任务消失）也要让面板看到提示；
      // 之后成功的锚点会替换此视图并从无游标状态重新开始。
      this.observedStates.set(String(id), {
        view: { jobId: id, text: '', gapBefore: false, streaming: false, error: String(error) },
        cursor: undefined,
      })
      this.changed()
      return
    }
    // 已有簿记：停止流式标记并记录错误。
    state.view = { ...state.view, streaming: false, error: String(error) }
    this.changed()
  }

  /**
   * Drop observation state after the last observer stops.
   * @param id - the no-longer-observed job.
   */
  // 最后一个观察者停止后丢弃该任务的观测状态。
  observeStopped(id: JobId): void {
    if (!this.observedStates.delete(String(id))) return
    this.changed()
  }

  // 私有：置脏并通知订阅者，类别标记为 'jobs'。
  private changed(): void {
    this.snapshotDirty = true
    notifySubscribers(this.listeners, 'jobs')
  }
}
