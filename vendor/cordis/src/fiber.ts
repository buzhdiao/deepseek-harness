// 【中文逐行注释 · Cordis 内核 7/9：fiber.ts —— Fiber：插件生命周期状态机】
// Fiber 是「一次插件装配」的运行时化身：它持有依赖状态（inject/committed）、
// 配置（raw/effective）、生命周期状态（PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED）
// 与 effect 收集器。ctx.plugin() 每次调用都会创建一个 Fiber；插件回图的启动、
// 依赖变化触发的重装、配置更新、卸载清理全部由本文件驱动。
// DSH 的插件热重载（HMR）、插件管理器的启停、能力提供者的动态上下线都建立在这上面。
import { defineProperty, isNullable } from '@deepseek-ai/cosmokit'
import type { Awaitable, Dict } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import type { Plugin } from './registry.ts'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils.ts'
import type { Impl } from './reflect.ts'
import type { StandardSchemaV1 } from '@standard-schema/spec'

// 声明合并：把 fiber 与 effect 暴露为 ctx 属性/方法（ctx.fiber、ctx.effect）。
declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect'> {
    /** The fiber (plugin runtime instance) that owns this context. */
    // fiber：拥有此上下文的插件运行实例。
    fiber: Fiber
  }
}

// 校验错误的品牌符号：便于跨副本识别 ValidationError 实例。
const kValidationError = Symbol.for('ValidationError')

/** Error raised when plugin configuration fails standard-schema validation. */
// 配置未通过标准 schema 校验时抛出；消息聚合所有 issue（含路径）。
export class ValidationError extends TypeError {
  name = 'ValidationError'

