// 【中文逐行注释 · Cordis 内核 1/9：context.ts —— 上下文（Context）】
// Context 是 Cordis「一切皆插件」模型的根：所有插件都挂载在某个 Context 上，
// 通过 Context 读写服务（Service）、注册事件、派生子作用域。DSH 的每个包
// （session、tools、llm……）本质上都是向 Context 贡献服务与事件的插件。
// 本文件定义 Context 的类型形状（接口，供声明合并扩展）与根实现（类）。
// 从 cosmokit 引入通用字典类型 Dict（键值对），仅类型用途，运行时擦除。
// 以下依次引入四个内置服务与两个工具：事件总线 ctx.events（on/emit/waterfall 等
// 五种派发模式）、日志服务 ctx.logger、反射服务 ctx.reflect（服务解析）、
// 插件注册表 ctx.registry（plugin 加载与 inject 依赖等待）、getTraceable/symbols
// 工具（跨插件引用包装与内部符号表）、Fiber（插件生命周期状态机，见 fiber.ts）。
import type { Dict } from '@deepseek-ai/cosmokit'
import { EventsService } from './events.ts'
import { LoggerService } from './logger.ts'
import { ReflectService } from './reflect.ts'
import { RegistryService, type InjectKey } from './registry.ts'
import { getTraceable, symbols } from './utils.ts'
import { Fiber } from './fiber.ts'

/**
 * Public shape of a Cordis context.
 *
 * The concrete `Context` class is proxied at runtime, so this interface is
 * augmented by core services and plugins to describe the properties that may
 * be read from `ctx`.
 */
// 【Context 接口】这是「声明合并」的锚点：内核服务与 DSH 各插件都会
// 通过 `declare module './context.ts'` 向此接口追加上下文属性（如 ctx.sessions、
// ctx.tools、ctx.llm）。插件声明依赖（inject）时引用的就是这些属性名——
// 属性名即服务名，这就是「泛型注入」的类型来源。
export interface Context {
  /** Isolation map: service name → scope label. Lookups for a name resolve within its label. */
  // 服务隔离表：服务名 → 作用域标签（symbol）。同一服务可在不同 isolate 作用域
  // 各自提供一份实现；查找时按 ctx 链上的标签解析，互不串扰。
  [symbols.isolate]: Dict<symbol>
  /** Intercept map: service name → config merged into that service's per-plugin config. */
  // 服务拦截配置表：服务名 → 注入到该服务各插件配置中的额外配置。
  // 例如 ctx.intercept('logger', { level: 2 }) 会让子树内所有 logger 默认用该级别。
  [symbols.intercept]: Dict
  /** The root context of the application (every child context shares it). @experimental */
  // 根上下文引用：所有子上下文共享同一个 root；服务实现的全局注册表存在 root 的 reflect.store 中。
  root: this
  /** Base URL used to resolve relative plugin/module specifiers, if the runtime sets one. */
  // 解析相对插件说明符的基址（loader 运行时可设置），用于 import() 相对路径插件。
  baseUrl?: string | undefined
  /** The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...). */
  // 事件总线服务实例；其方法会被 mixin 到 ctx 上（ctx.on / ctx.emit 等），让插件少写一层属性访问。
  events: EventsService
  /** The logging service. Call `ctx.logger(name)` for a named logger. */
  // 日志服务实例；ctx.logger 是「可调用服务」——调用 ctx.logger(name) 返回命名日志门面。
  logger: LoggerService
  /** The reflection layer backing the context proxy (`ctx.get`, `ctx.provide`, ...). */
  // 反射层：支撑 Context 代理的服务解析（ctx.provide / ctx.get / ctx.accessor / ctx.mixin）。
  reflect: ReflectService
  /** The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`). */
  // 插件注册表：ctx.plugin() 加载插件、ctx.inject() 按依赖等待后执行回调；方法同样 mixin 到 ctx。
  registry: RegistryService
}

/**
 * Root and child dependency containers for Cordis plugins.
 *
 * A context is a proxy: normal property reads go through the service resolver,
 * while `extend()`, `isolate()`, and `intercept()` create scoped child
 * contexts without mutating their parent.
 */
// 【Context 类】根上下文实现。注意运行时它是一个 Proxy（见构造函数 return self）：
// 普通属性读取走「服务解析器」；extend/isolate/intercept 三个方法都返回新的
// 子上下文而不修改父级——作用域是纯函数式的派生，可随时丢弃。
export class Context {
  /** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
  // effect 诊断符号：每个 effect 的 disposer 上挂一个 EffectMeta 树，供 getEffects() 自省。
  static readonly effect: unique symbol = symbols.effect
  /** Symbol key for a context's listener filter, consulted on every event dispatch. */
  // 监听器过滤符号：事件派发时用 ctx[Context.filter] 判断监听器是否对当前上下文生效。
  static readonly filter: unique symbol = symbols.filter
  /** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
  // 隔离表符号键（对应上方接口的 [symbols.isolate] 属性）。
  static readonly isolate: unique symbol = symbols.isolate
  /** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
  // 拦截表符号键（对应上方接口的 [symbols.intercept] 属性）。
  static readonly intercept: unique symbol = symbols.intercept

  /**
   * Returns true for Cordis context proxies and context prototypes.
   *
   * Works across realms and across multiple copies of cordis, because the
   * brand is keyed by a global symbol rather than by `instanceof`.
   *
   * @param value — the value to test.
   * @returns `true` if `value` is a Cordis context, narrowing its type.
   */
  // 跨副本安全的 Context 判定：用全局注册的符号（Symbol.for）做品牌标记，
  // 而不是 instanceof——这样即使存在多份 cordis 副本或跨 realm 也能正确识别。
  static is(value: any): value is Context {
    // 读取实例上的 Context.is 符号属性（原型上有 true 标记），有值即为 Context。
    return !!value?.[Context.is as any]
  }

