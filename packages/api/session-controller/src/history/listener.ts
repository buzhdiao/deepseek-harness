// 模块说明：每 Session 的被动订阅监听器——EventListener（原始事件通知缓冲与变换）、
// ProjectionListener（投影变化缓冲）与 ListenerBuffer（共享通知缓冲）：先把全局通知
// 缓冲起来，待开启切点（opening cut）确定后再补发未覆盖的历史；订阅从不获取
// （acquire）Session 观测，也不会激活会话。
/** Passive per-Session streams; subscriptions never acquire Session observations. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 导入双端队列（Deque），用作监听缓冲的底层存储
import { Deque } from '@deepseek-ai/dsh-deque'
// 导入 Session 日志偏移工具
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
// 导入 Session、SessionEvent、SessionId 类型
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// 导入远程错误类型
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 导入把事件转换为历史条目的辅助函数
import { entryFor } from '../history.ts'
// 导入投影变化与事件条目的对外类型
import type { SessionProjectionChange, SessionEventEntry } from '../types.ts'

/** 在开启切点（opening cut）确定之前被缓冲的原始历史通知。 */
export type EventItem =
  // event：某 Session 上发生的一个事件通知
  | { readonly type: 'event'; readonly session: Session; readonly event: SessionEvent }
  // created：一个新 Session 被创建的通知（end 为创建时的序列号末尾）
  | { readonly type: 'created'; readonly session: Session; readonly end: number }

/** 单个订阅在任何消费模式开始之前都会先缓冲通知。 */
export class EventListener implements Disposable {
  // 内部拥有的缓冲（仅当由本类创建时才在此释放）
  private readonly buffer: ListenerBuffer<SessionEventEntry> | undefined
  // 注册清理函数列表（事件订阅的撤销函数）
  private readonly disposes: (() => void)[] = []
  // 首次收到的序列号（用于确定起始切点）
  private firstReceivedSeq: number | undefined
  // 下一个期望的序列号（去重与连续性检查）
  private nextExpectedSeq: number | undefined

  /**
   * @param ctx - 拥有事件注册的上下文。
   * @param sessionId - 要发出其通知的 Session。
   * @param signal - 唤醒消费者的取消信号。
   * @param queue - 可选的调用方自有缓冲；只有内部创建的缓冲才会在此释放。
   */
  constructor(ctx: Context, sessionId: SessionId, signal: AbortSignal,
    queue?: Pick<ListenerBuffer<SessionEventEntry>, 'createInput' | 'capture'>) {
    // 信号已取消：立即抛出，不做任何注册
    signal.throwIfAborted()
    // 使用调用方提供的缓冲，否则新建一个内部缓冲
    const buffer = queue ?? new ListenerBuffer(ctx, signal)
    // 只有内部创建的缓冲由本对象持有并在释放时一并销毁
    this.buffer = queue === undefined ? buffer as ListenerBuffer<SessionEventEntry> : undefined
    // 创建该缓冲的一个输入端：每个入队项先经过 transform 变换再被消费
    const input = buffer.createInput<EventItem>(item => this.transform(item))
    // 要订阅的目标会话 id
    const target = sessionId
    try {
      // 订阅全局 session/event 通知：只转发目标会话的事件
      this.disposes.push(ctx.on('session/event', (session, event) => {
        if (session.id !== target) return
        // capture 包裹生产者逻辑：抛错时记下失败并关闭缓冲
        buffer.capture(() => {
          // 记录首次出现的序列号（取最小值，为起始切点做准备）
          this.recordFirst(event.seq)
          // 事件项入队
          input.append({ type: 'event', session, event })
        })
      }, { global: true }))
      // 订阅全局 session/created 通知：目标是新创建的会话本身
      this.disposes.push(ctx.on('session/created', (session) => {
        if (session.id !== target) return
        buffer.capture(() => {
          // 会话在创建时已带有历史（firstLiveSeq < seq）：记录这段遗留历史的起点
          if (session.firstLiveSeq < session.seq) this.recordFirst(session.firstLiveSeq)
          // created 通知插队到队首，保证它先于后续事件被处理
          input.prepend({ type: 'created', session, end: session.seq })
        })
      }, { global: true }))
      // 内部缓冲销毁时联动释放本监听器的注册
      this.buffer?.own(() => { this[Symbol.dispose]() })
    } catch (error: unknown) {
      // 注册失败：先释放已完成的注册再抛出，避免泄漏
      this[Symbol.dispose]()
      throw error
    }
  }

