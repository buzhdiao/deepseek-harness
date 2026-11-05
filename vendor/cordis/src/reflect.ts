// 【中文逐行注释 · Cordis 内核 6/9：reflect.ts —— 反射层：服务的注册/解析/混入】
// ReflectService 是 Context 代理背后的引擎：`ctx.foo` 这类属性读取之所以能解析到
// 「某个插件提供的服务实现」，全靠本文件的 Proxy trap 与 store。
// 三条主线：
// 1) provide/notify——插件提供服务并唤醒等待它的依赖方（依赖驱动装配）；
// 2) handler.get/set——把属性访问翻译成服务解析（含隔离作用域与 internal/get/set 钩子）；
// 3) accessor/mixin——把服务的方法直接暴露在 ctx 上（如 ctx.on 转发 ctx.events.on）。
import { defineProperty, isNullable } from '@deepseek-ai/cosmokit'
import type { Dict } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { getTraceable, symbols, withProps } from './utils.ts'
import { Fiber, FiberState } from './fiber.ts'

// 声明合并：给 Context 增加服务读写的公共 API（get/set/provide/accessor/mixin）。
declare module './context.ts' {
  interface Context {
    /**
     * Read a service from the store without the inject requirement.
     *
     * @param name — the service name.
     * @param strict — when `true` (default), only return implementations
     * whose providing fiber is currently active.
     * @returns the service value, or `undefined` when not (yet) provided.
     */
    // get：绕过 inject 要求直接读服务。strict（默认）时只返回「提供方 fiber 处于
    // ACTIVE 状态」的实现；非严格模式用于诊断与清理路径。
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
    /** Same as above for service names outside the typed `Context` surface. */
    // 非类型化重载：任意字符串服务名。
    get(name: string, strict?: boolean): any
    /**
     * Overwrite a provided service's value.
     *
     * Only the fiber that provided the service may set it; setting an
     * unprovided name throws.
     *
     * @param name — the service name.
     * @param value — the new service value.
     */
    // set：覆写已提供服务的值；只有提供它的 fiber 才能写；未提供的名字抛错。
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
    /** Same as above for service names outside the typed `Context` surface. */
    set(name: string, value: any): void
    /**
     * Register a service implementation owned by the current fiber.
     *
     * The service becomes visible to dependents in the same isolation scope
     * once the fiber is active; it is unregistered (waking dependents) when
     * the returned disposer runs or the fiber unloads. Throws if the name is
     * already provided in this scope or declared as an accessor.
     *
     * @param name — the service name.
     * @param value — the service value.
     * @returns a disposer that unregisters the service.
     */
    // provide：注册服务实现（归属当前 fiber）。fiber 激活后同隔离作用域的依赖方
    // 可见；disposer 执行或 fiber 卸载时注销并唤醒依赖方。重名冲突或与 accessor
    // 声明冲突时抛错。
    provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    /** Same as above for service names outside the typed `Context` surface. */
    provide(name: string, value?: any): () => void
    /**
     * Define a computed context property backed by get/set hooks.
     *
     * The accessor is removed when the current fiber unloads. Throws if the
     * name is already declared.
     *
     * @param name — the context property name.
     * @param options — the `get` hook and optional `set` hook.
     */
    // accessor：定义计算属性（自定义 get/set 钩子）；随 fiber 卸载移除。
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
    /**
     * Expose selected members of a service directly on `ctx`.
     *
     * Each mixed-in key becomes an accessor that forwards to the service
     * (binding methods to it), so e.g. `ctx.on` forwards to `ctx.events.on`.
     * Mixins are removed when the current fiber unloads.
     *
     * @param name — the context property holding the source service.
     * @param mixins — keys to forward, or a source-key → ctx-key map.
     */
    // mixin：把服务的成员直接暴露到 ctx 上（方法自动绑定服务为 this），
    // 如 ctx.on → ctx.events.on。随 fiber 卸载移除。
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    /** Same as above with a source object instead of a context property name. */
    // 重载：直接给一个源对象做混入（不经 ctx 属性中转）。
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

// 错误增强：去掉 V8 栈顶两行噪声，只保留一行 Error: message，让报错更聚焦。
function enhanceError(error: Error) {
  const lines = error.stack!.split('\n')
  lines.splice(0, 2, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

// 保留字列表：这些属性名不能被当作服务名。
const RESERVED_WORDS = ['prototype', 'then']

// - is a symbol
// - is a reserved word (prototype, then)
// - is a number string (0, 1, 2, ...)
// - starts with `_`
// 特殊属性判定（上游注释）：symbol、保留字、纯数字串、下划线开头——
// 这些属性访问绕过服务解析，直接落到对象本身（then 保留是为了 Promise 兼容）。
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return typeof prop === 'symbol'
    || RESERVED_WORDS.includes(prop)
    || parseInt(prop).toString() === prop
    || prop.startsWith('_')
}

/** Context property definition known by the reflection service. */
// 上下文属性定义的统一类型：服务或访问器。
export type Property = Property.Service | Property.Accessor

/** Property definition variants understood by `ReflectService`. */
export namespace Property {
  /** Service property backed by a provided implementation. */
  // 服务属性：由某个 provide 的实现支撑。
  export interface Service {
    /** Discriminator. */
    // 判别字段（closed union，消费方 switch 后接 assertNever）。
    type: 'service'
  }

  /** Computed context property backed by custom get/set hooks. */
  // 访问器属性：由自定义 get/set 钩子支撑。
  export interface Accessor {
    /** Discriminator. */
    type: 'accessor'
    /** Compute the property value; `error` carries the caller stack for diagnostics. */
    // get 钩子：error 参数携带调用方栈（用于诊断「无 inject 访问」）。
    get: (this: Context, receiver: any, error: Error) => any
    /** Optional setter; return `false` to reject the write. */
    // 可选 set 钩子：返回 false 表示拒绝写入。
    set?: (this: Context, value: any, receiver: any, error: Error) => boolean
  }
}

/** Concrete service implementation record stored in the root reflect service. */
// 服务实现记录：存在 root 的 reflect.store 里，按隔离标签索引。
export interface Impl {
  /** Unique identity of this provision. */
  // 本次提供的唯一身份（依赖方用 uid 感知「实现是否换了」并触发重装）。
  uid: number
  /** The service name. */
  // 服务名。
  name: string
  /** The providing context, including its service isolation. */
  // 提供方上下文（含其隔离作用域信息）。
  ctx: Context
  /** Fibers retaining this implementation until their teardown finishes. */
  // 依赖方集合：正在使用该实现、且尚未完成卸载的 fiber（保证清理顺序）。
  dependents: Set<Fiber>
  /** Wake a provision disposer after its final dependent unloads. */
  // 唤醒函数：最后一个依赖方卸载后唤醒 provide 的清理函数。
  release?: () => void
  /** The current service value. */
  // 当前服务值。
  value?: any
  /** Optional availability predicate consulted before dependents may load. */
  // 可用性谓词：依赖方加载前询问（如 LSP 服务「已连接」才算可用）。
  check?: () => boolean
  // Actual isolation symbol; may differ from the provider context after a blocked move.
  // 实际隔离标签（上游注释）：被阻塞迁移后可能与提供方 ctx 上的标签不同。
  isolate: symbol
}

/**
 * Reflection and service-resolution layer installed as `ctx.reflect`.
 *
 * This service powers the context proxy, service registration, accessors, and
 * the mixins that expose core service methods directly on `ctx`.
 */
// 反射服务本体。
export class ReflectService {
  /** Proxy traps implementing service resolution for every context object. */
  // 所有 Context 共用的 Proxy traps：读走服务解析，写走 provide 语义。
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      // 特殊属性（symbol/保留字/数字串/_开头）直接透传，不做服务解析。
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      // 对象自有属性（如 root、fiber、reflect 等）直接返回，但用 getTraceable
      // 包装，使方法调用时能感知调用方上下文（影子机制，见 utils.ts）。
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      // 预构造「无 inject 访问」错误：后续若解析失败就抛它（消息可能被改写）。
      const error = new Error(`cannot get property "${prop}" without inject`)

      try {
        // 先查访问器定义：accessor 的 get 钩子自己决定返回什么。
        const def = target.reflect.props[prop]
        if (def?.type === 'accessor') {
          return def.get.call(ctx, ctx[symbols.receiver], error)
        }

        // a fiber-less def site cannot declare `inject` at all, so it keeps the unchecked root access.
        // 上游注释：def site 没有 fiber（非插件上下文）时不可能声明 inject，
        // 保留非检查的根访问路径（宽松读取，拿不到就 undefined）。
        const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
        if (!defSite.fiber.runtime) return ctx.reflect.get(prop, false)
        // internal/get waterfall：内核/插件可在此改写服务读取结果
        //（例如按会话维度分发不同实现）。所有监听器都不接手才走默认解析：
        // 从 def site 的 fiber 沿父链向上找「已提交」的实现。
        return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
          // 该服务在 def site 作用域下的隔离标签。
          const key = defSite[symbols.isolate][prop]
          let fiber = defSite.fiber
          while (true) {
            // 先看本 fiber 已提交的依赖实现，再看本 fiber 自己 provide 的实现
            //（必须同隔离作用域），命中即返回。
            let impl = fiber.committed?.[prop]
            for (const provision of fiber.provisions) {
              if (provision.name === prop && provision.ctx[symbols.isolate][prop] === key) impl = provision
            }
            if (impl) return getTraceable(ctx, impl.value)
            // 声明了 inject 却拿不到 → 报「inactive context 中无法获取必需服务」。
            if (prop in fiber.inject) {
              error.message = `cannot get required service "${prop}" in inactive context`
              throw error
            }
            // 非 inject 属性：根 fiber 上仍找不到 → 无 inject 访问错误。
            if (!fiber.runtime) throw error
            // 父链上隔离标签变了（作用域边界）→ 停止向上，报无 inject 访问。
            if (fiber.parent[symbols.isolate][prop] !== key) throw error
            fiber = fiber.parent.fiber
          }
        })
      } catch (e: any) {
        // 只有我们预构造的错误需要增强栈，业务异常原样抛出。
        throw e === error ? enhanceError(e) : e
      }
    },

