// 模块说明：StateListener——把 Session/Agent 生命周期失效通知合并（coalesce）为宿主
// 本地修订号（revision）：待处理事件在读取时采样，调用方用修订号判断一次读取是否
// 仍然新鲜（isCurrent），从而在事件驱动与周期刷新之间保持内部一致性。
/** Coalesced Session state observations with Host-local revisions. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 导入 SessionId 类型
import type { SessionId } from '@deepseek-ai/dsh-session'
// 导入对外的 Session 状态类型
import type { SessionState } from '../types.ts'

/** 一份完整状态及其监听器本地修订号。 */
export interface VersionedSessionState { state: SessionState; revision: number }

/** 把 Session/Agent 的失效（invalidation）通知与本地修订号合并；待处理事件在读取时采样。 */
export class StateListener implements Disposable {
  // 订阅清理函数列表
  private readonly disposes: (() => void)[] = []
  // 内部取消控制器：释放时中止合并信号
  private readonly cancellation = new AbortController()
  // 合并后的信号：调用方信号与内部取消信号的任意一个中止即中止
  private readonly signal: AbortSignal
  // 当前修订号：每收到一次相关失效通知就自增
  private revision = 0
  // 延迟信号（deferred）：有新修订时 resolve，用于唤醒等待中的观测
  private resolver = createDeferredSignal()
  // 监听器是否已关闭
  private closed = false

  /**
   * @param ctx - 生命周期通知的所有者。
   * @param target - 要观测的 Session。
   * @param signal - 调用方取消信号。
   * @param readState - 被动的完整状态读取器。
   */
  constructor(
    ctx: Context, target: SessionId, signal: AbortSignal,
    private readonly readState: (signal: AbortSignal) => Promise<SessionState>,
  ) {
    // 信号已取消：立即抛出，不做任何注册
    signal.throwIfAborted()
    // 合并调用方信号与内部取消信号
    this.signal = AbortSignal.any([signal, this.cancellation.signal])
    // 失效通知处理：只关心目标会话，且必须未关闭
    const notify = (id: string | undefined): void => {
      if (id !== target || this.closed) return
      // 修订号自增：一次通知代表一次潜在的失效
      this.revision++
      // 取出当前的延迟信号并换一个新的，供下一轮等待使用
      const resolver = this.resolver
      this.resolver = createDeferredSignal()
      // 唤醒正在等待的观测
      resolver.resolve()
    }
    // 调用方信号中止时关闭监听器（once：只触发一次）
    const close = (): void => { this[Symbol.dispose]() }
    signal.addEventListener('abort', close, { once: true })
    // 移除信号监听也要进入清理列表
    this.disposes.push(() => { signal.removeEventListener('abort', close) })
    try {
      // 订阅会话与 Agent 的全部生命周期事件（全局），任一发生都视为失效
      this.disposes.push(ctx.on('session/event', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('session/created', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('session/disposed', (session) => { notify(session.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/status', ({ agent }) => { notify(agent.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/created', ({ agent }) => { notify(agent.id) }, { global: true }))
      this.disposes.push(ctx.on('agent/disposed', ({ agent }) => { notify(agent.id) }, { global: true }))
      // 注册宿主销毁时关闭监听器的副作用
      const dispose = ctx.effect(() => close, 'session-controller.state-listener')
      this.disposes.push(() => { void dispose() })
    } catch (error: unknown) {
      // 注册失败：释放已注册的部分再抛出
      this[Symbol.dispose]()
      throw error
    }
  }

  /**
   * 检查一次已完成的读取是否仍代表最新的失效。
   * @param revision - 随读取一起捕获的修订号。
   * @returns 其间是否没有发生任何失效。
   */
  isCurrent(revision: number): boolean { return !this.closed && revision === this.revision }

  /**
   * 读取合并后的状态替换流，可选周期性刷新。
   * @param refreshMs - 可选的空闲复查间隔；省略表示仅由事件驱动观测。
   * @returns 带内部一致性修订号的完整状态替换。
   */
  async *observeStates(refreshMs?: number): AsyncGenerator<VersionedSessionState> {
    // 上一次产出的修订号（-1 表示还没有产出过）
    let lastRevision = -1
    try {
      // 持续观测直到监听器关闭
      while (!this.closed) {
        // 没有新的修订：需要等待
        if (lastRevision === this.revision) {
          // 未提供刷新间隔：纯事件驱动，只等失效通知
          if (refreshMs === undefined) {
            await this.resolver.promise
          } else {
            // 竞速：失效通知 vs 定期刷新定时器
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                this.resolver.promise,
                new Promise<void>((resolve) => { timer = setTimeout(resolve, refreshMs) }),
              ])
            } finally {
              // 无论哪个先到都清理定时器
              clearTimeout(timer)
            }
            // 刷新先到且期间没有失效：人为推进修订号并自唤醒，强制重新读取
            if (this.isCurrent(lastRevision)) {
              this.revision++
              const resolver = this.resolver
              this.resolver = createDeferredSignal()
              resolver.resolve()
            }
          }
        }
        // 监听器已关闭或修订已被失效：结束观测
        if (!this.isCurrent(this.revision)) return
        // 记录本轮读取对应的修订号
        lastRevision = this.revision
        // 用合并信号读取一份完整状态快照
        const state = await this.readState(this.signal)
        // 读取期间没有发生失效：产出带修订号的状态
        if (this.isCurrent(lastRevision)) yield { state, revision: lastRevision }
      }
    } finally {
      // 观测结束（无论何种方式退出）：释放监听器
      this[Symbol.dispose]()
    }
  }

  // 释放监听器：中止合并信号、唤醒等待者并逆序撤销全部注册
  [Symbol.dispose](): void {
    // 幂等：重复释放直接返回
    if (this.closed) return
    this.closed = true
    // 中止内部取消信号，使进行中的读取立即中止
    this.cancellation.abort()
    // 唤醒可能挂起的观测（其会看到 closed 并结束）
    this.resolver.resolve()
    // 逆序执行全部清理
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
  }
}

// 创建一个延迟信号（deferred）：把 promise 与其 resolve 一起暴露
function createDeferredSignal(): { promise: Promise<void>; resolve: () => void } {
  // resolve 句柄（在 promise 构造时赋值）
  let resolve!: () => void
  // 构造永不自行结算的 promise，只能通过返回的 resolve 触发
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}