  static {
    // 静态初始化块：模块加载时执行一次。
    // 把判定函数本身与全局符号 'cordis.is' 关联，便于诊断工具识别。
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    // 在原型上打上「我是 Context」的标记，供上方 is() 读取。
    Context.prototype[Context.is as any] = true
  }

  /** Create the root context and install the built-in services. */
  // 构造函数：只被调用一次（创建根上下文），并安装全部内置服务。
  constructor() {
    // 初始化隔离表与拦截表为无原型对象（避免原型键污染，如 'constructor'）。
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    // 用反射服务的 handler 把 this 包成 Proxy：此后所有属性读写都会进入服务解析逻辑。
    const self = new Proxy<this>(this, ReflectService.handler)
    // 根上下文的 root 指向自身。
    this.root = self
    // 基址默认未设置。
    this.baseUrl = undefined
    // 创建根 Fiber：runtime 为 null 表示这是根 fiber，不对应任何插件回调；
    // 最后一个参数 () => [] 提供外部调用栈（根没有外部调用者）。
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    // 依次安装四个内置服务：反射、注册表、事件、日志。它们是插件体系的「地基」。
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
    // 构造期间各服务可能注册过 effect（如 logger 的默认 exporter），
    // 但根 fiber 永不卸载，清空收集器避免无意义的保留。
    this.fiber._disposables.clear()
    // 返回 Proxy 而非 this：构造函数返回值会取代 new 的结果，
    // 因此外部拿到的始终是带服务解析能力的代理对象。
    return self
  }

  // Node.js 调试器/控制台的自定义显示：打印 fiber 名字而非整个对象（避免循环引用刷屏）。
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.fiber.name}>`
  }

  /**
   * Create a child context with extra metadata on top of the current scope.
   *
   * The child prototypally inherits every property of this context; own
   * properties of `meta` shadow the inherited ones. The parent is not mutated.
   *
   * @param meta — own properties (including symbol keys) to define on the child.
   * @returns a child context inheriting from this one.
   */
  // extend：派生子上下文。子级通过原型链继承父级全部属性，meta 里的自有属性遮蔽同名继承值；
  // 父级完全不被修改。这是 Fiber 创建插件 ctx（parent.extend({ fiber: this })）的底层机制。
  extend(meta = {}): this {
    // 读取当前上下文是否带有「影子」标记（def site/use site 拆分的实现细节，见 utils.ts）。
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    // 以追踪目标（getTraceable 处理影子链）为原型创建子对象。
    const self = Object.create(getTraceable(this, this))
    // 把 meta 的每个自有键（含 symbol）定义为子对象的自有属性。
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }
    // 没有影子标记则直接返回子上下文。
    if (!shadow) return self
    // 有影子：再包一层对象，把影子标记带到子级，保持 def site 一致。
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
  }

  /**
   * Create a child context with an independent service scope for `name`.
   *
   * Below the returned context, reads and writes of the service `name`
   * resolve against the new label instead of the parent's, so a different
   * implementation can be provided without affecting the parent scope.
   * Passing the same `label` to two `isolate()` calls joins their scopes.
   *
   * @param name — the service name to isolate.
   * @param label — scope label to join; defaults to a fresh unique symbol.
   * @returns a child context whose `name` service resolves in the new scope.
   */
  // isolate：为某个服务创建独立作用域。子树内对该服务的读写解析到新标签，
  // 可以提供与父级不同的实现（DSH 用它实现「给某个 agent 一套独立能力集」）。
  // 相同 label 的两次 isolate 调用会合并到同一作用域（同一份实现）。
  isolate(name: string, label?: symbol) {
    // 以父隔离表为原型建影子表，写入该服务的新标签——原型链查找保证其他服务仍走父级。
    const shadow = Object.create(this[symbols.isolate])
    // 未显式给 label 时创建一个全新的唯一 symbol（完全隔离）。
    shadow[name] = label ?? Symbol(name)
    // 通过 extend 落到一个新的子上下文上（不修改父级）。
    return this.extend({ [symbols.isolate]: shadow })
  }

  /**
   * Add service-specific intercept config for plugins started below this
   * context.
   *
   * Plugins loaded under the returned context see `config` merged into the
   * service's resolved config (ancestor entries first; see
   * `Service[symbols.resolveConfig]`). The parent context is not affected.
   *
   * @param name — the service name whose config to intercept.
   * @param config — the intercept config to merge for that service.
   * @returns a child context carrying the additional intercept entry.
   */
  // intercept：为某服务追加「拦截配置」。子树内启动的插件解析该服务时，
  // 会把这里的 config 合并进服务配置（祖先条目优先，见 Service[symbols.resolveConfig]）。
  // 典型用途：在某个子树统一调整 logger 级别或 telemetry 开关。
  intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
  // 非类型化重载：任意字符串服务名 + 任意配置。
  intercept(name: string, config: any): this
  // 运行时实现：与 isolate 同构——影子表 + extend，只是写的是拦截表。
  intercept(name: string, config: any) {
    // 以父拦截表为原型创建影子表。
    const intercept = Object.create(this[symbols.intercept])
    // 记录该服务的拦截配置。
    intercept[name] = config
    // 派生子上下文承载新的拦截表。
    return this.extend({ [symbols.intercept]: intercept })
  }
}
