// 【中文逐行注释 · Cordis 内核 5/9：events.ts —— 事件总线与类型化事件】
// 事件是插件间解耦通信的主通道。EventsService 提供五种派发模式：
// emit（同步广播）、parallel（并发等全部）、serial（串行可中止）、
// bail（同步可中止）、waterfall（洋葱模型，监听器必须调 next() 委托）。
// 事件类型通过声明合并的 Events 接口扩展——DSH 的 session/event、agent/*、
// tools/* 等扩展点全部建立在这套机制上。监听器随注册它的 Fiber 卸载自动移除。
// 依赖说明：Awaitable/Promisify 是 Promise 相关类型工具；Fiber/FiberState/resolveConfig
// 供 internal/config、internal/update 内建事件使用；DisposableList/symbols 见 utils.ts。
import { defineProperty, type Awaitable, type Promisify } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { Fiber, FiberState, resolveConfig } from './fiber.ts'
import { DisposableList, symbols } from './utils.ts'

/**
 * Return whether an event result should stop a bail-style dispatch.
 *
 * @param value — a listener's return value.
 * @returns `true` unless `value` is `null`, `false`, or `undefined`.
 */
// isBailed：判定监听器返回值是否「中止」派发——只有 null/false/undefined 视为
// 不中止；任何其他值（含 0、''）都表示监听器已「截获」该事件。
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

/** Extract the parameter tuple from a function type. */
// 从函数类型提取参数元组（事件签名推导用）。
export type Parameters<F> = F extends (...args: infer P) => any ? P : never
/** Extract the return type from a function type. */
// 提取返回类型。
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
/** Extract the explicit `this` type from a function type. */
// 提取显式 this 类型（事件监听器可声明 `this: Context`）。
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never

/**
 * Event dispatch strategy used by the event service.
 *
 * `emit` runs synchronous listeners without awaiting them, `parallel` awaits
 * all listeners together, `serial` awaits them in order until one bails,
 * `bail` stops on the first synchronous bail value, and `waterfall` composes
 * listeners around a final `next` callback.
 */
// 派发模式字符串字面量联合：与下方 Events 接口里每个事件的 @mode 标注对应。
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

// 声明合并：把五种派发方法与 on/once 挂到 Context 接口（实现由 mixin 转发到 ctx.events）。
declare module './context.ts' {
  export interface Context {
    /* eslint-disable max-len */
    /**
     * Dispatch an event, running all listeners concurrently.
     *
     * @param name — the event name.
     * @param args — arguments passed to every listener.
     * @returns a promise resolving once every listener has settled.
     */
    // parallel：并发运行所有监听器并等全部完成；任一失败则 AggregateError。
    parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
    /** Same as above, with an explicit `this` for listeners (also used for filtering). */
    // 重载：第一个参数显式传 this（同时用于监听器过滤）。
    parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
    /**
     * Dispatch an event synchronously, ignoring listener return values.
     *
     * @param name — the event name.
     * @param args — arguments passed to every listener.
     */
    // emit：同步广播，忽略返回值（Promise 不等待）。
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    /** Same as above, with an explicit `this` for listeners (also used for filtering). */
    emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
    /**
     * Dispatch an event, awaiting listeners in order until one bails.
     *
     * @param name — the event name.
     * @param args — arguments passed to each listener.
     * @returns the first bail value (non-null, non-false, non-undefined), if any.
     */
    // serial：按注册顺序逐个 await，直到某个监听器返回 bail 值。
    serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    /** Same as above, with an explicit `this` for listeners (also used for filtering). */
    serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    /**
     * Dispatch an event, calling listeners in order until one bails.
     *
     * @param name — the event name.
     * @param args — arguments passed to each listener.
     * @returns the first bail value (non-null, non-false, non-undefined), if any.
     */
    // bail：serial 的同步版本。
    bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /** Same as above, with an explicit `this` for listeners (also used for filtering). */
    bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /**
     * Dispatch an event whose last argument is a `next` continuation.
     *
     * Each listener wraps the rest of the chain: calling `next()` invokes the
     * next listener (finally the built-in behavior); not calling it vetoes.
     *
     * @param name — the event name.
     * @param args — listener arguments; the final one is the innermost `next`.
     * @returns the outermost listener's return value.
     */
    // waterfall：洋葱模型——最后一个参数是内层 next()；监听器不调 next() 即否决
    // 整条链（含内建行为）。DSH 约定：waterfall 监听器必须调用 next()。
    waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /** Same as above, with an explicit `this` for listeners (also used for filtering). */
    waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    /**
     * Register an event listener owned by the current fiber.
     *
     * @param name — the event name to listen for.
     * @param listener — called with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    // on：注册监听器，归属当前 Fiber（卸载自动移除）；返回移除函数。
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /**
     * Same as `on()`, but the listener disposes itself after its first call.
     *
     * @param name — the event name to listen for.
     * @param listener — called at most once with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    // once：触发一次后自动注销的 on。
    once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /* eslint-enable max-len */
  }
}

