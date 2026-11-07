// 存活的 Session（会话）投影状态：带重连基线（reconnect baseline）。
/** Live Session projection state with reconnect baselines. */

// cordis 的 Context 类型：宿主（Host）依赖注入上下文。
import type { Context } from '@deepseek-ai/cordis'
// Deque（双端队列）：控制帧缓冲使用的数据结构。
import { Deque } from '@deepseek-ai/dsh-deque'
// Session 实体与 SessionId（会话 id）品牌类型。
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
// 本包类型：控制基线/帧、投影基线与投影更新值。
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionUpdate,
  SessionProjectionValues,
} from './types.ts'

// 宿主级（Host-wide）Session 控制流的持有者。
/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  // 当前已接入的控制流队列集合：广播帧的目标集合。
  private readonly streams = new Set<ControlQueue>()

  // 构造时挂接投影变更事件与清理副作用（effect）。
  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    // 订阅投影事件变化：任何会话的投影值变化都广播为一条 projection 帧。
    ctx.sessionProjections.onEventChanged((session, changes, seq) => {
      this.broadcast({
        // 帧类型：投影更新。
        type: 'projection',
        // 目标会话 id。
        sessionId: session.id,
        // 观察到变化时的会话序号。
        seq,
        // Every projection definition validates its value before change publication.
        // 每个投影定义在发布变更前都已自行校验过值，这里直接透传。
        changes: changes as SessionProjectionUpdate['changes'],
      })
    })
    // 注册清理副作用：控制器销毁时结束所有队列并清空集合。
    ctx.effect(() => () => {
      // 逐个结束存活的控制流。
      for (const stream of this.streams) stream.end()
      // 清空队列集合，释放引用。
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  // 打开一代宿主级实时控制状态：先产出完整基线，再持续产出替换帧。
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    // 已取消则立刻抛出，避免开启无用的流。
    signal.throwIfAborted()
    // 为本次连接新建一个专用队列。
    const queue = new ControlQueue()
    // 登记进集合，使其能接收后续广播。
    this.streams.add(queue)
    try {
      // 产出完整基线：订阅者据此重建全部控制状态。
      yield { type: 'baseline', value: this.baseline() }
      // 委托队列持续产出后续实时帧，直到结束或取消。
      yield* queue.iterate(signal)
    } finally {
      // 无论正常结束还是取消，都要从广播集合中摘除本队列。
      this.streams.delete(queue)
      // 并把队列标记为结束，唤醒可能仍在等待的迭代。
      queue.end()
    }
  }

  // 构建控制基线：当前全部会话的投影快照。
  private baseline(): SessionControlBaseline {
    // 列出宿主当前的所有会话。
    const sessions = this.ctx.sessions.list()
    return {
      // 仅包含投影基线一块。
      projections: this.projectionBaseline(sessions),
    }
  }

  // 为每个会话收集投影基线，形成 id 到基线的映射。
  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    // 用无原型对象做映射，避免 Object.prototype 键名冲突。
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    // 逐会话读取投影快照。
    for (const session of sessions) {
      // 从会话投影服务取该会话的当前快照。
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      blocks[session.id] = {
        // 快照截至的事件序号（asOfSeq）。
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        // 每个投影定义在快照发布前都已自行校验过值，这里直接透传。
        values: snapshot.values as SessionProjectionValues,
      }
    }
    // 返回完整映射。
    return blocks
  }

  // 向所有存活队列广播一帧控制帧。
  private broadcast(frame: SessionControlFrame): void {
    // 逐个推入队列；已结束的队列自行丢弃。
    for (const stream of this.streams) stream.push(frame)
  }
}

// 控制队列：单连接的控制帧缓冲，用唤醒（wake）机制桥接推送与异步迭代。
class ControlQueue {
  // 待产出的帧缓冲。
  private readonly buffer = new Deque<SessionControlFrame>()
  // 等待新帧的迭代者设置的唤醒回调。
  private wake: (() => void) | undefined
  // 结束标志：置位后不再接收新帧。
  private done = false

  // 推入一帧；若迭代者正在等待则立刻唤醒。
  push(frame: SessionControlFrame): void {
    // 已结束：丢弃帧，不再接收。
    if (this.done) return
    // 帧入队尾部。
    this.buffer.pushBack(frame)
    // 取出当前等待者并清空字段。
    const wake = this.wake
    this.wake = undefined
    // 唤醒迭代者继续消费。
    wake?.()
  }

  // 结束队列：置位并唤醒等待者，使其自然退出循环。
  end(): void {
    // 幂等：已结束则忽略。
    if (this.done) return
    // 标记结束。
    this.done = true
    // 取出等待者并清空字段。
    const wake = this.wake
    this.wake = undefined
    // 唤醒等待者去检查 done 标志。
    wake?.()
  }

  // 异步迭代：产出缓冲中的帧，直到队列结束或取消信号触发。
  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    // 取消监听器：取消时直接结束本队列。
    const onAbort = (): void => { this.end() }
    // 注册一次性 abort 监听。
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // 主循环：未结束且未取消时持续消费。
      while (!this.done && !signal.aborted) {
        // 尝试从缓冲头部取一帧。
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          // 有帧：产出后继续取下一帧。
          yield frame
          continue
        }
        // 缓冲为空：挂起等待，直到 push/end 设置的唤醒回调触发。
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      // 收尾循环：结束后若缓冲仍有剩余帧且未取消，则全部产出（保持最终基线完整）。
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      // 无论如何都要移除取消监听。
      signal.removeEventListener('abort', onAbort)
      // 并结束队列，防止后续 push 悬挂。
      this.end()
    }
  }
}