    set: (target, prop, value, ctx: Context) => {
      // 特殊属性直接透传写入。
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      // 预构造「无 provide 写入」错误。
      const error = new Error(`cannot set property "${prop}" without provide`)
      const def = target.reflect.props[prop]
      if (!def) {
        // 没有定义：def site 没有 fiber 时放行为普通属性写入；否则报错。
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
        throw enhanceError(error)
      }

      try {
        // 访问器写入：无 set 钩子即拒绝。
        if (def.type === 'accessor') {
          if (!def.set) return false
          return def.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        // 服务写入：先过 internal/set waterfall（可拦截/否决），再走 reflect.set。
        return ctx.events.waterfall('internal/set', ctx, prop, value, error, () => {
          return ctx.reflect.set(prop, value, error)
        })
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    has: (target, prop) => {
      // in 运算符：特殊属性或自有属性按常规；否则看是否声明过该属性（服务/访问器）。
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target.reflect.props[prop]
    },
  }

  /** Service implementations, keyed by isolation label. */
  // 实现存储：隔离标签 symbol → Impl。全局唯一（挂在 root 的 reflect 上）。
  public store: Dict<Impl, symbol> = Object.create(null)
  /** Declared context properties (services and accessors), by name. */
  // 属性声明表：名字 → 服务/访问器定义（决定 has/get/set 的行为）。
  public props: Dict<Property> = Object.create(null)
  private _implCounter = 0

  constructor(public ctx: Context) {
    // 追踪元数据：noShadow——服务方法调用不做影子重绑定。
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    // 混入核心方法到 ctx：
    // ctx.get/set/provide/accessor/mixin ← reflect；
    // ctx.runtime/effect ← fiber；ctx.inject/plugin ← registry；
    // ctx.on/once/parallel/emit/serial/bail/waterfall ← events。
    // 这就是「插件 API 顺手可得」的机制基础。
    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
  }

  /**
   * Read a service from the store without the inject requirement.
   *
   * @param name — the service name.
   * @param strict — when `true`, only return implementations whose providing
   * fiber is currently active.
   * @returns the service value, or `undefined` when not (yet) provided.
   */
  // get：按当前隔离作用域读实现；strict 时要求提供方 fiber 处于 ACTIVE。
  get(name: string, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
  }

  // _getImpl：内部实现查找——标签定位 + 可选的活跃性检查。
  _getImpl(name: string, strict = true) {
    const key = this.ctx[symbols.isolate][name]
    const impl = key && this.store[key]
    if (!impl) return
    if (strict && impl.ctx.fiber.state !== FiberState.ACTIVE) return
    return impl
  }

  /**
   * Overwrite a provided service's value.
   *
   * @param name — the service name.
   * @param value — the new service value.
   * @param error — carrier for the caller stack in diagnostics.
   * @returns `true` on success.
   * @throws when `name` was never provided, or was provided by another fiber.
   */
  // set：覆写服务值。未提供过 → 抛错；提供方是别的 fiber → 抛错（写权限归提供者）。
  set(name: string, value: any, error?: Error) {
    const key = this.ctx[symbols.isolate][name]
    const impl = this.store[key]
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`)
    }
    if (impl.ctx.fiber !== this.ctx.fiber) {
      throw new Error(`cannot set property "${name}" in multiple fibers`)
    }
    impl.value = value
    return true
  }

  /**
   * Register a service implementation owned by the current fiber.
   *
   * See the `ctx.provide()` overload above for the full contract.
   *
   * @param name — the service name.
   * @param value — the service value.
   * @param check — optional availability predicate for dependents.
   * @returns a disposer that unregisters the service.
   */
  // provide：注册服务实现。整体是一个 fiber effect：注册动作在 effect 内完成，
  // 清理函数在 fiber 卸载/disposer 调用时运行——服务生命周期与提供方插件严格对齐。
  provide(name: string, value?: any, check?: () => boolean) {
    return this.ctx.fiber.effect(() => {
      // 属性声明冲突检查：名字可用则登记为 service；已被声明为别的类型则抛错。
      if (!this.props[name]) {
        this.props[name] ??= { type: 'service' }
      } else if (this.props[name].type !== 'service') {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'service' }

      // 服务名在 root 上没有隔离标签时分配一个全局唯一 symbol；
      // 随后取当前 ctx 作用域下的标签（可能是 isolate 出来的子作用域）。
      this.ctx.root[symbols.isolate][name] ??= Symbol(name)
      const key = this.ctx[symbols.isolate][name]
      // 同一作用域内同名服务冲突：报错并指出现有提供方 fiber。
      const impl: Impl = { uid: ++this._implCounter, name, value, ctx: this.ctx, check, isolate: key, dependents: new Set() }
      if (this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].ctx.fiber.name}>`)
      }
      this.store[key] = impl
      // 记入本 fiber 的 provisions，供解析与卸载路径使用。
      this.ctx.fiber.provisions.add(impl)
      // fiber 已激活：立即唤醒等待本服务的依赖方。
      if (this.ctx.fiber.state === FiberState.ACTIVE) {
        this.notify([name])
      }
      // 清理函数：注销实现，并在一个「同作用域」的隔离 ctx 上广播通知——
      // 依赖方感知到服务消失会开始卸载；然后等待所有依赖方完成自身清理
      //（dependents 清空）才真正返回，保证清理顺序：先依赖方后提供方。
      return async () => {
        if (this.store[impl.isolate] === impl) delete this.store[impl.isolate]
        this.ctx.isolate(name, impl.isolate).reflect.notify([name])
        // Retired bindings cannot gain new dependents. Wait only for their
        // cleanup, even if a fiber has left the registry or starts a new load.
        // Yield even without direct dependents so child cleanup can still
        // access the inherited service before its provision is removed.
        // 上游注释：退役绑定不再接受新依赖；即使无依赖也 yield 一次，
        // 让子级清理仍能访问被继承的服务。
        await new Promise<void>((resolve) => {
          impl.release = resolve
          if (!impl.dependents.size) resolve()
        })
        impl.release = undefined
        // ensure self access before dependencies cleanup
        // 上游注释：从 provisions 摘除前保证自身可访问。
        this.ctx.fiber.provisions.delete(impl)
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  /**
   * Re-evaluate every fiber that requires one of the given services.
   *
   * @param names — the service names that changed.
   * @param filter — restricts notification to matching isolation scopes.
   */
  // notify：服务可用性变化后通知依赖方。遍历注册表里所有 fiber：
  // 对 inject 了相关服务的 fiber 调 _checkImpl（更新本地实现缓存），
  // 有变化则 _refresh（触发重装/卸载状态机）。最后对每个服务名广播 internal/service。
  notify(names: string[], filter = (ctx: Context, name: string) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false
        for (const name of names) {
          // 与该 fiber 无关（没声明依赖或不在其作用域）则跳过。
          if (!(name in fiber.inject)) continue
          if (!filter(fiber.ctx, name)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
      }
    }
    for (const name of names) {
      // 构造一个带过滤器的临时 ctx，让 internal/service 只投递给同作用域的监听器。
      const self: Context = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => filter(target, name)
      this.ctx.events.emit(self, 'internal/service', name, this._getImpl(name, false)?.value)
    }
  }

  /**
   * Define a computed context property backed by get/set hooks.
   *
   * @param name — the context property name.
   * @param options — the `get` hook and optional `set` hook.
   * @returns a disposer that removes the accessor.
   */
  // accessor：注册计算属性；同名冲突（任何类型）抛错；随 fiber 卸载删除声明。
  accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
    return this.ctx.fiber.effect(() => {
      if (name in this.props) {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'accessor', ...options }
      return () => delete this.props[name]
    }, `ctx.accessor(${JSON.stringify(name)})`)
  }

  /**
   * Expose selected members of a service directly on `ctx`.
   *
   * See the `ctx.mixin()` overload above for the full contract.
   *
   * @param source — a context property name or a source object.
   * @param mixins — keys to forward, or a source-key → ctx-key map.
   * @returns a disposer that removes all created accessors.
   */
  // mixin：为每个要转发的键注册一个 accessor，把成员访问转发到源服务。
  // 生成器形态的 effect：逐个 yield accessor 的清理函数，全部随 fiber 卸载。
  mixin(source: any, mixins: string[] | Dict<string>) {
    const self = this
    return this.ctx.fiber.effect(function* () {
      // 数组形式：ctx 键与源键同名；映射形式：ctx 键 → 源键。
      const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
      const getTarget = (ctx: Context, error: Error) => {
        // TODO enhance error message
        // 上游 TODO：错误信息可进一步细化。
        return ctx[source]
      }
      for (const [key, value] of entries) {
        yield self.accessor(value, {
          get(receiver, error) {
            const service = getTarget(this, error)
            // 服务未就绪：返回空值（调用方通常已用 inject 保证就绪）。
            if (isNullable(service)) return service
            // receiver 存在时把服务与 receiver 合成「混入视图」，
            // 使方法内 this 既有服务成员也能看到 receiver 的属性。
            const mixin = receiver ? withProps(receiver, service) : service
            const value = Reflect.get(service, key, mixin)
            // 方法要绑定到混入视图上；非函数直接返回。
            if (typeof value !== 'function') return value
            return value.bind(mixin ?? service)
          },
          set(value, receiver, error) {
            const service = getTarget(this, error)
            const mixin = receiver ? withProps(receiver, service) : service
            return Reflect.set(service, key, value, mixin)
          },
        })
      }
    }, `ctx.mixin(${JSON.stringify(source)})`)
  }

  /**
   * Attach this context's tracing wrapper to a value.
   *
   * @param value — the value to wrap.
   * @returns the traceable wrapper (or the value itself when not applicable).
   */
  // trace：给值挂上本上下文的追踪包装（可追踪代理，见 utils.ts）。
  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  /**
   * Wrap a callback so calls trace `this` and arguments to this context.
   *
   * @param callback — the function to wrap.
   * @returns a proxy delegating to `callback` with traced values.
   */
  // bind：包装回调——调用时把 this 与每个参数都 trace 到本上下文，
  // 使跨插件回调（如事件监听器）内部读 ctx 属性时仍按注册上下文解析。
  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map(arg => this.trace(arg)), newTarget)
      },
    })
  }
}
