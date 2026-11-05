// 【中文逐行注释 · Cordis 内核 4/9：registry.ts —— 插件注册表与依赖注入声明】
// 「一切皆插件」在这里成形：任何函数/类/{apply} 对象都是插件；插件用 inject
// 声明它需要哪些服务，注册表负责等待服务就绪、创建 Fiber、验证配置并启动。
// RegistryService 同时提供 map 式内省（get/has/delete/entries），供 HMR、
// 插件管理器等运行时工具操作正在运行的插件。
// 依赖说明：defineProperty 定义不可枚举属性；Dict 为字典类型；StandardSchemaV1 是
// 标准 schema 校验接口（zod/schemastery 均兼容）；Fiber 是插件生命周期实例；
// utils 提供外部栈捕获、可清理列表、符号表与属性覆盖代理。
import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Dict } from '@deepseek-ai/cosmokit'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils.ts'

// 判定一个对象是否为合法的「对象形态插件」：非空对象且带 apply 方法。
function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

/**
 * Service dependency declaration accepted by plugins and the `@Inject`
 * decorator.
 *
 * Array form requests services without intercept config. Object form maps each
 * service name to optional intercept config for the plugin context.
 */
// 依赖声明类型：数组形式 ['sessions', 'tools'] 表示按名依赖、无拦截配置；
// 对象形式 { sessions: {...} } 可同时给该服务的拦截配置。插件静态 inject
// 字段与 @Inject 装饰器都使用此类型。
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

/** Context keys that correspond to services with typed intercept config. */
// InjectKey：从 Context 接口中筛选出「带拦截配置类型（[symbols.config]）」的
// 服务名。它让 ctx.intercept(name, cfg) 与 @Inject(name, cfg) 的 cfg 获得精确类型。
export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any
}

/**
 * Decorator for declaring service dependencies on classes or class methods.
 *
 * On classes it contributes to the plugin's static `inject` map. On methods it
 * delays the method call until the declared services are available.
 */
/**
 * @param name — the required service name.
 * @param config — optional intercept config applied for that service.
 * @returns the class or method decorator.
 */
// @Inject 装饰器（TC39 标准装饰器）：
// - 用在类上：把依赖并入类的静态 inject 映射（继承链逐层合并）；
// - 用在方法上：延迟到依赖服务就绪后再调用该方法（通过 initHooks 注入回调）。
export function Inject<K extends InjectKey>(name: K, config?: Context[K] extends { [symbols.config]: infer T } ? T : never) {
  // 返回标准装饰器函数；value 是被装饰的类或方法，context 描述装饰位置。
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'class') {
      // 类场景：若本类还没有自有 inject 字段，则以父类 inject 为原型创建一份，
      // 并打上 checkProto 标记（resolve 时沿原型链合并，子类条目覆盖父类）。
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(value, 'inject', Object.create(Object.getPrototypeOf(value).inject ?? null))
        defineProperty(value.inject, symbols.checkProto, true)
      }
      // 记录本类声明的依赖：服务名 → 拦截配置。
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      // 方法场景：在方法上挂 inject 元数据（不可枚举）。
      const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null)
      inject[name] = config
      // addInitializer 在实例构造后执行：注册一个 initHook，
      // 该 hook 用 ctx.inject 等依赖就绪后调用原方法——实现「方法级延迟装配」。
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            // 若实例带 ctx 属性（可追踪代理），调用时临时替换为就绪后的注入上下文。
            return value.call(property ? withProps(this, { [property]: ctx }) : this)
          })
        })
      })
    } else {
      // 只允许类与方法两种装饰位置。
      throw new Error('@Inject() can only be used on class or class methods')
    }
  }
}

