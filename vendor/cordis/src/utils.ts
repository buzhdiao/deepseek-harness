// 【中文逐行注释 · Cordis 内核 8/9：utils.ts —— 共享工具：符号表/可清理列表/可追踪代理】
// 本文件是内核的「底层车间」：内部符号表（symbols）、O(1) 删除的 DisposableList、
// 原型链合并、可调用服务对象工厂，以及最精妙的部分——createTraceable 可追踪代理。
// 可追踪代理解决一个关键问题：服务方法被插件拿去当回调传递时，调用点（use site）
// 与定义点（def site）可能不同，服务解析、隔离作用域、拦截配置必须各归其位。
import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Context, Service } from './index.ts'

/** Ordered collection of disposable values with O(1) deletion by value. */
// DisposableList：按值 O(1) 删除的有序可清理集合——序号映射 + WeakMap 反查。
export class DisposableList<T extends WeakKey> {
  // 三个私有字段：sn 自增序号；map 序号→值；weak 值→序号（弱引用，不阻止 GC）。
  private sn = 0
  private map = new Map<number, T>()
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  // push：登记值并返回「移除它」的函数（effect 常用）。
  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  // delete：按值删除（经 WeakMap 反查序号）。
  delete(value: T) {
    const sn = this.weak.get(value)
    if (!sn) return false
    return this.map.delete(sn)
  }

  // clear：清空并返回全部值（逆序——卸载时按注册的逆序清理）。
  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}

/** Metadata used by traceable proxies to rebind `ctx` and associated services. */
// Tracker：可追踪代理的元数据——associate 关联服务名、property 是 ctx 属性名、
// noShadow 禁用影子重绑定。
export interface Tracker {
  associate?: string
  property?: string
  noShadow?: boolean
}

/** Shared symbols used to avoid public property-name collisions. */
// symbols：内核全部内部符号。统一用 Symbol.for 注册到全局注册表——
// 即使加载多份 cordis 副本，符号依然同一（跨副本互操作的关键）。
export const symbols = {
  // internal symbols
  // 内部符号：影子上下文、调用方/接收方、原始对象、方法元数据、初始化钩子、原型检查标记。
  shadow: Symbol.for('cordis.shadow'),
  caller: Symbol.for('cordis.caller'),
  receiver: Symbol.for('cordis.receiver'),
  original: Symbol.for('cordis.original'),
  metadata: Symbol.for('cordis.metadata'),
  initHooks: Symbol.for('cordis.initHooks'),
  checkProto: Symbol.for('cordis.checkProto'),

  // context symbols
  // 上下文符号：effect 诊断、监听器过滤、隔离表、拦截表。
  effect: Symbol.for('cordis.effect') as typeof Context.effect,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  // 服务符号：init/check/config/invoke/extend/tracker/resolveConfig（见 service.ts）。
  init: Symbol.for('cordis.init') as typeof Service.init,
  check: Symbol.for('cordis.check') as typeof Service.check,
  config: Symbol.for('cordis.config') as typeof Service.config,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  resolveConfig: Symbol.for('cordis.resolveConfig') as typeof Service.resolveConfig,
}

// 取得生成器/异步生成器函数的构造器，用于形态判定。
const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

/** Return true when a plugin callback should be constructed with `new`. */
// isConstructor：判定插件回调是否应当用 new 构造（类插件）。
// 上游注释：箭头/异步函数没有 prototype；生成器与异步生成器不可 new；
// 不能用 prototype.constructor === func 判断，因为 mock.fn() 是代理。
export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function
  // 上游注释：异步函数或箭头函数。
  if (!func.prototype) return false
  // generator function or malformed definition
  // we cannot use below check because `mock.fn()` is proxied
  // if (func.prototype.constructor !== func) return false
  if (func instanceof GeneratorFunction) return false
  // polyfilled AsyncGeneratorFunction === Function
  // 上游注释：polyfill 场景下 AsyncGeneratorFunction 可能 === Function，需判空区分。
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false
  return true
}

/** Merge two prototype chains while preserving descriptors from `proto1`. */
// joinPrototype：把两条原型链合并为一条——proto1 的描述符保留在上层，
// 递归拼接得到合并后的原型链（可调用服务用：实例方法 + 函数原型）。
export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

/** Return true for non-null objects and functions. */
// isObject：非空对象或函数。
export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

