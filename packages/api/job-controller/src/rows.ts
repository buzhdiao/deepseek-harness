// 模块说明：按会话（session）划分的“花名册”（roster）世代——调用方可见的任务集合，
// 每次生命周期变更后整体替换一次。
/** Per-session roster generations: the caller-visible job set, replaced whole after every lifecycle change. */

// 任务注册表（JobRegistry）类型：提供任务列表与事件订阅。
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
// 本包的类型：任务列表帧（JobListFrame，流的输出单元）与任务列表请求（JobListRequest）。
import type { JobListFrame, JobListRequest } from './types.ts'
// 复用唤醒（wake）工具：OutputWaiter 用于等待生命周期事件，sleep 用于合并窗口。
import { OutputWaiter, sleep } from './wake.ts'

// 单个花名册世代的节奏上限配置。
/** Cadence bound for one roster generation. */
export interface RowsOptions {
  // 生命周期事件之后、下一次读取任务行（rows）之前的合并（coalescing）窗口，单位毫秒。
  /** Coalescing window after a lifecycle event before the next rows read, in milliseconds. */
  readonly flushMs: number
}

// 流式输出一个会话可见的任务行：打开时先发一帧，之后每逢触及可见任务的生命周期提交
// （注册、进度、停止、结算、移除）都再发一帧，并用 flushMs 合并连续变更。
// 纯输出追加不会刷新花名册——已结算的投影本身就带最终字节数——所以任务只是写入时流保持安静。
// 读取的是投影（projection）；模型的游标与通知状态永远不会感知到它们。
/**
 * Stream the jobs one session can see: one frame on open, then one after
 * every lifecycle commit that touches a visible job (registration, progress,
 * stopping, settlement, removal), coalesced over `flushMs`. Output appends
 * never refresh the roster — a settled projection already carries the final
 * byte count — so the stream is quiet while a job merely writes. Reads are
 * projections; the model's cursor and notice state never observe them.
 * @param registry - the live job registry.
 * @param request - the session whose visible set to mirror.
 * @param options - the coalescing window.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the roster frame sequence for one generation.
 */
export async function* streamJobRows(
  registry: JobRegistry,
  request: JobListRequest,
  options: RowsOptions,
  signal: AbortSignal,
): AsyncIterable<JobListFrame> {
  // 进入前先检查生成取消（AbortSignal）：已中止则直接抛出，避免空转。
  signal.throwIfAborted()
  // 创建唤醒等待器：用于把“发生了生命周期提交”这一事实传递给等待中的循环。
  const waiter = new OutputWaiter()
  // 必须在首次读取之前订阅，这样读取与等待之间发生的提交就不会被漏掉。
  // Subscribe before the first read so a commit between the read and the
  // wait cannot be missed.
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    // 输出事件不会改变可见集合，直接忽略。
    if (event.type === 'output') return
    // 取出事件所属任务的拥有者会话 id。
    const owner = event.job.owner
    // 无主任务（全局可见）或属于请求会话的任务变更才需要唤醒本流。
    if (owner === undefined || owner === request.sessionId) waiter.wake()
  })
  try {
    // 打开时的第一帧：立即给出当前可见任务集合。
    yield { type: 'rows', jobs: registry.list(request.sessionId) }
    // 主循环：等待唤醒→合并窗口→重读并发帧，直到生成被取消。
    while (true) {
      // 挂起等待下一次唤醒（或取消）。
      await waiter.wait(signal)
      // 让一小段突发提交沉淀为一帧，避免抖动。
      // Let a burst of commits settle into one frame.
      await sleep(options.flushMs, signal)
      // 合并等待期间若已被取消，则结束生成器。
      if (signal.aborted) return
      // 发出新的一帧：重新读取当前会话的可见任务列表。
      yield { type: 'rows', jobs: registry.list(request.sessionId) }
    }
  } finally {
    // 无论正常结束还是取消，都取消事件订阅，避免泄漏。
    unsubscribe()
  }
}