/** Utilities for normalizing plugin dependency declarations. */
// Inject 命名空间：依赖声明的规范化工具。
export namespace Inject {
  /**
   * Convert array/object/class-inherited inject metadata into a plain map.
   *
   * @param inject — the declaration to normalize; `null`/`undefined` add nothing.
   * @param result — the map to fill (service name → intercept config or `null`).
   * @returns `result`.
   */
  // resolve：把数组/对象/原型链形式的声明统一成「服务名 → 配置或 null」的平表。
  export function resolve(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
    // 空声明直接返回累积结果。
    if (!inject) return result
    if (Array.isArray(inject)) {
      // 数组形式：每项都是无配置依赖。
      for (const name of inject) {
        result[name] = null
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      // 带 checkProto 标记（@Inject 类装饰器产物）：先合并父类链，再叠加自有条目。
      Object.assign(result, resolve(Object.getPrototypeOf(inject)))
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    } else {
      // 普通对象形式：直接铺开；值缺失视为 null（无拦截配置）。
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    }
    return result
  }
}

/** Supported plugin entrypoint shapes. */
// 插件入口类型：函数、类、带 apply 方法的对象——三者等价，注册表会归一化。
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

/** Types associated with plugin entrypoints and runtime records. */
export namespace Plugin {
  /** Shared metadata understood by the plugin registry and related tooling. */
  // 三种入口共享的元数据（静态字段或对象属性均可携带）。
  export interface Base<T = any> {
    /** Display name used for fiber diagnostics and logger names. */
    // 展示名：用于 fiber 诊断与日志名字（缺省从回调函数名推导）。
    name?: string
    /** Standard-schema validator applied to config before the plugin starts. */
    // Config：标准 schema 校验器，插件启动前验证并规范化配置。
    Config?: StandardSchemaV1<any, T>
    /** Services the plugin requires; it only loads while all are available. */
    // inject：所需服务列表；只有全部可用时插件才会加载，任一不可用则自动卸载。
    inject?: Inject
    /** Service name(s) the plugin provides (read by `Service` and by loaders). */
    // provide：本插件提供的服务名（Service 基类与 loader 都会读取）。
    provide?: string | string[]
    /** Service names whose intercept config the plugin declares it consumes. */
    // intercept：声明消费哪些服务的拦截配置（供配置目录/文档工具生成说明）。
    intercept?: Dict<boolean>
  }

  // Transform：配置变换器——把用户可见配置 S 转换为运行时配置 T。
  export interface Transform<S, T> {
    /** Marks the transform object as a schema/config transform. */
    // 标记位：声明这是一个配置变换对象。
    schema?: true
    /** Convert user-facing config to runtime config. */
    // 转换函数本体。
    Config: (config: S) => T
  }

  /** Function plugin called with `(ctx, config)`. */
  // 函数插件：`(ctx, config) => any`，最常见的形态。
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  /** Class plugin constructed with `(ctx, config)`. */
  // 类插件：`new (ctx, config)`，构造即装配（通常配合 Service 基类）。
  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  /** Object plugin with an `apply(ctx, config)` method. */
  // 对象插件：`{ apply(ctx, config) }`，适合带额外静态元数据的场景。
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }

  /** Mutable registry record shared by all fibers of one plugin callback. */
  // Plugin.Runtime：同一个插件回调（跨多次 ctx.plugin 调用）共享的可变注册记录。
  export interface Runtime {
    /** Display name copied from the first registered plugin shape. */
    // 展示名：取自首次注册时的元数据。
    name?: string
    /** Every live fiber of this plugin (one per `ctx.plugin()` call). */
    // fibers：该插件当前所有存活 Fiber（每次 ctx.plugin() 一个）。
    fibers: DisposableList<Fiber>
    /** The executable entrypoint all fibers share (registry identity key). */
    // callback：可执行入口，也是注册表的身份键（同一回调 = 同一插件）。
    callback: globalThis.Function
    /** Standard-schema validator applied to each fiber's config. */
    // Config：每个 fiber 启动前都要过的配置校验器。
    Config?: StandardSchemaV1
  }
}

// Spread：根据配置是否可选生成参数元组（config 可选时允许零参调用）。
type Spread<T> = undefined extends T ? [config?: T] : [config: T]

// 从插件形态提取除 ctx 外的其余参数类型。
type GetPluginParameters<P> =
  | P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

// 提取插件的配置类型：Transform 用 S（用户侧），否则取参数表第一项。
type GetPluginConfig<P> =
  | P extends Plugin.Transform<infer S, any>
  ? S
  : GetPluginParameters<P>[0]

// 声明合并：把 inject() 与 plugin() 两个方法挂到 Context 接口上，
// 使所有插件都能直接 ctx.plugin(...) / ctx.inject(...)（实现混入到 ctx.registry 上）。
declare module './context.ts' {
  export interface Context {
    /**
     * Run a callback once the requested services are available.
     *
     * Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback
     * is unloaded and re-run whenever a required service changes.
     *
     * @param deps — required services, as an array or a name → config map.
     * @param callback — plugin body called with `(ctx, config)`.
     * @returns the fiber; awaiting it settles once loading finished.
     */
    // inject(deps, callback)：等依赖可用后运行回调的语法糖——等价于
    // ctx.plugin({ inject, apply: callback })。任一依赖变化时回调会被卸载重跑。
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
    /**
     * Load a plugin in the current context.
     *
     * @param plugin — a function, class, or `{ apply }` object plugin.
     * @param args — the plugin config, validated against its `Config` schema.
     * @returns the fiber; awaiting it settles once loading finished
     * (rejecting on config or startup errors).
     */
    // plugin(plugin, config)：在当前上下文加载插件，返回 Fiber（可 await，
    // 配置或启动出错时 reject）。这是所有插件装载的唯一入口。
    plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
  }
}

