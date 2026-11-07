// 模块说明：`whenAccess` 背后的效果控制器——在某条访问应答为真期间安装回调的效果，
// 为假期间清理它们。
/**
 * The effect controller behind `whenAccess`: install a callback's effects
 * while one access answer is true and dispose them while it is false.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/when-allowed
 */

// Cordis 的 Context（上下文）类型：控制器效果挂载在它上面。
import type { Context } from '@deepseek-ai/cordis'
// HostObservable（Host 可观察对象）：访问控制的布尔应答源。
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

// 访问保持（allowed）期间安装的一个同步效果：单个清理器（disposer），
// 或作为一次事务整体安装的一组清理器。
/** One synchronous effect installed while access holds: a disposer, or disposers installed as one transaction. */
export type AccessEffect = (() => void) | Iterable<() => void, void, void>

// 跟随访问应答 `answer`：为真时安装 `callback` 的效果。应答已为真时回调同步运行；
// 先假后真时，上一次安装已被逆序清理，随后重新运行回调。控制器归属于 `ctx` 的纤程。
/**
 * Install `callback`'s effects while `answer` is true. The callback runs
 * synchronously when the answer is already true; a later true runs it again
 * after a false disposed the previous installation in reverse order. The
 * controller belongs to `ctx`'s fiber.
 * @param ctx - the caller's Context; it owns the controller and every installation.
 * @param answer - the access answer to follow.
 * @param callback - creates one disposer or an iterable of disposers.
 * @param label - effect label for diagnostics.
 * @returns idempotent disposer for the controller and any installed effects.
 * @throws callback setup failures synchronously when the answer is already true.
 */
export function whenAllowed(
  ctx: Context,
  answer: HostObservable<boolean>,
  callback: () => AccessEffect,
  label: string,
): () => void {
  // 在 ctx 上注册控制效果：返回控制器的清理函数；控制器与所有安装物都归该纤程（fiber）所有。
  const disposeController = ctx.effect(() => {
    // 当前已安装效果的清理器；未安装时为 undefined。
    let installed: (() => void) | undefined
    // 控制器是否已退役：退役后不再协调，也不再重试。
    let stopped = false

    // 卸载当前已安装的效果（若有）。
    const uninstall = (): void => {
      // 取出已登记的清理器并先清空登记，避免重入。
      const dispose = installed
      installed = undefined
      // 执行清理（若有）。
      dispose?.()
    }

    // 协调函数：让已安装状态与当前访问应答保持一致。
    const reconcile = (): void => {
      // 控制器已退役：直接返回。
      if (stopped) return
      // 读取访问应答的当前快照。
      const allowed = answer.getSnapshot()
      // 应答与安装状态已一致：无需动作。
      if (allowed === (installed !== undefined)) return
      // 不允许访问：卸载既有效果并保持未安装状态。
      if (!allowed) {
        uninstall()
        return
      }
      // 每次安装都是嵌套的 Cordis effect，因此可迭代的回调会事务式安装并按逆序清理。
      // Each installation is a nested Cordis effect, so an iterable callback
      // installs transactionally and disposes in reverse order.
      const disposeEffect = ctx.effect(callback, `${label}: allowed`)
      // 登记该效果的清理动作（异步执行并吞掉其 Promise）。
      installed = () => { void disposeEffect() }
    }

    // 订阅访问应答变化：每次变化都触发协调。
    const unsubscribe = answer.subscribe(() => { changed() })

    // 停止函数：退役控制器并清理全部资源。
    const stop = (): void => {
      // 幂等：已退役则直接返回。
      if (stopped) return
      // 一次失败的安装即令控制器退役：后续的授权不会重试它。
      // A failed installation retires the controller: a later grant never retries it.
      stopped = true
      // 取消应答订阅。
      unsubscribe()
      // 卸载已安装效果。
      uninstall()
    }

    // 变化处理器：协调失败时退役控制器，并把异常重新抛到微任务中。
    const changed = (): void => {
      try {
        // 尝试协调。
        reconcile()
      } catch (error) {
        // 协调失败：控制器退役。
        stop()
        // 效果已被停用的错误属于正常的清理时序，无需上报。
        if ((error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT') return
        // 统一包装为 Error，保证可向上传播。
        const failure = error instanceof Error ? error : new Error(String(error))
        // 通过微任务异步重抛，避免打断订阅回调的调用栈。
        queueMicrotask(() => { throw failure })
      }
    }

    // 控制器启动：先做一次初始协调；此时失败会同步上抛。
    try {
      reconcile()
    } catch (error) {
      // 启动失败：退役控制器并把错误原样抛给调用方。
      stop()
      throw error
    }
    // 把停止函数交给外层 effect：控制器随宿主纤程一起卸载。
    return stop
  }, label)
  // 返回幂等的清理器：调用后整个控制器与已安装效果一并释放。
  return () => { void disposeController() }
}