/** Find a property descriptor by walking an object's prototype chain. */
// getPropertyDescriptor：沿原型链查找属性描述符（Reflect.getOwnPropertyDescriptor 只看自有属性）。
export function getPropertyDescriptor(target: any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

/** Wrap services/functions so method calls see the caller's active context. */
// getTraceable：若值带 Tracker 元数据，则包装为「可追踪代理」——
// 方法调用时能感知调用方的上下文；否则原样返回。
// 这是 ctx.foo.bar() 与 ctx['foo.bar']() 行为一致、服务方法在回调中传递后
// 仍解析到正确作用域的基础。
export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  // 已是影子（shadow）：返回其原型，避免重复包装。
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

/** Return a proxy that overlays readonly or writable properties onto a target. */
// withProps：在目标上叠加一层属性视图（get/set 优先读 props）——
// 用于「混入视图」与临时替换 ctx 属性（如注入后的上下文）。
export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

// withProp：单属性版本的 withProps（不可写）。
function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

// createShadow：为属性访问建立「影子上下文」——把定义点（def site）包装进
// 使用点（use site）的属性视图，使方法内 this 既能看到 use site 的属性，
// 服务解析又按 def site 进行。
function createShadow(useSite: Context, target: any, property: string | undefined, receiver: any) {
  if (!property) return receiver
  const value = getPropertyDescriptor(target, property)?.value
  if (!value) return receiver
  const defSite = (value[symbols.shadow] as Context | undefined) ?? value
  return withProp(receiver, property, useSite.extend({ [symbols.shadow]: defSite }))
}

// createShadowMethod：包装方法——若 this 是外层代理则替换为影子，
// 返回值再经 getTraceable 包装，保持追踪链不断。
function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

// `ctx` may be a shadow, i.e. a pair of:
// - def site: where the accessing code was defined, governs service resolution
// - use site: where the service is consumed, governs intercept, isolate and effects
// 上游注释：ctx 可能是影子——即「定义点/使用点」对：
// 定义点决定服务解析，使用点决定拦截、隔离与 effect 归属。
function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
  const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) as Context : ctx
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      // 内部符号直接返回原始对象/定义点，供穿透与诊断。
      if (prop === symbols.original) return target
      if (prop === symbols.caller) return defSite
      // ctx 属性（如 service.ctx）返回使用点——方法内拿到的 ctx 是调用现场。
      if (prop === tracker.property) return useSite
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      // `ctx` rather than `useSite`, so that `ctx.foo.bar` and `ctx['foo.bar']` are
      // governed by the same def site
      // 上游注释：关联服务（a.b 复合键）统一走 ctx 解析，保证两种访问形式一致。
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      let shadow: any, innerValue: any
      const desc = getPropertyDescriptor(target, prop)
      if (desc && 'value' in desc) {
        innerValue = desc.value
      } else {
        // getter 场景：以影子为 this 执行。
        shadow = createShadow(useSite, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      // 内层值若也是服务（带 tracker）——递归包装；
      // 内层是普通函数——包装为影子方法（调用时 this 指向影子）；
      // 否则原样返回。
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(useSite, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        shadow ??= createShadow(useSite, target, tracker.property, receiver)
        return createShadowMethod(useSite, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      // 内部符号与 ctx 属性不可写。
      if (prop === symbols.original) return false
      if (prop === symbols.caller) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      // 关联服务复合键：透传给 ctx 解析（带 receiver 记录）。
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      // 普通写入：经影子转发到目标。
      const shadow = createShadow(useSite, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      // 调用时以影子为 this（noShadow 除外）。
      const receiver = tracker.noShadow
        ? proxy
        : createShadow(useSite, target, tracker.property, proxy)
      return applyTraceable(receiver, target, thisArg, args)
    },
  })
  return proxy
}

// applyTraceable：可调用服务的分发——带 [symbols.invoke] 的服务调用时执行 invoke 体。
function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

/** Create a callable service object that dispatches through `symbols.invoke`. */
// createCallable：创建「像函数一样可调用」的服务对象：
// 调用时构造追踪代理并转给 invoke 分发；原型链合并使 instanceof 仍成立。
export function createCallable(name: string, proto: {}, tracker: Tracker) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return Reflect.apply(proxy, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

// StackInfo：错误栈拼接的上下文——偏移量与内部错误对象。
interface StackInfo {
  offset: number
  error: Error
}

// handleError：把外部（调用方）栈帧拼接到异步抛出的错误栈上，
// 使 async 插件回调的错误看起来从调用点抛出（长栈追踪）。
function handleError(info: StackInfo, reason: any, getOuterStack: () => string[]): never {
  const innerLines = info.error.stack!.split('\n')

  // malformed error
  // 上游注释：stack 不可用的畸形错误——包装成新 Error 再拼外部栈。
  if (typeof reason?.stack !== 'string') {
    const outerError = new Error(reason)
    const lines = outerError.stack!.split('\n')
    lines.splice(1, Infinity, ...getOuterStack())
    outerError.stack = lines.join('\n')
    throw outerError
  }

  // long stack trace
  // 上游注释：长栈拼接——定位内部栈在真实栈中的位置（容忍 <anonymous> 帧偏移），
  // 然后把外部栈帧插入。
  const lines: string[] = reason.stack.split('\n')
  let index = lines.indexOf(innerLines[2])
  if (index === -1) throw reason

  index -= info.offset
  while (index > 0) {
    if (!lines[index - 1].endsWith(' (<anonymous>)')) break
    index -= 1
  }
  lines.splice(index, Infinity, ...getOuterStack())
  reason.stack = lines.join('\n')
  throw reason
}

/** Run a callback and splice outer call-site frames into thrown async errors. */
// composeError：运行回调；对同步/异步抛出的错误拼接外部调用栈（诊断友好）。
export function composeError<T>(callback: (info: StackInfo) => T, getOuterStack = buildOuterStack()): T {
  const info: StackInfo = { offset: 1, error: new Error() }

  try {
    const result: any = callback(info)
    if (isObject(result) && 'then' in result) {
      // Promise 结果：在 rejection 路径上做同样的栈拼接。
      return (result as any).then(undefined, (reason) => handleError(info, reason, getOuterStack)) as T
    } else {
      return result
    }
  } catch (reason: any) {
    handleError(info, reason, getOuterStack)
  }
}

/** Capture a lazy stack-frame supplier for later error composition. */
// buildOuterStack：惰性捕获外部调用栈（此刻记栈，出错时才拼接）。
export function buildOuterStack(offset = 0) {
  const outerError = new Error()
  return () => outerError.stack!.split('\n').slice(3 + offset)
}