  /** 直接消费通知而不读取历史。
   * @returns 从首个收到的事件开始的事件帧，不加载基线。 */
  events(): AsyncIterable<SessionEventEntry> {
    // 进入内部缓冲的迭代（消费完成后自动释放缓冲）
    return this.iterate()
  }

  /** 为缓冲的历史通知设置包含式的开启切点。
   * @param cursor - 在消费队列之前设置的快照切点。 */
  setCursor(cursor: number): void {
    // 期望的下一个序列号 = 切点 + 1（切点本身已被快照覆盖）
    this.nextExpectedSeq = cursor + 1
  }

  // 变换：把一个原始通知转换为零个或多个历史事件条目
  private *transform(item: EventItem): Iterable<SessionEventEntry> {
    // 监听器已被释放（disposes 被清空）：丢弃通知
    if (this.disposes.length === 0) return
    // 尚未确定期望序列号时，用首次收到的序列号作为起点
    this.nextExpectedSeq ??= this.firstReceivedSeq
    // 由 eventItem 计算该通知覆盖的未消费事件与下一个期望序列号
    const result = eventItem(item, this.nextExpectedSeq)
    // 更新期望序列号
    this.nextExpectedSeq = result.next
    // 逐个产出覆盖到的历史事件
    for (const event of result.events) {
      // 产出过程中监听器被释放：停止产出
      if (this.disposes.length === 0) return
      // 转换为对外的事件条目
      yield entryFor(event)
    }
  }

  // 异步迭代内部缓冲：消费完毕或中断时释放监听器
  private async *iterate(): AsyncIterable<SessionEventEntry> {
    // 外部自有缓冲（queue 参数路径）不允许经此消费
    if (this.buffer === undefined) throw new Error('Consume the externally owned history buffer directly')
    try {
      // 转发缓冲中的所有条目
      yield* this.buffer.items()
    } finally {
      // 消费结束（无论正常结束、错误还是提前退出）：释放监听器
      this[Symbol.dispose]()
    }
  }

  // 记录首次出现的序列号：始终保留最小值
  private recordFirst(seq: number): void {
    this.firstReceivedSeq = this.firstReceivedSeq === undefined ? seq : Math.min(this.firstReceivedSeq, seq)
  }

  // 释放监听器：撤销全部注册并销毁内部缓冲
  [Symbol.dispose](): void {
    // splice(0) 取走全部清理函数并逆序执行（后注册的先撤销）
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
    // 销毁内部拥有的缓冲（外部自有缓冲除外）
    this.buffer?.[Symbol.dispose]()
  }
}

/**
 * 从一个通知中选出其代表的、尚未被覆盖的事件。
 * @param item - 一个被缓冲的通知。
 * @param next - 下一个需要的序列号；首个事件之前为 undefined。
 * @returns 未覆盖的事件与下一个需要的序列号；不获取任何观测。
 */
export function eventItem(item: EventItem, next?: number): {
  events: readonly SessionEvent[]
  next: number | undefined
} {
  // 单事件通知
  if (item.type === 'event') {
    // 事件序列号已被快照覆盖（小于期望值）：跳过
    if (next !== undefined && item.event.seq < next) return { events: [], next }
    // 事件序列号出现跳跃（既不小于也不等于期望值）：流不连续，报内部错误
    if (next !== undefined && item.event.seq !== next) {
      throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(next)}`, {})
    }
    // 正常：返回该事件并把期望推进到下一个序列号
    return { events: [item.event], next: item.event.seq + 1 }
  }
  // created 通知：起点取已确定的期望值，否则取会话的 firstLiveSeq（创建时即带历史的情况）
  const start = next ?? item.session.firstLiveSeq
  // 起点已达或超过创建末尾：没有需要补发的历史
  if (start >= item.end) return { events: [], next }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session-created history adaptation.
  // 从会话快照中取出 [start, end) 区间的遗留历史事件（既有的会话创建历史适配）
  const events = item.session.snapshotEvents(SessionLogOffset(start), SessionLogOffset(item.end))
  // 校验补发事件的连续性
  for (const event of events) {
    // 出现跳跃：报内部错误
    if (next !== undefined && event.seq !== next) {
      throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(next)}`, {})
    }
    // 期望推进到下一个序列号
    next = event.seq + 1
  }
  // 返回补发的事件与推进后的期望值
  return { events, next }
}