/** Options accepted by `ctx.on()` and `ctx.once()`. */
// 监听器选项。
export interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  // prepend：插队到同名事件监听器最前面。
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  // global：绕过上下文过滤，任何 ctx 派发都能收到（内核内部事件用）。
  global?: boolean
}

/** Registered listener record stored by the event service. */
// 已注册监听器记录：注册时上下文 + 回调 + 选项。
export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
}

/**
 * Event bus installed as `ctx.events` and mixed into every context.
 *
 * The service supports concurrent, synchronous, serial, bail, and waterfall
 * dispatch and automatically disposes listeners with their owning fiber.
 */
// 事件总线服务本体。
export class EventsService {
  // 事件名 → 监听器记录数组（无原型对象，避免键冲突）。
  _hooks: Record<keyof any, Hook[]> = Object.create(null)

  constructor(private ctx: Context) {
    // 追踪元数据：事件方法转发时保持调用方上下文。
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    // 内建事件 internal/listener：拦截监听器注册。
    // 这里特殊处理 internal/update 的注册：把它转存到 fiber._hooks 上，
    // 以便 internal/update 派发时能枚举到（供 update waterfall 收集监听器）。
    this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'internal/update' && !options.global) {
        const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
        const method = options.prepend ? 'unshift' : 'push'
        // 注册为 fiber effect：fiber 卸载时自动从列表移除。
        return this.fiber.effect(() => hooks[method](listener), 'ctx.on("internal/update")')
      }
    })

    // 内建事件 internal/update：配置更新 waterfall。
    // 用一次性快照（[...this._hooks]）构造洋葱链，最后落到内建 next（重启 fiber）。
    this.on('internal/update', function (config, next) {
      const cbs = [...this._hooks['internal/update'] || []]
      const _next = () => {
        const cb = cbs.shift() ?? next
        return cb.call(this, config, _next)
      }
      return _next()
    }, { global: true, prepend: true })

    // 内建事件 internal/config：配置解析 waterfall——在最外层叠加
    // 「按插件运行时的 Config schema 校验并规范化」这一步。
    this.on('internal/config', (fiber, next) => {
      const config = next()
      return fiber.runtime ? resolveConfig(fiber.runtime, config) : config
    })
  }

  // _resolve：统一解析派发参数。签名有二：(name, ...args) 或 (thisArg, name, ...args)。
  private _resolve(type: string, args: any[]) {
    // 第一个参数是对象/函数时视为显式 thisArg（移出参数表）。
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string | symbol = args.shift()
    // 非内部事件派发前先广播 internal/dispatch（供调试器/诊断工具观测）。
    if ((typeof name !== 'string' || !name.startsWith('internal/')) && this._hooks['internal/dispatch']?.length) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    // 上下文过滤：thisArg 上若挂了 Context.filter 谓词，则只保留对其生效的监听器
    // （global 监听器豁免）。返回绑定了 thisArg 的回调数组。
    const filter = thisArg?.[Context.filter]
    return [thisArg, (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx)).map(hook => hook.callback)] as const
  }

  /**
   * Resolve bound callbacks using the event's context filter.
   * @param type Dispatch mode reported to observers.
   * @param args Dispatch arguments, consumed through the event name.
   * @returns Matching callbacks bound to the dispatch receiver.
   * DSH retains callback enumeration for per-listener error containment.
   */
  // dispatch：只解析回调列表而不立即执行（供 fiber 卸载通知等逐个调用并隔离错误）。
  dispatch(type: string, args: any[]) {
    const [thisArg, callbacks] = this._resolve(type, args)
    return callbacks.map(callback => callback.bind(thisArg))
  }

  /**
   * Run listeners concurrently and wait for all of them.
   *
   * @param args — optional `this`, the event name, then listener arguments.
   * @returns a promise resolving once every listener has settled.
   */
  // parallel：并发运行全部监听器；用 allSettled 收集，任一 reject 则抛 AggregateError
  //（不吞错误，同时也不让单个失败打断其他监听器）。
  async parallel(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('parallel', args)
    const results = await Promise.allSettled(callbacks.map(async callback => Reflect.apply(callback, thisArg, args)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(error => error.reason))
  }

  /**
   * Run listeners synchronously without waiting for returned promises.
   *
   * @param args — optional `this`, the event name, then listener arguments.
   */
  // emit：同步逐个调用，不等待返回的 Promise（火后不管）。
  emit(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    for (const callback of callbacks) Reflect.apply(callback, thisArg, args)
  }

  /**
   * Run listeners in order, awaiting each, until one returns a bail value.
   *
   * @param args — optional `this`, the event name, then listener arguments.
   * @returns the first bail value (see {@link isBailed}), if any.
   */
  // serial：按序 await，一旦有 bail 值立即返回（后面的监听器不再执行）。
  async serial(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('serial', args)
    for (const callback of callbacks) {
      const result = await Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  /**
   * Run listeners synchronously until one returns a bail value.
   *
   * @param args — optional `this`, the event name, then listener arguments.
   * @returns the first bail value (see {@link isBailed}), if any.
   */
  // bail：serial 的同步版本。
  bail(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('bail', args)
    for (const callback of callbacks) {
      const result = Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  /**
   * Compose listeners around the final `next` callback.
   *
   * The last dispatch argument is treated as the innermost `next`. Listeners
   * run outermost-first; a listener that does not call `next()` vetoes the
   * rest of the chain, including the built-in behavior.
   *
   * @param args — optional `this`, the event name, listener arguments, then `next`.
   * @returns the outermost listener's return value.
   */
  // waterfall：洋葱模型核心。先移出最末参数作为内建 next（inner），
  // dispatch() 递归构造洋葱链：每个监听器收到自己的 next()，
  // 重复调用 next() 抛错；不调用则整条链（含内建行为）被否决。
  waterfall(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('waterfall', args)
    const inner = args.pop()
    const dispatch = () => {
      const callback = callbacks.shift()
      // 监听器耗尽：执行内建行为。
      if (!callback) return inner()
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch()
      }
      // 把 next 追加到参数尾部调用监听器。
      return Reflect.apply(callback, thisArg, [...args, next])
    }
    return dispatch()
  }

  // register：把监听器注册为当前 fiber 的 effect——fiber 卸载时自动反注册。
  private register(label: string, name: string | symbol, callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      const hooks = this._hooks[name] ??= []
      hooks[method]({ ctx: this.ctx, callback, ...options })
      // 返回反注册函数（effect 清理时调用）。
      return () => this.unregister(name, callback)
    }, label)
  }

  // unregister：按回调引用移除监听器；事件空表时删除键，避免对象膨胀。
  private unregister(name: string | symbol, callback: any) {
    const hooks = this._hooks[name]
    if (!hooks) return
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      if (!hooks.length) delete this._hooks[name]
      return true
    }
  }

  /**
   * Register an event listener owned by the current fiber.
   *
   * The listener is removed automatically when the fiber unloads. Throws
   * `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
   *
   * @param name — the event name to listen for.
   * @param listener — called with the dispatch arguments.
   * @param options — listener options; a boolean is shorthand for `prepend`.
   * @returns a disposer removing the listener; `true` if it was still registered.
   */
  // on：注册入口。选项简化（布尔 → prepend）；断言 fiber 存活；
  // 用 reflect.bind 包装监听器使调用时的 this/参数都被追踪到当前上下文；
  // 先给 internal/listener 一个 bail 机会（内核可接管注册），否则普通注册。
  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    // 上游注释：特殊事件处理——先确保 fiber 活着，再包装监听器。
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    // internal/listener 为 bail 派发：返回真值表示已被接管。
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    // effect 标签（诊断树里显示的注册点描述）。
    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, name, listener, options)
  }

  /**
   * Register an event listener that disposes itself after the first call.
   *
   * @param name — the event name to listen for.
   * @param listener — called at most once with the dispatch arguments.
   * @param options — listener options; a boolean is shorthand for `prepend`.
   * @returns a disposer removing the listener; `true` if it was still registered.
   */
  // once：先注销自身再执行用户回调，保证重入安全。
  once(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }
}

