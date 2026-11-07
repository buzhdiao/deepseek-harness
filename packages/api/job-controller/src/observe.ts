// 模块说明：按任务划分的观察（observation）世代——锚点、合并输出、终态状态。
/** Per-job observation generations: anchor, coalesced output, terminal status. */

// JobId（任务 id）品牌类型：观察的目标任务标识。
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
// jobs 包类型：输出块、注册表、任务状态、任务视图。
import type { JobChunk, JobRegistry, JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
// 本包类型：follow 流的请求与帧。
import type { JobFollowFrame, JobFollowRequest } from './types.ts'
// 复用唤醒工具：OutputWaiter 等待注册表事件，sleep 做合并窗口。
import { OutputWaiter, sleep } from './wake.ts'

// 单个观察世代的节奏与分帧上限配置。
/** Cadence and framing bounds for one observation generation. */
export interface ObserveJobOptions {
  // 唤醒之后、读取之前的合并窗口，毫秒。
  /** Coalescing window after a wake before reading, in milliseconds. */
  readonly flushMs: number
  // 每个 `output` 帧的软字节预算。累计块达到预算即冲刷；
  // 单块超过预算时整体发出（注册表的保留上限是单块的硬边界）。
  /**
   * Soft byte budget per `output` frame. Accumulated chunks flush once the
   * budget is met; one chunk larger than the budget ships whole (the
   * registry's retention cap is the hard bound on any single chunk).
   */
  readonly maxFrameBytes: number
}

// 判断任务状态是否已到达终态：running 与 stopping 之外都算终态。
function isTerminal(status: JobStatus): boolean {
  return status !== 'running' && status !== 'stopping'
}

// 从绝对偏移开始流式输出一个任务的保留输出：先一帧 `opened` 锚点，环形缓冲推进时
// 输出合并的 `output` 帧，任务结算并排空后给出一帧终态 `status`，随后世代正常关闭。
// 世代中途宣布的移除（拥有者的清理）会以被移除任务的终态投影关闭流，而不是以读取失败收场。
// 读取是非消费（non-consuming）的——面向模型的游标与通知状态不会感知它们；
// 重连的调用方把上一帧的 `next` 作为 `from` 即可续读。请求中的会话即围栏（fenced）
// 读取的调用者：注册表会拒绝该会话不可见的任务与未知任务。
/**
 * Stream one job's retained output from an absolute offset: one `opened`
 * anchor, coalesced `output` frames as the ring advances, then one terminal
 * `status` after the settled job is drained, after which the generation
 * closes normally. A removal announced mid-generation (the owner's teardown)
 * closes it with the removed job's terminal projection instead of a failed
 * read. Reads are non-consuming — the model-facing cursor and
 * notice state never observe them; reconnecting callers resume by passing
 * the last frame's `next` as `from`. The request's session is the fenced
 * read's caller: the registry rejects a job the session cannot see and an
 * unknown job.
 * @param registry - the live job registry.
 * @param request - target job, owning session, and optional resume offset.
 * @param options - cadence and framing bounds.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the observation frame sequence for one generation.
 */
export async function* observeJobOutput(
  registry: JobRegistry,
  request: JobFollowRequest,
  options: ObserveJobOptions,
  signal: AbortSignal,
): AsyncIterable<JobFollowFrame> {
  // 校验续读偏移：必须是安全的非负整数，否则直接报错。
  if (request.from !== undefined && (!Number.isSafeInteger(request.from) || request.from < 0)) {
    throw new Error(`invalid observe offset: expected a non-negative safe integer, got ${JSON.stringify(request.from)}`)
  }
  // 进入前检查生成取消：已中止则抛出。
  signal.throwIfAborted()
  // The brand is nominal typing only; the wire boundary stamps it here rather
  // than value-importing the registry package's constructor.
  // 品牌类型只是名义类型标注；在线边界在此处盖上标记，而不是值导入注册表包的构造器。
  const id = String(request.jobId) as JobId
  // 创建唤醒等待器：把注册表事件转化为循环唤醒。
  const waiter = new OutputWaiter()
  // A removal announced during the generation: the owner's teardown settled
  // and dropped the record, so the projection it announced is the last word
  // and the read after the flush window would only find an unknown id.
  // 世代期间宣布的移除：拥有者的清理已结算并丢弃了记录，
  // 因此它宣布的投影就是最终结论；冲刷窗口之后再去读只会得到未知 id。
  let removed: JobView | undefined
  // 必须在锚点读取之前订阅，这样锚点读取与等待之间的追加就不会被漏掉。
  // Subscribe before the first read so an append between the anchor read and
  // the wait cannot be missed.
  const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
    // 取出本次事件触及的任务 id：output 事件直接带 id，其余取事件内任务的 id。
    const changed = event.type === 'output' ? event.id : event.job.id
    // 与目标无关的事件不唤醒。
    if (changed !== id) return
    // 移除事件：记录其宣布的最终任务投影。
    if (event.type === 'removed') removed = event.job
    // 唤醒观察循环。
    waiter.wake()
  })
  try {
    // 读取目标任务的初始投影。
    let job = registry.get(id, request.sessionId)
    // 游标从请求偏移开始；未指定则从保留的最旧字节开始。
    let cursor = request.from ?? job.output.earliest
    // 发出 opened 锚点帧：任务投影与首帧续读偏移。
    yield { type: 'opened', job, from: cursor }
    // 主循环：未取消则持续观察。
    while (!signal.aborted) {
      // 世代期间发生了移除：发出移除时宣布的终态投影并结束。
      if (removed !== undefined) {
        yield { type: 'status', job: removed }
        return
      }
      // 从游标处读取任务输出。
      const read = registry.readAt(id, cursor, request.sessionId)
      // 有新块或发生有损续读：拆分成输出帧发出。
      if (read.chunks.length > 0 || read.lossy) {
        yield* outputFrames(read.chunks, read.next, read.lossy, options.maxFrameBytes)
      }
      // 推进游标到读取返回的下一个偏移。
      cursor = read.next
      // 重新读取任务投影以判断是否终态。
      job = registry.get(id, request.sessionId)
      // 任务已终态且输出全部排空：发出终态 status 帧并正常结束。
      if (isTerminal(job.status) && cursor >= job.output.total) {
        yield { type: 'status', job }
        return
      }
      // 挂起等待下一次注册表事件（或取消）。
      await waiter.wait(signal)
      // Let a burst accumulate so producer chatter becomes bounded frames.
      // 让一小段突发累积起来，使生产者的喋喋不休变成有界帧。
      await sleep(options.flushMs, signal)
    }
  } finally {
    // 结束时取消事件订阅。
    unsubscribe()
  }
}