/** 一个 Session 的投影变化；每个改变了某投影的已提交事件产生一条变化。 */
export class ProjectionListener implements Disposable {
  // 该监听器私有的通知缓冲
  private readonly buffer: ListenerBuffer<{ session: Session; change: SessionProjectionChange }>

  /**
   * @param ctx - 拥有投影通知的上下文。
   * @param sessionId - 要发出其通知的 Session。
   * @param signal - 移除注册并唤醒消费者的取消信号。
   */
  constructor(ctx: Context, sessionId: SessionId, signal: AbortSignal) {
    // 新建内部缓冲
    this.buffer = new ListenerBuffer(ctx, signal)
    // 创建输入端：投影通知项直接透传
    const input = this.buffer.createInput<{ session: Session; change: SessionProjectionChange }>(item => [item])
    // 要订阅的目标会话 id
    const target = sessionId
    try {
      // 订阅投影服务的事件级变化回调，并把其撤销注册到缓冲的清理列表
      this.buffer.own(ctx.sessionProjections.onEventChanged((session, changes, seq) => {
        if (session.id !== target) return
        // capture 包裹生产者逻辑：抛错时记下失败并关闭缓冲
        this.buffer.capture(() => {
          // Every projection definition validates its value before change publication.
          // 构造投影变化帧（每个投影定义在发布变化前都会校验其值）
          const change: SessionProjectionChange = { type: 'projection', seq, changes: changes as SessionProjectionChange['changes'] }
          // 变化项入队
          input.append({ session, change })
        })
      }))
    } catch (error: unknown) {
      // 注册失败：释放缓冲再抛出
      this.buffer[Symbol.dispose]()
      throw error
    }
  }

  /** 按事件消费投影变化。
   * @returns 已校验的变化帧，每个已提交事件一条；投影序列号不要求连续。 */
  async *changes(): AsyncIterable<SessionProjectionChange> {
    try {
      // 逐项读取缓冲并只产出变化帧
      for await (const { change } of this.buffer.items()) {
        yield change
      }
    } finally {
      // 消费结束（无论何种方式退出）：释放监听器
      this[Symbol.dispose]()
    }
  }

  // 释放监听器：销毁缓冲
  [Symbol.dispose](): void {
    this.buffer[Symbol.dispose]()
  }
}

/** 为单个消费者拥有缓冲、生产者失败处理与注册清理。 */
export class ListenerBuffer<T> implements Disposable {
  // 原始值队列（与 transformIds 一一配对）
  private readonly values = new Deque<unknown>()
  // 每个值对应的变换（transform）编号队列
  private readonly transformIds = new Deque<number>()
  // 已注册的变换函数列表（按注册顺序编号）
  private readonly transforms: ((value: unknown) => Iterable<T>)[] = []
  // 清理函数列表（注册撤销、信号监听移除等）
  private readonly cleanup: (() => void)[] = []
  // 消费者等待新值时的唤醒函数
  private wake: (() => void) | undefined
  // 缓冲是否已关闭
  private closed = false
  // 生产者侧捕获的失败（错误容器）
  private failure: { readonly error: unknown } | undefined
  // 缓冲是否已被消费过（只允许一个消费者）
  private consumed = false

  constructor(ctx: Context, signal: AbortSignal) {
    // 信号已取消：立即抛出，不做任何注册
    signal.throwIfAborted()
    // 信号中止时关闭缓冲（once：只触发一次）
    const close = (): void => { this[Symbol.dispose]() }
    signal.addEventListener('abort', close, { once: true })
    // 信号监听器也要注册进清理列表，避免泄漏
    this.own(() => { signal.removeEventListener('abort', close) })
    try {
      // 注册一个上下文副作用：宿主销毁时关闭缓冲，撤销函数交给清理列表
      const dispose = ctx.effect(() => close, 'session-controller.listener-buffer')
      this.own(() => { void dispose() })
    } catch (error: unknown) {
      // 注册失败：释放已注册的部分再抛出
      this[Symbol.dispose]()
      throw error
    }
  }

  /**
   * 注册清理逻辑；缓冲已关闭时立即执行。
   * @param dispose - 同步清理函数。
   */
  own(dispose: () => void): void {
    if (this.closed) dispose()
    else this.cleanup.push(dispose)
  }