/**
 * Built-in framework events used by core services and extension points.
 *
 * Plugin and status events track fiber lifecycle, service events observe
 * dependency registration, update/get/set/listener events allow core services
 * to intercept runtime operations, and `internal/dispatch` exposes event-bus
 * diagnostics before public events are delivered.
 */
// 内建事件表：供内核服务与扩展点使用的 internal/* 事件。
// 通过声明合并，业务插件可以向 Events 追加自己的事件名（如 DSH 的 session/event）。
export interface Events {
  // symbol 键：允许以 symbol 作为事件名（内部通道）。
  [key: symbol]: (...args: any[]) => any
  /** A plugin fiber was created or its uid was cleared on disposal. */
  // internal/plugin：插件 Fiber 创建（或卸载时 uid 清空）通知。
  'internal/plugin'(fiber: Fiber): void
  /** A fiber changed lifecycle state; receives the fiber and its previous state. */
  // internal/status：Fiber 生命周期状态迁移（PENDING→LOADING→ACTIVE→UNLOADING…）。
  'internal/status'(fiber: Fiber, oldValue: FiberState): void
  /** A service binding was refreshed in the matching isolation scope. */
  // internal/service：某个隔离作用域内的服务绑定刷新（值可能变化）。
  'internal/service'(this: Context, name: string, value: any): void
  /**
   * Apply resolved config; omitting `next()` keeps the current instance.
   * @param resolvedConfig - the evaluated and validated candidate.
   * @param next - restarts the fiber and waits for its lifecycle work.
   * @mode waterfall
   */
  // internal/update：配置更新 waterfall——监听器可改写配置或否决重启。
  'internal/update'(this: Fiber, resolvedConfig: any, next: () => Awaitable<void>): Awaitable<void>
  /**
   * Persist original config from a programmatic update, before its lifecycle transition.
   * @param fiber - the updated fiber.
   * @param originalConfig - the raw candidate; omitted when update uses noSave.
   * @mode emit
   */
  // internal/commit：程序化更新在生命周期迁移前持久化原始配置的通知。
  'internal/commit'(fiber: Fiber, originalConfig: any): void
  /**
   * Resolve plugin config after injections are active; candidate resolution does not publish it.
   * @param fiber - the fiber whose candidate is being resolved.
   * @param next - obtains the raw candidate from inner listeners.
   * @mode waterfall
   */
  // internal/config：配置解析 waterfall——注入就绪后解析候选配置（不发布）。
  'internal/config'(fiber: Fiber, next: () => any): any
  /** Waterfall: a service is being read through the context proxy. */
  // internal/get：上下文代理读取服务的 waterfall（可改写返回值或注入自定义实现）。
  'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any
  /** Waterfall: a service is being written through the context proxy. */
  // internal/set：上下文代理写入服务的 waterfall。
  'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean
  /** Bail: a listener is being registered; a non-null result replaces registration. */
  // internal/listener：监听器注册拦截（bail 模式，返回真值即接管注册）。
  'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void
  /** An event is being dispatched to listeners (fired for non-internal events only). */
  // internal/dispatch：事件派发观测点（仅非内部事件触发）。
  'internal/dispatch'(mode: DispatchMode, name: string | symbol, args: any[], thisArg: any): void
}
