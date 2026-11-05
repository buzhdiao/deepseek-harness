// 【中文逐行注释 · Cordis 内核 3/9：service.ts —— Service 基类】
// Service 是「把一段能力注册为命名服务」的基类。DSH 里几乎所有面向 ctx 的
// 能力（sessions、tools、llm、shell……）都继承它：子类在构造函数里
// super(ctx, name)，实例立即注册进上下文，并随所属 Fiber 卸载自动注销。
// 这就是「一切皆插件」中服务注入的落地点：插件间不直接 import 彼此的实现，
// 而是声明依赖服务名，由内核按名字注入实例。
// 依赖说明：cosmokit 的 defineProperty 定义不可枚举属性（避免污染 for-in/JSON）；
// Context 是服务最终注册的目标容器；utils 提供可调用对象工厂（createCallable）、
// 原型合并（joinPrototype）、内部符号表（symbols）与追踪元数据类型（Tracker）。
import { defineProperty } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { createCallable, joinPrototype, symbols, type Tracker } from './utils.ts'

/**
 * Base class for services that expose a named API on `ctx`.
 *
 * Subclasses call `super(ctx, name)` from their constructor. The service is
 * registered immediately and is automatically removed with the owning fiber.
 */
// 泛型参数 T 是「拦截配置」的幻影类型（见 [symbols.config]）：允许服务声明
// 自己接受的 intercept 配置形状，让 ctx.intercept(name, cfg) 获得类型检查。
export abstract class Service<out T = never> {
  /** Symbol key of an instance method run after construction (class plugins). */
  // 类插件构造完成后执行的初始化方法符号（Service[symbols.init]()）。
  static readonly init: unique symbol = symbols.init
  /** Symbol key of the availability predicate passed to `ctx.provide()`. */
  // 可用性判定符号：注册服务时传给 ctx.provide 的 check 谓词，决定依赖方能否加载。
  static readonly check: unique symbol = symbols.check
  /** Symbol key of the phantom intercept-config type parameter. */
  // 幻影类型符号：仅存在于类型层面，携带 T（拦截配置形状），运行时无值。
  static readonly config: unique symbol = symbols.config
  /** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
  // 可调用体符号：实现后服务实例可像函数一样被调用（如 ctx.logger('name')）。
  static readonly invoke: unique symbol = symbols.invoke
  /** Symbol key of the helper deriving an extended service instance. */
  // 扩展派生符号：基于当前实例派生带额外属性的副本（isolate 场景使用）。
  static readonly extend: unique symbol = symbols.extend
  /** Symbol key of the tracker metadata used for context tracing. */
  // 追踪元数据符号：让服务方法调用时能感知调用方上下文（见 utils.ts 的 createTraceable）。
  static readonly tracker: unique symbol = symbols.tracker
  /** Symbol key of the intercept-config resolution helper below. */
  // 拦截配置解析符号：指向下方 resolveConfig 方法，供内核在加载时调用。
  static readonly resolveConfig: unique symbol = symbols.resolveConfig

  // declare：仅声明类型不产生运行时代码。把 T 挂到幻影符号上，供 InjectKey 推导。
  declare [symbols.config]: T

  /** The service name this instance is registered under. */
  // 本实例注册所用的服务名（构造时确定）。
  public name!: string

  /**
   * Register this instance as `name` in the current context.
   *
   * Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
   * service is unregistered automatically when the owning fiber unloads.
   * Services with a `[Service.invoke]` body return a callable instance.
   *
   * @param ctx — the context to register in (stored as `this.ctx`).
   * @param name — the service name; defaults to the static `provide` field.
   */
  // 构造即注册：这是「服务即插件」的核心路径——实例化服务的插件本身
  // 就是注册动作，且注册通过 fiber.effect 完成，卸载时自动回收。
  constructor(protected ctx: Context, name: string) {
    // 未显式给名字时，回退到子类静态 provide 字段（约定优于配置）。
    name ??= this.constructor['provide'] as string

    // self 最终可能与 this 不同：可调用服务会替换为函数对象（见下）。
    let self = this
    // 追踪元数据：告诉可追踪代理——本服务的 ctx 属性应随使用场景重绑定。
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    // 若子类实现了 [symbols.invoke]（可调用服务），创建一个函数对象 self，
    // 其原型链合并「实例原型 + Function.prototype」，调用时走 invoke 分发。
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
    }
    // 在最终对象上固定 ctx 与 name 两个属性。
    self.ctx = ctx
    self.name = name
    // 挂上追踪元数据（不可枚举，避免被序列化）。
    defineProperty(self, symbols.tracker, tracker)

    // 真正的注册动作：以当前 fiber 为所有者 provide 服务实例；
    // check 谓词（若子类实现）决定依赖方何时认为本服务「可用」。
    // fiber 卸载时 provide 的清理函数会自动运行，服务随之消失并唤醒等待者。
    self.ctx.reflect.provide(name, self, this[symbols.check])
    // 同样返回 self（可调用服务场景下是函数代理）。
    return self
  }

  // 事件过滤：只有当监听方 ctx 与服务自身 ctx 处于同一隔离作用域时，
  // 该 ctx 上的事件派发才会触达本服务相关的监听器（防止跨作用域串扰）。
  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
  }

  // 派生扩展：基于当前实例生成带 props 的副本。可调用服务重建函数包装，
  // 普通服务以实例为原型创建对象，再 Object.assign 追加属性。
  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  /**
   * Merge intercept config from ancestors with optional base and head values.
   *
   * Entries added closer to the root apply first; `base` is prepended and
   * `head` appended. Uses `Config.merge` when the service declares one,
   * otherwise a shallow `Object.assign`.
   *
   * @param base — lowest-precedence config merged before all intercepts.
   * @param head — highest-precedence config merged after all intercepts.
   * @returns the merged config.
   */
  // 解析拦截配置：沿 ctx 链收集本服务名下的所有 intercept 条目（越靠近根越先合并），
  // base 最先、head 最后；若服务声明了 Config.merge 用深合并，否则浅 Object.assign。
  [symbols.resolveConfig](base?: T, head?: T): T {
    // 从当前 ctx 的拦截表开始沿原型链向上走。
    let intercept = this.ctx[Context.intercept]
    const configs: any[] = []
    while (this.name in intercept) {
      // 只取自有属性（原型链上的同名条目属于更远的祖先，下一轮处理）。
      if (Object.hasOwn(intercept, this.name)) {
        configs.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    // base 作为最低优先级放在最前。
    if (base) configs.unshift(base)
    // head 作为最高优先级放在最后。
    if (head) configs.push(head)
    // 服务类声明了静态 Config 且带 merge 时用结构化合并。
    if (this['Config']?.merge) {
      return this['Config'].merge(...configs)
    } else {
      // 否则浅合并：后面的覆盖前面的。
      return Object.assign({}, ...configs)
    }
  }

  // 自定义 instanceof：沿构造函数原型链向上找，兼容实例被 Proxy 包裹的情况，
  // 使 `service instanceof XxxService` 在内核包装后依然成立。
  static [Symbol.hasInstance](instance: any) {
    if (!instance) return false
    let constructor = instance.constructor
    while (constructor) {
      // constructor may be a proxy
      // 穿透 Proxy：先取其原型的 constructor（注释为上游原文：constructor 可能是代理）。
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor &&= Object.getPrototypeOf(constructor)
    }
    return false
  }
}