  /**
   * 包裹生产者操作：捕获其失败并用该失败唤醒消费者。
   * @param action - 同步的生产者操作。
   */
  capture(action: () => void): void {
    // 缓冲已关闭：丢弃这次生产
    if (this.closed) return
    try {
      // 执行生产者逻辑
      action()
    } catch (error: unknown) {
      // 记录失败并关闭缓冲，让消费者在迭代中看到该错误
      this.failure = { error }
      this[Symbol.dispose]()
    }
  }

  /**
   * 注册一个出队变换并取得其只写输入端。
   * @param transform - 绑定一次的转换；在每个输入出队时求值。
   * @returns 一个共享本缓冲存储与生命周期的只写输入端。
   * @throws 当缓冲已关闭时抛出。
   */
  createInput<Input>(transform: (item: Input) => Iterable<T>): { append(item: Input): void; prepend(item: Input): void } {
    // 已关闭的缓冲不允许再注册变换
    if (this.closed) throw new Error('Cannot register a transform on a closed listener buffer')
    // 变换编号：按注册顺序分配
    const transformId = this.transforms.length
    // Only this typed input can enqueue values with its private transform id.
    // 登记变换（擦除类型）；只有这个带类型输入端能以它的私有变换编号入队
    this.transforms.push(value => transform(value as Input))
    // 返回只写输入端：append 追加到队尾，prepend 插入队首
    return {
      append: (item) => {
        // 已关闭：静默丢弃
        if (this.closed) return
        // 值与变换编号成对入队
        this.values.pushBack(item)
        this.transformIds.pushBack(transformId)
        // 通知可能正在等待的消费者
        this.notify()
      },
      prepend: (item) => {
        // 已关闭：静默丢弃
        if (this.closed) return
        // 值与变换编号成对插入队首
        this.values.pushFront(item)
        this.transformIds.pushFront(transformId)
        // 通知消费者
        this.notify()
      },
    }
  }

  /**
   * 一次性消费队列中的值；迭代结束时释放缓冲。
   * @returns 变换后的输出值。
   */
  async *items(): AsyncIterable<T> {
    // 只允许一个消费者：重复消费是内部错误
    if (this.consumed) throw new RemoteError('gateway/internal', 'Session listener already has a consumer', {})
    this.consumed = true
    try {
      // 持续消费直到缓冲关闭
      for (;;) {
        // 生产者失败：在消费者侧抛出
        if (this.failure !== undefined) throw this.failure.error
        // 缓冲已关闭：正常结束迭代
        if (this.closed) return
        // 队列为空：挂起等待生产者唤醒
        if (this.transformIds.size === 0) {
          await new Promise<void>((resolve) => { this.wake = resolve })
          continue
        }
        // 取出队首的变换编号与值（两者成对）
        const transformId = this.transformIds.popFront() as number
        const value = this.values.popFront()
        // 执行变换并逐个产出结果
        for (const item of (this.transforms[transformId] as (value: unknown) => Iterable<T>)(value)) {
          // 每次产出前检查生产者是否已失败
          this.throwIfFailed()
          // 变换执行期间缓冲被释放：停止消费
          if (this.isClosed()) return
          // 产出一个输出值
          yield item
        }
      }
    } finally {
      // 消费结束（正常、错误或提前退出）：释放缓冲
      this[Symbol.dispose]()
    }
  }

  // 若生产者已失败则在消费者侧抛出该错误
  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure.error
  }

  /** @returns 变换正在产出时缓冲是否已被释放。 */
  private isClosed(): boolean {
    return this.closed
  }

  // 唤醒等待中的消费者（一次性：唤醒后清除）
  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  // 释放缓冲：清空队列、唤醒消费者并逆序执行全部清理
  [Symbol.dispose](): void {
    // 幂等：重复释放直接返回
    if (this.closed) return
    this.closed = true
    // 丢弃未消费的数据
    this.values.clear()
    this.transformIds.clear()
    // 丢弃变换注册
    this.transforms.length = 0
    // 唤醒可能挂起的消费者（其会看到 closed 并结束）
    this.notify()
    // 逆序执行全部清理（撤销订阅、移除信号监听、撤销 effect）
    for (const dispose of this.cleanup.splice(0).reverse()) dispose()
  }
}