  /**
   * Build the aggregated message from schema issues.
   *
   * @param issues — the standard-schema issues, one message line each.
   */
  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    // 每条 issue 一行：带路径时输出 "message (at a.b.c)"。
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path) {
        return `  - ${issue.message} (at ${issue.path.join('.')})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }
}

// 在原型上挂品牌标记，供运行时判定（instanceof 之外的兜底）。
Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

/**
 * Validate and normalize config for a plugin runtime before it starts.
 *
 * @param runtime — the plugin runtime whose `Config` schema to apply.
 * @param config — the raw user config.
 * @returns the validated config, or `config` unchanged if the runtime has no schema.
 * @throws {ValidationError} when validation reports issues.
 */
// resolveConfig：启动前用插件声明的 Config schema 校验并规范化配置。
// 无 schema 时原样返回；异步校验暂不支持（直接抛错，见上游 TODO）。
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  // TODO: async validation
  // 上游 TODO：异步校验尚未支持。
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}

// AsyncDisposable：既是函数又是 PromiseLike 的 disposer（effect 清理句柄的形态）。
interface AsyncDisposable<T extends Awaitable<void> = Awaitable<void>> extends PromiseLike<() => T> {
  (): T
}

/**
 * Function returned by an effect to release resources during disposal.
 *
 * Disposers run in reverse registration order when the owning fiber unloads;
 * they may be async, in which case unloading awaits them.
 */
// Disposable：effect 返回的清理函数。fiber 卸载时按注册的逆序执行；可为异步。
export type Disposable<T = any> = () => T

/**
 * Effect body result accepted by `ctx.effect()` and plugin startup.
 *
 * Either a single disposer, a promise of one, or a (possibly async) iterable
 * yielding several — generator effects register each yielded disposer as it
 * is produced.
 */
// Effect：插件启动体/effect 体可返回的形态——单个 disposer、其 Promise、
// 或（异步）可迭代对象逐个产出 disposer（生成器 effect 边产出边登记）。
export type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>

// 同步形态：函数或（同步）迭代器。
type SyncEffect<T = any> =
  | Disposable<T>
  | Iterable<Disposable<T>, void, void>

// 异步形态：Promise 或异步迭代器。
type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>

/** Tree node used to expose nested effect labels for diagnostics. */
// EffectMeta：effect 诊断树节点——标签 + 嵌套子 effect。
export interface EffectMeta {
  /** Human-readable effect label, e.g. `ctx.on("event")` or `ctx.provide("name")`. */
  // 人读标签，如 ctx.on("event")、ctx.provide("name")。
  label: string
  /** Metadata of nested effects registered while this effect ran. */
  // 本 effect 执行期间登记的子 effect 元数据。
  children: EffectMeta[]
}

// EffectRunner：effect 执行器的最小接口——epoch（代次）、执行体、收集器、外部栈。
interface EffectRunner<T> {
  epoch: T
  execute: () => any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

// Public effect disposers remain single-shot, but structural owners and outer
// effects must still be able to join a cleanup that another caller started.
// 上游注释：公开的 effect disposer 保持单次语义，但结构上的所有者（如 fiber）
// 需要能「加入」别人已经开始的清理——effectInertia 记录每个 disposer 的
// 惯性（进行中的清理 Promise），供 join 者等待。
const effectInertia = new WeakMap<Disposable, () => void | Promise<void>>()

// runDisposable：执行 disposer 并附加其惯性清理（若有）——保证 join 者等到完整清理。
function runDisposable(dispose: Disposable) {
  const result = dispose()
  return effectInertia.get(dispose)?.() ?? result
}

/** Notify plugin teardown without allowing one observer to break ownership cleanup. */
// 插件卸载通知：逐个调用 internal/plugin 观察者并隔离每个错误——
// 单个观察者失败不能中断所有权清理流程。
function emitPluginDisposed(context: Context, fiber: Fiber) {
  const args: any[] = ['internal/plugin', fiber]
  let callbacks: Function[]
  try {
    // 先解析回调列表（dispatch 只解析不执行）。
    callbacks = context.events.dispatch('emit', args)
  } catch (error) {
    context.logger.error(error)
    return
  }
  for (const callback of callbacks) {
    try {
      const returned = callback(...args)
      // 异步失败同样只记日志。
      void Promise.resolve(returned).catch(error => context.logger.error(error))
    } catch (error) {
      context.logger.error(error)
    }
  }
}

/**
 * Lifecycle state for one plugin fiber.
 *
 * `PENDING` — waiting for required services; `LOADING` — the plugin callback
 * is running; `ACTIVE` — loaded and providing; `FAILED` — the callback or its
 * config threw; `UNLOADING` — disposers are running; `DISPOSED` — the fiber
 * was removed and cannot restart.
 */
// 生命周期状态枚举（上游注释）：
// PENDING 等依赖就绪；LOADING 回调运行中；ACTIVE 已加载；
// FAILED 启动/配置抛错；UNLOADING 清理中；DISPOSED 已移除不可复活。
export const enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

/** Framework error with a stable machine-readable code. */
// 带稳定错误码的框架错误。
export class CordisError extends Error {
  /**
   * @param code — the stable error code; also the default message.
   * @param message — optional human-readable override.
   */
  constructor(public code: CordisError.Code, message?: string) {
    super(message ?? CordisError.Code[code])
  }
}

/** Cordis error code definitions. */
export namespace CordisError {
  export type Code = keyof typeof Code

  // 错误码表：code → 默认消息。目前只有「在已失效上下文创建 effect」。
  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

// 根 fiber 的特殊 epoch 值（非字符串哨兵）。
const INACTIVE = '__INACTIVE__'

/**
 * Runtime instance of one plugin application.
 *
 * A fiber tracks dependency state, raw and effective config, lifecycle effects, and
 * cleanup for the plugin context returned by `ctx.plugin()`.
 */
// Fiber：一次插件应用的运行时实例（上游注释见上）。核心字段：
export class Fiber {
  /** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
  // uid：注册表内唯一 id；根 fiber 为 0；卸载后置 null（DISPOSED 的判据）。
  public uid: number | null
  /** The context this fiber's plugin runs in (extends the parent context). */
  // ctx：本插件运行的上下文（由父上下文 extend 而来，携带 fiber 引用）。
  public readonly ctx: Context
  /** Raw plugin input retained for the next activation. */
  // config：原始配置（未求值未校验），供下次激活复用。
  public config: any
  /** Current lifecycle state; transitions emit `internal/status`. */
  // state：当前生命周期状态；迁移时广播 internal/status。
  public state = FiberState.PENDING
  /** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
  // dispose：卸载本 fiber——先卸插件，等全部清理完成后 settle。
  public readonly dispose: () => Promise<void>
  /** Required implementations retained through dependent teardown. */
  // committed：激活时快照的依赖实现（依赖方卸载期间仍保留可用）。
  public committed: Readonly<Dict<Impl>> | undefined
  /** Service implementations owned by this fiber, including isolated provisions. */
  // provisions：本 fiber 自己提供的服务实现集合。
  public readonly provisions: Set<Impl> = new Set()
  /** The in-flight load/unload transition, if one is currently running. */
  // inertia：进行中的装载/卸载迁移（防重入；await fiber 即等待它）。
  public inertia: Promise<void> | undefined

  // _hooks：internal/update 监听器暂存（见 events.ts 的 internal/listener 处理）。
  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  // _disposables：本 fiber 全部 effect 的清理函数（含结构性 effect 包装）。
  public readonly _disposables = new DisposableList<Disposable>()

  // Same as `this.ctx`, but with a more specific type.
  // 与 ctx 相同对象，仅类型更精确（上游注释）。
  protected context: Context

  private _error: any
  private _revision = 0
  private _configRevision = 0
  private _effectiveConfig: unknown
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)
  private _release: (() => void) | undefined

  /**
   * Create a fiber. Plugin authors normally obtain fibers from `ctx.plugin()`
   * rather than constructing them directly.
   *
   * @param parent — the context the plugin was loaded from.
   * @param config — raw config, validated against the runtime's schema.
   * @param inject — resolved dependency map (service name → intercept config).
   * @param runtime — the shared plugin runtime, or `null` for the root fiber.
   * @param getOuterStack — captures the caller stack for effect diagnostics.
   */
  constructor(
    public parent: Context,
    config: any,
    public inject: Dict<any>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
  ) {
    this.config = config
    // collect：effect 产出的清理函数统一登记到本 fiber。
    const collect = (dispose: Disposable) => {
      this._disposables.push(dispose)
    }

    if (runtime) {
      // 插件 fiber 分支：分配 uid，构造插件专属 ctx（parent.extend 挂上 fiber 引用）。
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ fiber: this })

      // inject 声明里带拦截配置的项：为插件 ctx 建立拦截影子表并写入，
      // 使插件内部解析这些服务时配置已按声明合并。
      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
        for (const [name, config] of injectEntries) {
          if (isNullable(config)) continue
          this.ctx[Context.intercept][name] = config
        }
      }

      // _runner：插件主 effect 的执行器。execute 内先解析配置，
      // 类插件则 new 出实例并跑 initHooks（@Inject 方法延迟装配）与 [Service.init]，
      // 函数/对象插件直接调用回调。
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function (this: Fiber) {
          const config = this.resolveConfig(this.config)
          this._effectiveConfig = config
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, config)
          }
        },
        collect,
      }

      // 把「整个 fiber 的卸载」注册为父 fiber 的一个 effect：
      // 父插件卸载时子插件随之卸载——这正是一切皆插件的树状生命周期。
      // 清理函数负责：清 uid → 通知 → 从 runtime/registry 摘除 → 等待迁移完成。
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        return async () => {
          this.uid = null
          emitPluginDisposed(this.context, this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            // 该插件最后一个 fiber 也没了：从注册表删除运行时记录。
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          // A PENDING fiber can already own effects registered by an
          // internal/plugin observer. Its epoch is still INACTIVE, so
          // _setEpoch() has no transition to drive; explicitly unload that
          // pre-activation work before reporting disposal complete.
          // 上游注释：PENDING fiber 可能已被观察者注册了 effect，
          // 而 epoch 仍是 INACTIVE、不会驱动迁移——这里显式卸载这批激活前工作。
          if (!this.inertia) {
            this._updateState(() => {
              this.inertia = this._unload()
              return FiberState.UNLOADING
            })
          }
          // `this.inertia` itself should never reject — both `_reload` and
          // `_unload` swallow their own work errors via `ctx.logger.error`.
          // If it *does* reject, the only remaining cause is the logger
          // itself failing, which we can't recover from in this exact spot
          // (calling the logger again is what just failed). Let the
          // rejection propagate; process-level crash is the honest outcome.
          // 上游注释：inertia 不应 reject；若真 reject 说明日志器自身崩溃，
          // 无法在本处恢复——让 rejection 传播（进程级崩溃是诚实结果）。
          while (this.inertia) {
            await this.inertia
          }
        }
      }, 'ctx.plugin()')

      try {
        // Publish only after the parent owns a fully assigned disposer. A
        // synchronous observer may dispose either this fiber or its parent.
        // 上游注释：等父级持有完整 disposer 后才发布 internal/plugin——
        // 同步观察者可能立刻 dispose 本 fiber 或父 fiber。
        this.context.emit('internal/plugin', this)
      } catch (error) {
        // Publication failed synchronously. The disposer removes the child
        // from both the parent and runtime before control escapes.
        // 上游注释：同步发布失败——清理函数会把子 fiber 从父级与运行时摘除。
        void Promise.resolve(this.dispose()).catch(reason => this.ctx.logger.error(reason))
        throw error
      }

      // Keep the initial notification's historical PENDING view. The loader
      // may also extend `inject` in that notification, so resolve dependencies
      // only after publication. A reentrant parent unload makes the child
      // disposer responsible for draining any PENDING effects instead.
      // 上游注释：loader 可能在通知里扩展 inject，故发布后才解析依赖并刷新；
      // 若父级正在卸载（重入），交给子级 disposer 兜底清理 PENDING effect。
      if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
        for (const name of Object.keys(this.inject)) {
          this._checkImpl(name)
        }
        this._refresh()
      }
    } else {
      // 根 fiber 分支：uid=0、直接 ACTIVE、无依赖、无插件回调；dispose 即重启。
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.committed = Object.create(null)
      this._runner = {
        epoch: '0',
        getOuterStack,
        execute: () => {},
        collect,
      }
      this.dispose = () => this.restart()
    }
  }

  /** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
  // name：沿父链向上找最近的命名插件；根 fiber 显示 'root'（日志名字来源）。
  get name() {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  /**
   * Throw if the fiber has already been disposed.
   *
   * @returns nothing when the fiber is still active.
   * @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
   */
  // assertActive：uid 已清空即抛 INACTIVE_EFFECT——已卸载 fiber 上禁止新 effect。
  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  // _execute：执行 effect 体并收集其产出的清理函数。支持四种返回形态：
  // 函数（直接登记）、可迭代（逐个登记）、Promise（then 登记）、异步迭代器
  //（边 await 边登记，epoch 变化则提前终止）。非法形态抛 TypeError。
  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    return composeError((info) => {
      // safeCollect：只收函数；其他非空值视为非法 effect。
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute.call(this)
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        // return
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        // Promise：resolve 后登记其产物。
        return effect.then(safeCollect)
      } else if (Symbol.iterator in effect) {
        // 同步迭代器：捕获当前栈用于错误拼接，逐个登记。
        info.error = new Error()
        const iter = effect[Symbol.iterator]()
        while (true) {
          const result = iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        // 异步迭代器：先 yield 一次确保错误栈指向异步边界；每轮检查 epoch，
        // 代次变了（已被重启/卸载取代）就停止继续登记。
        const iter = effect[Symbol.asyncIterator]()
        return (async () => {
          // force async stack trace
          // 上游注释：强制产生异步栈。
          await Promise.resolve()
          info.error = new Error()
          while (true) {
            if (runner.epoch !== oldEpoch) return
            const result = await iter.next()
            safeCollect(result.value)
            if (result.done) return
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack)
  }

  /**
   * Register a cleanup-aware effect on this fiber.
   *
   * `execute` runs immediately; the disposers it produces are collected and
   * run (in reverse order) either when the returned disposer is called or
   * when the fiber unloads, whichever comes first. Calling the disposer twice
   * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
   * already disposed, and `TypeError` if `execute` returns an invalid shape.
   *
   * @param execute — the effect body; see {@link Effect} for accepted shapes.
   * @param label — effect label shown in `getEffects()` diagnostics.
   * @returns a disposer that tears the effect down and settles once done.
   */
  // effect()：Cordis 的「可逆副作用」原语——插件的一切注册（服务、事件、定时器）
  // 都应通过它完成，从而随插件卸载自动回滚（这就是「注册即 effect」约定）。
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    // 已卸载或正在卸载的 fiber 禁止新 effect（防止清理期间注册逃逸）。
    this.assertActive()
    if (this.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }

    // 本 effect 的清理函数集合与 dispose 实现：逆序执行、异步串行化。
    const disposables: Disposable[] = []
    let disposing = false
    let disposalTask: void | Promise<void>
    const dispose = () => {
      if (disposing) return disposalTask
      disposing = true
      let task!: void | Promise<void>
      for (const disposable of disposables.splice(0).reverse()) {
        if (task) {
          task = task.then(() => runDisposable(disposable))
        } else {
          const result = runDisposable(disposable)
          if (isObject(result) && 'then' in result) {
            task = result as any
          }
        }
      }
      return disposalTask = task
    }

    // 诊断元数据与执行器。
    const meta: EffectMeta = { label, children: [] }
    const runner: EffectRunner<boolean> = {
      execute,
      epoch: true,
      collect: (dispose) => {
        disposables.push(dispose)
        // 效果级清理要从 fiber 全局列表里摘除，改为挂在本 effect 下（树状）。
        this._disposables.delete(dispose)
        if (dispose[symbols.effect]) {
          meta.children.push(dispose[symbols.effect])
        }
      },
      getOuterStack: buildOuterStack(),
    }

    let task: void | Promise<void>
    let executing = true
    let resolveSetup: (() => void) | undefined
    let rejectSetup: ((reason: unknown) => void) | undefined
    let setupBarrier: Promise<void> | undefined
    let setupFailed = false
    let inFlight: void | Promise<void>
    let removeWrapper = () => false

    // waitForSetup：建立 setup 完成屏障——同步失败重入卸载时可以 await 它。
    const waitForSetup = () => {
      setupBarrier ??= new Promise<void>((resolve, reject) => {
        resolveSetup = resolve
        rejectSetup = reject
      })
      return setupBarrier
    }

    // disposeAfter：等 setup/task 结束后再清理；失败时先清理再重抛。
    const disposeAfter = (setup: PromiseLike<void>) => {
      return Promise.resolve(setup).then(
        () => dispose(),
        async (reason) => {
          await dispose()
          throw reason
        },
      )
    }

    // finalizeDisposal：执行清理并维护 inFlight 惯性记录；同步异常也要摘除包装。
    const finalizeDisposal = (callback: () => void | Promise<void>) => {
      let result: void | Promise<void>
      try {
        result = callback()
      } catch (error) {
        removeWrapper()
        throw error
      }
      if (isObject(result) && 'then' in result) {
        const pending = Promise.resolve(result).finally(() => {
          removeWrapper()
          if (inFlight === pending) inFlight = undefined
        })
        return inFlight = pending
      }
      removeWrapper()
      return result
    }

    // wrapper：对外暴露的 disposer（单次语义 + 惯性 join + 诊断元数据）。
    const wrapper = defineProperty(() => {
      // A synchronous setup failure can race an owner unload that already
      // captured this wrapper but has not invoked it yet. The failed effect is
      // never returned publicly, so let that internal caller await rollback.
      // 上游注释：同步 setup 失败可能与持有包装的卸载竞态——
      // 让内部调用者 await 回滚结果。
      if (!runner.epoch) return setupFailed ? inFlight : undefined
      runner.epoch = false
      return finalizeDisposal(() => {
        if (executing) return disposeAfter(waitForSetup())
        return task ? disposeAfter(task) : dispose()
      })
    }, symbols.effect, meta) as AsyncDisposable
    effectInertia.set(wrapper, () => inFlight)

    // Make the effect visible to a reentrant owner unload before execute()
    // runs any plugin code. Async teardown stays owner-visible until it
    // settles, allowing an outer effect to join cleanup another caller began.
    // 上游注释：先把包装登记到 fiber 全局列表，再执行插件代码——
    // 重入卸载能看到它；异步清理在 settle 前保持可见以便 join。
    removeWrapper = this._disposables.push(wrapper)
    try {
      task = this._execute(runner)
    } catch (reason) {
      // 同步启动失败：回滚已收集清理、拒绝 setup 屏障、重抛。
      executing = false
      setupFailed = true
      runner.epoch = false
      let cleanup: void | Promise<void>
      try {
        cleanup = finalizeDisposal(dispose)
      } finally {
        rejectSetup?.(reason)
      }
      if (isObject(cleanup) && 'then' in cleanup) {
        cleanup.catch(error => this.ctx.logger.error(error))
      }
      throw reason
    }
    executing = false
    if (setupBarrier) {
      Promise.resolve(task).then(resolveSetup, rejectSetup)
    }

    // prevent unhandled rejection — both from `task` itself and from the
    // disposer chain if it fails to settle cleanly.
    // 上游注释：吞掉无人消费的 rejection（错误已经由 fiber 记录）。
    task?.catch(() => {
      if (!runner.epoch) return dispose()
      return finalizeDisposal(dispose)
    }).catch((error) => this.ctx.logger.error(error))

    // disposeAsync：显式清理入口；wrapper.then 允许 await fiber.effect(...)。
    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return finalizeDisposal(dispose)
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    return wrapper
  }

  /**
   * Return metadata for currently registered effects.
   *
   * @returns one {@link EffectMeta} tree per labeled live effect.
   */
  // getEffects：诊断用——列出当前存活 effect 的元数据树。
  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>(dispose => dispose[symbols.effect])
      .filter(Boolean)
  }

  // _getState：由派生条件计算真实状态（uid/_error/epoch 三者决定）。
  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  // _updateState：状态更新 + internal/status 通知 + 服务可用性通知。
  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    // FIXME internal/fiber-info
    this.context.emit('internal/status', this, oldState)

    // only notify changes between ACTIVE and NON-ACTIVE states
    // 上游注释：只有 ACTIVE ↔ 非 ACTIVE 的迁移需要通知服务可用性变化。
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key as symbol]
      if (impl.ctx.fiber !== this) continue
      this.ctx.isolate(impl.name, impl.isolate).reflect.notify([impl.name])
    }
  }

  // _checkImpl：刷新单个依赖的本地实现缓存（含 check 谓词；谓词抛错视为不可用）。
  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  // _refresh：根据当前依赖满足情况计算新 epoch——
  // 任一依赖缺失 → INACTIVE（待卸载）；否则 epoch 由修订号 + 各实现 uid 组成，
  // 实现 uid 变化也会生成新 epoch（触发重装）。
  _refresh() {
    let epoch = `${this._revision}`
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.uid
    }
    this._setEpoch(epoch)
  }

  // _setEpoch：状态机的推进入口。epoch 不变则无事发生；FAILED fiber 只能经
  // update() 恢复；变化时驱动 LOADING（激活）或 UNLOADING（停用）迁移。
  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    // a failed fiber only recovers through update(), which clears _error
    // 上游注释：失败 fiber 只有 update() 能恢复（它清 _error）。
    if (this._error) return
    this._runner.epoch = epoch
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  /** Raw input retained for the next activation, without evaluating expressions or validating it. */
  // rawConfig：原始配置（未求值/未校验），供下次激活使用。
  get rawConfig(): unknown {
    return this.ctx.fiber.config
  }

  /** Retain raw input without changing the running config or triggering an update. */
  // 写 rawConfig：仅保留原始输入，不影响运行中的配置，也不触发更新。
  set rawConfig(config: unknown) {
    this.ctx.fiber.config = config
    this.ctx.fiber._configRevision++
  }

  /**
   * The object passed to plugin activation or the latest successful update that retained the instance.
   * Candidate resolution does not publish it; volatile updates retain its references.
   * Undefined before activation and readable after unload; callers requiring a live instance check `state`.
   */
  // effectiveConfig：激活时传入或最近一次成功更新保留的配置对象；
  // 候选解析不发布它；需要活实例的调用方应检查 state。
  get effectiveConfig(): unknown {
    return this.ctx.fiber._effectiveConfig
  }

  /**
   * Evaluate and validate a candidate using this fiber's `internal/config` hooks and runtime schema.
   * Does not publish the result, replace raw input, or commit running volatile references.
   * Required injections must be available when a hook uses them.
   * @param config Raw candidate input.
   * @returns The candidate's resolved config, retaining the schema's result identity.
   * @throws {ValidationError} when the runtime schema rejects the candidate; hook errors propagate.
   */
  // resolveConfig：试解析候选配置（不发布、不落盘）；内部走 internal/config waterfall。
  resolveConfig(config: unknown): unknown {
    const fiber = this.ctx.fiber
    return fiber.context.waterfall('internal/config', fiber, () => config)
  }

  // _reload：激活流程——快照依赖为 committed 并登记为依赖方，随后执行插件回调。
  private async _reload() {
    this.committed = { ...this._store }
    for (const impl of Object.values(this.committed)) {
      if (impl.ctx.fiber === this) continue
      impl.dependents.add(this)
    }
    const oldEpoch = this._runner.epoch
    try {
      // 先让出一个微任务：期间 epoch 可能已被再次改变（合并连续变化）。
      await Promise.resolve()
      if (this._runner.epoch === oldEpoch) {
        await this._execute(this._runner)
      }
    } catch (reason) {
      // impl guarantees that the error is non-null (?)
      // 上游注释：启动失败——记日志并标记 FAILED（epoch 回到 INACTIVE）。
      this.ctx.logger.error(reason)
      // A superseded load still needs cleanup, but cannot fail the new target.
      // 上游注释：被取代的装载仍要清理，但不能影响新目标。
      if (this._runner.epoch === oldEpoch) {
        this._error = reason
        this._runner.epoch = INACTIVE
      }
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  // _unload：卸载流程——先等依赖本 fiber 服务的依赖方全部卸载完（顺序保证），
  // 再逆序执行本 fiber 全部清理函数（逐个隔离错误），最后释放提供方等待者。
  private async _unload() {
    // Dependents are notified when this fiber leaves ACTIVE, but may still
    // access its services during their own teardown, so the effects of this
    // fiber are only disposed after every dependent has unloaded.
    // 上游注释：依赖方退出 ACTIVE 时已收到通知，但其清理期间仍可能访问本服务，
    // 因此本 fiber 的 effect 必须等所有依赖方卸载完才执行。
    while ([...this.provisions].some(impl => impl.dependents.size)) {
      await new Promise<void>((resolve) => this._release = resolve)
    }
    this._release = undefined
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve()
          info.error = new Error()
          await runDisposable(dispose)
        }, this._runner.getOuterStack)
      } catch (reason) {
        this.ctx.logger.error(reason)
      }
    }))
    // release the providers waiting for this fiber to unload
    // 上游注释：唤醒正在等待本 fiber 卸载的服务提供方。
    for (const impl of Object.values(this.committed ?? {})) {
      if (!impl.dependents.delete(this) || impl.dependents.size) continue
      impl.release?.()
      impl.ctx.fiber._release?.()
    }
    this.committed = undefined
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  /**
   * Wait for current lifecycle work and rethrow startup errors.
   *
   * @returns this fiber, once it has settled into a stable state.
   * @throws the config-validation or plugin-startup error, if any.
   */
  // await()：等待进行中的迁移结束；FAILED 则重抛启动/配置错误（await fiber 的语义）。
  async await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
    return this
  }

  /**
   * Dispose and immediately reload this plugin with its current config.
   *
   * @returns a promise resolving once the reload settled.
   * @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
   */
  // restart：卸载后立即以当前配置重装（修订号 +1 生成新 epoch 驱动迁移）。
  async restart() {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    fiber._revision++
    fiber._refresh()
    await fiber.await()
  }

  /**
   * Resolve a candidate, retain its raw config and apply it through the update waterfall.
   * @param config Raw config; pending fibers defer resolution until activation.
   * @param noSave Suppress the persistence notification when true.
   * @returns The awaited update/restart result, or undefined when a synchronous listener handles it.
   * @throws {ValidationError} when an active fiber's candidate is invalid.
   */
  // update：配置更新入口。已加载：先试解析候选（校验失败即抛）、广播 internal/commit
  //（noSave 抑制持久化通知）、然后走 internal/update waterfall——监听器可以
  // 改写决定或否决重启（返回 undefined），否决时直接发布 effectiveConfig；
  // 未加载：直接重启。错误被标记为已处理（fiber 自身会记录）。
  update(config: any, noSave = false): Awaitable<void> {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    const loaded = fiber._runner.epoch !== INACTIVE
    const resolved = loaded ? fiber.resolveConfig(config) : undefined
    if (!noSave) fiber.context.emit('internal/commit', fiber, config)
    fiber.config = config
    fiber._error = undefined
    const configRevision = ++fiber._configRevision
    const epoch = fiber._runner.epoch
    const committed = fiber.committed
    let restarted = false
    const restart = () => {
      restarted = true
      return fiber.restart()
    }
    const publish = () => {
      if (!restarted && fiber.uid !== null && fiber._configRevision === configRevision
        && fiber._runner.epoch === epoch && fiber.committed === committed) {
        fiber._effectiveConfig = resolved
      }
    }
    const result = loaded
      ? fiber.context.waterfall(fiber, 'internal/update', resolved, restart)
      : restart()
    // a listener may veto the restart, in which case there is nothing to await
    // 上游注释：监听器否决重启时无需等待，直接发布。
    if (result === undefined) {
      publish()
      return
    }
    const task = Promise.resolve(result).then(publish)
    // the failure is already reported by the fiber, so mark it handled here:
    // a caller that drops the result cannot turn it into an unhandled
    // rejection, while `await update()` still observes it
    // 上游注释：错误已由 fiber 记录——这里标记已处理，丢弃返回值的调用方
    // 不会造成 unhandled rejection，而 await update() 仍能看到错误。
    task.catch(() => {})
    return task
  }
}
