// 模块说明：由两个观察（observation）生成器共享的唤醒记账（wake bookkeeping）工具：
// 一个在两次等待之间绝不丢失唤醒的唤醒标志等待器，
// 以及一个把突发事件合并进有界帧的可中止睡眠（abortable sleep）。
/**
 * Wake bookkeeping shared by the two observation generators: a wake-flag
 * waiter that never loses a wake between waits, and an abortable sleep that
 * coalesces bursts into bounded frames.
 * @module @deepseek-ai/dsh-api-job-controller/wake
 */

// 唤醒标志等待器（wake-flag waiter）：等待间隙里发生的唤醒绝不丢失。
/** Wake-flag waiter: a wake between waits is never lost. */
export class OutputWaiter {
  // 脏标志：自上次等待结束后是否已有唤醒到达。
  private dirty = false
  // 当前挂起等待的回调：唤醒到来时释放它。
  private resolve: (() => void) | undefined

  // 记录一次唤醒：若正有等待挂起则立即释放，否则置位标志“武装”下一次等待。
  /** Record one wake; releases a pending wait or arms the next one. */
  wake(): void {
    // 置位脏标志，保证后续 wait 不会错过这次唤醒。
    this.dirty = true
    // 若有挂起的等待，立即释放它。
    this.resolve?.()
  }

  // 在下一次唤醒时兑现；若唤醒已经到达则立即兑现；中止时同样兑现。
  /**
   * Resolve on the next wake, immediately when one already arrived, or on abort.
   * @param signal - generation cancellation.
   * @returns settles when woken or aborted.
   */
  wait(signal: AbortSignal): Promise<void> {
    // 已有唤醒在等待间隙到达，或生成已被取消：直接兑现并复位标志。
    if (this.dirty || signal.aborted) {
      this.dirty = false
      return Promise.resolve()
    }
    // 尚无唤醒：创建一个 Promise，把兑现回调登记下来，等待 wake() 或 abort 触发。
    return new Promise((resolve) => {
      // 兑现回调：清理监听、复位状态并兑现等待。
      const finish = (): void => {
        // 移除 abort 监听，避免中止后的重复触发。
        signal.removeEventListener('abort', finish)
        // 仅当仍由本次等待登记时才清空（防止单例等待被覆盖的边界情况）。
        /* v8 ignore next -- one wait owns the sole installed resolver. */
        if (this.resolve === finish) this.resolve = undefined
        // 消费掉脏标志。
        this.dirty = false
        // 兑现挂起的等待。
        resolve()
      }
      // 登记本次等待的兑现回调。
      this.resolve = finish
      // 中止也算兑现：注册一次性 abort 监听。
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

// 睡眠一个合并（coalescing）窗口；若已中止则立即返回。
/**
 * Sleep for the coalescing window, or return at once when aborted.
 * @param ms - window in milliseconds.
 * @param signal - generation cancellation.
 * @returns settles after the window or on abort.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // 生成已取消：无需等待，直接兑现。
  if (signal.aborted) return Promise.resolve()
  // 定时器与 abort 监听二选一先到即兑现，另一路随后被清理。
  return new Promise((resolve) => {
    // 启动合并窗口定时器，到点触发 done。
    const timer = setTimeout(done, ms)
    // 完成回调：清掉定时器与监听后兑现。
    function done(): void {
      // 清除定时器（abort 路径触发时防止其再次触发）。
      clearTimeout(timer)
      // 移除 abort 监听（定时器路径触发时清理）。
      signal.removeEventListener('abort', done)
      // 兑现睡眠。
      resolve()
    }
    // 注册一次性 abort 监听：窗口期间被取消则立即返回。
    signal.addEventListener('abort', done, { once: true })
  })
}