/**
 * Plugin registry installed as `ctx.registry` and mixed into every context.
 *
 * It normalizes plugin shapes, tracks plugin runtimes, starts fibers, and
 * exposes map-like inspection over active plugin callbacks.
 */
// 插件注册表服务：规范化插件形态、维护 Runtime 记录、启动 Fiber，
// 并以 map 风格暴露对活跃插件的检视能力（HMR/插件管理器依赖它）。
export class RegistryService {
  // fiber uid 计数器（get counter 时自增）。
  private _counter = 0
  // 身份键（回调函数）→ 运行时记录。
  private _internal = new Map<Function, Plugin.Runtime>()

  constructor(public ctx: Context) {
    // 挂追踪元数据：property 指明 ctx 属性名，noShadow 禁用影子重绑定。
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })
  }

  /** Allocate the next fiber uid (increments on every read). */
  // 分配下一个 fiber 的 uid（每读一次自增，保证唯一）。
  get counter() {
    return ++this._counter
  }

  /** Number of registered plugin runtimes. */
  // 当前注册的插件运行时数量。
  get size() {
    return this._internal.size
  }

  /**
   * Resolve a supported plugin shape to its executable callback.
   *
   * @param plugin — a function, class, or `{ apply }` object plugin.
   * @returns the callback identifying the plugin, or `undefined` if invalid.
   */
  // resolve：把三种插件形态归一化为可执行回调（即身份键）。
  resolve(plugin: Plugin): Function | undefined {
    // plugin.apply may throw
    // 上游注释：访问 plugin.apply 可能抛异常，故用 try 兜底返回 undefined。
    try {
      if (typeof plugin === 'function') return plugin
      if (isApplicable(plugin)) return plugin.apply
    } catch {}
  }

  /**
   * Look up the runtime record for a plugin.
   *
   * @param plugin — any supported plugin shape.
   * @returns the runtime, or `undefined` when the plugin is not registered.
   */
  // 查询插件对应的运行时记录（未注册返回 undefined）。
  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  /**
   * Check whether a plugin has a registered runtime.
   *
   * @param plugin — any supported plugin shape.
   * @returns `true` when at least one fiber of the plugin exists.
   */
  // 判断插件是否至少有一个存活 Fiber。
  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  /**
   * Dispose every running fiber for a plugin and remove its runtime record.
   *
   * @param plugin — any supported plugin shape.
   * @returns the removed runtime, or `undefined` when none was registered.
   */
  // 删除插件：先摘除运行时记录，再逐个 dispose 其 Fiber（触发卸载级联）。
  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of runtime.fibers) {
      fiber.dispose()
    }
    return runtime
  }

  /** Iterate the registered plugin callbacks. */
  // 迭代已注册的插件回调（身份键）。
  keys() {
    return this._internal.keys()
  }

  /** Iterate the registered plugin runtimes. */
  // 迭代运行时记录。
  values() {
    return this._internal.values()
  }

  /** Iterate `[callback, runtime]` pairs. */
  // 迭代 [回调, 运行时] 对。
  entries() {
    return this._internal.entries()
  }

  /**
   * Visit every registered runtime.
   *
   * @param callback — receives each runtime and its identifying callback.
   */
  // 遍历所有运行时记录。
  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  /**
   * Start a callback once the requested dependencies are available.
   *
   * @param inject — required services, as an array or a name → config map.
   * @param callback — plugin body called with `(ctx, config)`.
   * @returns the fiber; awaiting it settles once loading finished.
   */
  // inject：把「依赖 + 回调」包装成匿名对象插件后走统一的 plugin() 流程。
  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  /**
   * Start a plugin in the current context and return its fiber.
   *
   * Creates (or reuses) the plugin's runtime record, then starts a new fiber
   * under the current context. Throws if `plugin` is not a supported shape or
   * if the current fiber is already disposed.
   *
   * @param plugin — a function, class, or `{ apply }` object plugin.
   * @param config — the plugin config, validated against its `Config` schema.
   * @param getOuterStack — captures the caller stack for effect diagnostics.
   * @returns the fiber; awaiting it settles once loading finished.
   */
  // plugin()：装载插件的唯一入口。创建（或复用）Runtime，然后在当前上下文
  // 上启动一个新 Fiber；插件形态非法或当前 fiber 已卸载时抛错。
  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    // 上游注释：先校验插件形态合法并取出身份键。
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    // 当前 fiber 必须仍然存活：已卸载的上下文不能再装载插件。
    this.ctx.fiber.assertActive()

    // 复用或创建运行时记录：同一回调多次 plugin() 共享一条记录、各自一个 Fiber。
    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      // 对象插件的回调名固定是 'apply'，没有信息量，视为匿名。
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    // 创建 Fiber：携带原始配置、规范化后的依赖表与调用方外部栈。
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
    // 用原型包装让 Fiber 同时满足 PromiseLike：await fiber 等价于 fiber.await()。
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