// 把一次读取按每帧软字节预算拆分成多个输出帧。
/** Split one read into frames along the soft per-frame byte budget. */
function* outputFrames(
  chunks: readonly JobChunk[],
  next: number,
  lossy: boolean,
  maxFrameBytes: number,
): Iterable<JobFollowFrame> {
  // 当前累积的输出块批次。
  let batch: JobChunk[] = []
  // 批次的累计字节数（UTF-8）。
  let batchBytes = 0
  // 有损标记：首个发出的帧需要携带 lossy，之后清零。
  let flaggedLossy = lossy
  // 遍历全部块，按预算切批。
  for (const chunk of chunks) {
    // 把块推入当前批次。
    batch.push(chunk)
    // 累计该块的 UTF-8 字节数。
    batchBytes += Buffer.byteLength(chunk.text, 'utf8')
    // 达到软预算：冲刷当前批次为一帧。
    if (batchBytes >= maxFrameBytes) {
      // 取批次最后一块，用于计算本帧的续读偏移。
      const last = batch[batch.length - 1]
      // 本帧的 next 偏移：最后一块的起点加其字节数（防御分支仅为通过 noUncheckedIndexedAccess）。
      /* v8 ignore start -- a non-empty batch always has a last chunk; the arm only discharges noUncheckedIndexedAccess. */
      const end = last === undefined ? next : last.at + Buffer.byteLength(last.text, 'utf8')
      /* v8 ignore stop */
      // 发出输出帧：携带批次、续读偏移，以及（若有）有损标记。
      yield {
        type: 'output',
        chunks: batch,
        next: end,
        ...flaggedLossy ? { lossy: true as const } : {},
      }
      // 有损标记只随第一帧携带。
      flaggedLossy = false
      // 重置批次，继续累积下一帧。
      batch = []
      batchBytes = 0
    }
  }
  // 循环结束仍有残余批次，或尚有未携带的有损标记：补发一帧。
  if (batch.length > 0 || flaggedLossy) {
    yield {
      type: 'output',
      chunks: batch,
      next,
      ...flaggedLossy ? { lossy: true as const } : {},
    }
  }
}
