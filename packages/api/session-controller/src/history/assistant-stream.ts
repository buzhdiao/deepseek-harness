// 助手流（assistant stream）的基线与每条连接的订阅管理。
/** Assistant stream baselines and per-connection subscriptions. */

// cordis 的 Context 类型：宿主（Host）依赖注入上下文。
import type { Context } from '@deepseek-ai/cordis'
// SessionSeq（会话序号）：把普通数字收窄为持久化序号品牌类型。
import { SessionSeq } from '@deepseek-ai/dsh-session'
// Session 实体与 SessionId（会话 id）品牌类型。
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// JsonValue（JSON 值）：流块（chunk）对外类型标注。
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// 会话助手流累积器：把稠密 Agent 帧折叠成重连基线。
import { SessionAssistantStreamAccumulator } from '../assistant-stream.ts'
// 本包类型：助手流重连基线与流帧。
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '../types.ts'
// ListenerBuffer（监听器缓冲）：连接共享的原始通知缓冲。
import { ListenerBuffer } from './listener.ts'

// 每个存活会话一个累积器（accumulator）：绑定到它的全部订阅共享同一份状态。
/** One accumulator per live Session, shared by every subscription bound to it. */
export class SessionAssistantStreamsListener {
  // 会话 id 到累积器的映射：懒创建，随会话销毁移除。
  private readonly streams = new Map<SessionId, SessionAssistantStreamAccumulator>()

  // 构造时订阅全局 Agent 流事件并注册清理副作用。
  /** @param ctx - service context owning the accumulator listeners. */
  constructor(private readonly ctx: Context) {
    // 订阅 agent/assistant-stream：把每帧折叠进对应会话的累积器。
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      // 查找该会话已有的累积器。
      let stream = this.streams.get(agent.session.id)
      if (stream === undefined) {
        // 不存在则新建并登记。
        stream = new SessionAssistantStreamAccumulator()
        this.streams.set(agent.session.id, stream)
      }
      // 折叠当前帧；持久游标取会话当前序号的前一位（序号 0 时用 -1 表示尚无历史）。
      stream.accept(frame, agent.session.seq === 0 ? -1 : SessionSeq(agent.session.seq - 1))
    }, { global: true })
    // 订阅 agent/disposed：会话销毁时移除其累积器，释放内存。
    ctx.on('agent/disposed', ({ agent }) => { this.streams.delete(agent.session.id) }, { global: true })
    // 注册清理副作用：宿主关闭时清空全部累积器。
    ctx.effect(() => () => { this.streams.clear() }, 'session-controller.assistant-streams')
  }

  /**
   * Bind one connection to a Session assistant stream.
   * @param sessionId - Session to subscribe.
   * @param signal - cancellation owned by the caller.
   * @param queue - caller-owned raw notification buffer.
   * @returns a listener the caller disposes.
   */
  // 把一条连接绑定到指定会话的助手流；快照读取器延迟到监听器内部求值。
  bind(sessionId: SessionId, signal: AbortSignal,
    queue: Pick<ListenerBuffer<AssistantEntry>, 'createInput' | 'capture'>): AssistantStreamListener {
    // 新建监听器：传入快照读取函数（无累积器时回退到修订号 0 的空基线）。
    return new AssistantStreamListener(this.ctx, sessionId, signal, () => {
      return this.streams.get(sessionId)?.snapshot() ?? { revision: 0 }
    }, queue)
  }
}

// 助手流条目：连接缓冲中流转的最小单元。
type AssistantEntry = { type: 'assistant-stream'; frame: SessionAssistantStreamFrame }

// 一条助手通知及其在连接本地的到达序位（ordinal）。
/** An assistant notification and its connection-local arrival position. */
interface AssistantItem {
  // 固定类型标记。
  readonly type: 'assistant-stream'
  // 通知所属的存活会话。
  readonly session: Session
  // 转换成线上形状后的流帧。
  readonly frame: SessionAssistantStreamFrame
  // 本连接内的单调递增序位：用于实现"快照截断"去重。
  readonly ordinal: number
}

// 把助手通知写进连接的共享队列；实现 Disposable 以便注销全部全局监听。
/** Writes assistant notifications into the connection's shared queue. */
class AssistantStreamListener implements Disposable {
  // 注册的全部反注册回调：dispose 时统一执行。
  private readonly disposes: (() => void)[] = []
  // 本连接已见通知的序位计数器。
  private ordinal = 0
  // 快照截断点（cut）：低于等于该序位的通知不再转发。
  private cut = 0

  constructor(
    ctx: Context,
    sessionId: SessionId,
    signal: AbortSignal,
    private _snapshot: () => SessionAssistantStreamBaseline,
    output: Pick<ListenerBuffer<AssistantEntry>, 'createInput' | 'capture'>) {
    // 构造前先确认未取消，避免为已取消的连接安装监听。
    signal.throwIfAborted()
    // 在共享缓冲上创建输入端：条目先经 transform 过滤再进入队列。
    const input = output.createInput<AssistantItem>(item => this.transform(item))
    try {
      // 订阅全局 agent/assistant-stream，登记反注册回调。
      this.disposes.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        // 只处理本会话的帧。
        if (agent.session.id !== sessionId) return
        // capture 保证同连接的写入顺序一致。
        output.capture(() => {
          // 把 Agent 帧转换成线上（wire）形状：start 帧补 startedAfterSeq，chunk 帧把块断言为 JSON 值，其余原样。
          const wire: SessionAssistantStreamFrame = frame.type === 'start'
            ? { ...frame, startedAfterSeq: agent.session.seq === 0 ? -1 : SessionSeq(agent.session.seq - 1) }
            : frame.type === 'chunk' ? { ...frame, chunk: frame.chunk as JsonValue } : frame
          // 追加条目并递增本地序位。
          input.append({ type: 'assistant-stream', session: agent.session, frame: wire, ordinal: ++this.ordinal })
        })
      }, { global: true }))
    } catch (error: unknown) {
      // 订阅失败：释放已注册的部分监听，避免泄漏。
      this[Symbol.dispose]()
      throw error
    }
  }

  // 同步一起捕获基线与本地到达截断点，保证两者一致。
  /** @returns the baseline and local arrival cut captured synchronously together. */
  snapshot(): { baseline: SessionAssistantStreamBaseline; ordinal: number } {
    return { baseline: this._snapshot(), ordinal: this.ordinal }
  }

  // 消费队列前设置本地快照截断点。
  /** @param ordinal - local snapshot cut set before queue consumption. */
  setOrdinalCut(ordinal: number): void {
    this.cut = ordinal
  }

  // 条目过滤：监听未销毁且序位晚于截断点时才产出条目。
  private *transform(item: AssistantItem): Iterable<AssistantEntry> {
    // 已销毁或已被快照覆盖的旧通知直接丢弃。
    if (this.disposes.length === 0 || item.ordinal <= this.cut) return
    // 产出缓冲所需的最小条目形状。
    yield { type: 'assistant-stream', frame: item.frame }
  }

  // 销毁：逆序执行全部反注册回调。
  [Symbol.dispose](): void {
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
  }
}
