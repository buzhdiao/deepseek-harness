import { notifySubscribers } from '@deepseek-ai/dsh-client-store'

// 结构性更新按微任务（microtask）合批，流式更新按动画帧合批；读取可在不消费待发通知的情况下重建脏快照。
/**
 * Batches structural updates in microtasks and stream updates by animation
 * frame. Reads may rebuild a dirty snapshot without consuming the pending
 * subscriber notification.
 */
export class Notifier {
  // 订阅者集合。
  private listeners = new Set<() => void>()
  // 快照是否已脏（需要重建）。
  private dirty = false
  // 是否有待发的订阅者通知。
  private notifyPending = false
  // 当前已调度的刷新方式。
  private scheduled: 'none' | 'microtask' | 'frame' = 'none'
  // 调度代数：让过期回调失效。
  private scheduleGeneration = 0

  // 注入所有者的快照重建函数（负责写所有者的快照缓存）。
  /** @param rebuild - snapshot rebuild function injected by the owner (writes the owner's snapshotCache). */
  constructor(private readonly rebuild: () => void) {}

  // uSES 订阅入口。
  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    // 登记订阅者。
    this.listeners.add(listener)
    // 返回退订函数。
    return () => {
      this.listeners.delete(listener)
    }
  }

  // 标记快照脏，并在一个微任务内通知。
  /** Mark the snapshot dirty and notify in a microtask. */
  markDirty(): void {
    // 置脏。
    this.dirty = true
    // 挂起通知。
    this.notifyPending = true
    // 已有微任务调度：合并，无需重复安排。
    if (this.scheduled === 'microtask') return
    // 安排微任务刷新。
    this.schedule('microtask')
  }

  // 标记快照脏，并每帧最多发布一次累计状态。
  /** Mark the snapshot dirty and publish cumulative state at most once per frame. */
  markFrameDirty(): void {
    // 置脏。
    this.dirty = true
    // 挂起通知。
    this.notifyPending = true
    // 任何已存在的调度都能覆盖本帧：合并。
    if (this.scheduled !== 'none') return
    // 优先动画帧；环境不支持 requestAnimationFrame 时退化为微任务。
    this.schedule(typeof globalThis.requestAnimationFrame === 'function' ? 'frame' : 'microtask')
  }

  // 同步刷新：受控输入的写入必须与 onChange 在同一 tick 通知，否则 React 会把 DOM 回滚到旧值、光标跳到末尾。
  /**
   * Synchronous flush: controlled-input writes must notify in the same tick as
   * onChange, or React rolls the DOM back to the stale value and the caret jumps to the end.
   */
  notifyNow(): void {
    // 置脏。
    this.dirty = true
    // 挂起通知。
    this.notifyPending = true
    // 作废已安排的异步刷新。
    this.invalidateSchedule()
    // 立即执行刷新。
    this.flush()
  }

  // getSnapshot 前置检查：脏时同步重建（首次订阅前/无观察者时的读取路径）；通知保持挂起。
  /**
   * Pre-getSnapshot check: rebuild synchronously when dirty (read path
   * before first subscribe / while unobserved). Notification stays pending.
   */
  ensureFresh(): void {
    // 干净则无需重建。
    if (!this.dirty) return
    // 清除脏标记。
    this.dirty = false
    // 同步重建快照。
    this.rebuild()
  }

  // 安排一次批量刷新（微任务或动画帧）。
  private schedule(kind: 'microtask' | 'frame'): void {
    // 取新的调度代数（自增）。
    const generation = ++this.scheduleGeneration
    // 记录调度方式。
    this.scheduled = kind
    // 到点后的发布回调。
    const publish = () => {
      // 代数不匹配：本次调度已被作废（如 notifyNow 抢先）。
      if (generation !== this.scheduleGeneration) return
      // 清空调度状态。
      this.scheduled = 'none'
      // 执行刷新。
      this.flush()
    }
    // 按类型选择调度通道。
    if (kind === 'frame') {
      // 下一动画帧刷新。
      globalThis.requestAnimationFrame(publish)
    } else {
      // 下一微任务刷新。
      queueMicrotask(publish)
    }
  }

  // 作废当前已安排的刷新（同步 flush 抢先时调用）。
  private invalidateSchedule(): void {
    // 递增代数，令旧回调失效。
    this.scheduleGeneration++
    // 清空调度状态。
    this.scheduled = 'none'
  }

  // 实际刷新：重建脏快照并通知订阅者。
  private flush(): void {
    // 没有挂起的通知。
    if (!this.notifyPending) return
    // 无订阅者：保持惰性（脏标记若仍在，下次 getSnapshot 时会重建）。
    if (this.listeners.size === 0) return // lazy: dirty (if still set) rebuilds on next getSnapshot
    // 消费挂起通知。
    this.notifyPending = false
    // 快照脏时先重建再通知，保证订阅者读到新值。
    if (this.dirty) {
      // 清除脏标记。
      this.dirty = false
      // 重建快照。
      this.rebuild()
    }
    // 通知全部订阅者。
    notifySubscribers(this.listeners, '[session-controller]')
  }
}
