/**
 * Scoped-context primitive: mint a Cordis context that tags registrations with
 * an opaque identity and build routing-only event carriers for that identity.
 *
 * @module @deepseek-ai/dsh-scope
 */

// 【中文逐行注释 · DSH 核心包 1：core/scope —— 作用域原语（每个 agent 一套注册）】
// 本模块是「把一次注册限定在某个 agent/子树内」的原语，是 architecture.md 中
// “Scope a registration to one agent → use that agent's agent.ctx” 的底层。
// 三个概念：
// 1) ScopeKey——不透明身份（object 引用比较），标记一段注册属于哪个作用域；
// 2) createScope——铸造一个带标签的 Cordis 子上下文，其上注册随 scope 卸载回滚；
// 3) scopeTarget——构造「只做事件路由」的接收器：祖先作用域的监听器能收到
//    后代作用域的事件（事件沿链向上流动），反向不行。
// 对「一切皆插件」的意义：能力插件（工具、上下文注入等）可以用普通 API 写一次，
// 然后被任意 agent 作用域复用与隔离，无需为每个 agent 复制插件代码。
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'

export { AnonymousEntries, NamedEntries, ScopedLayers } from './store.ts'
export type { ScopeLayer } from './store.ts'

/** An opaque, identity-compared scope key. */
// 作用域键：不透明对象，仅按引用比较——调用方无法伪造或猜出别人的作用域。
export type ScopeKey = object

/** Context tag written by {@link createScope}. */
// 上下文标签符号：createScope 写在子 ctx 上，scopeOf 用它读回。
const kScope = Symbol('dsh.scope')

// 品牌类型声明：给 Scoped<T> 打上编译期标记（运行时不存在）。
declare const ScopedBrand: unique symbol

/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
// Scoped<T>：路由专用事件接收器——只携带品牌类型参数（供派发检查），
// 不暴露主题属性；事件载荷里才带真正的主题对象。
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
// carrier → 键 的弱映射：值为 undefined 表示「无键载体」，键不存在表示「非载体」。
const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

/**
 * The enclosing scope of each key. One relation powers both directions of
 * scope nesting: registration views inherit DOWN the chain (a child scope
 * sees its ancestors' layers — {@link ScopedLayers}), and event admission
 * extends UP it (a listener tagged with an ancestor receives events dispatched
 * to a descendant key — {@link scopeTarget}).
 */
// key → 父 key 的弱映射（上游注释）：一条关系同时支撑两个方向——
// 注册视图沿链向下继承（子作用域可见祖先层，见 store.ts 的 ScopedLayers），
// 事件准入沿链向上扩展（祖先标签的监听器收到派发给后代键的事件）。
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/** The privileged handle to move one scope key's parent link. */
// 特权句柄：只有 bindScopeParent 的返回者才有权改父链接。
export interface ScopeParentBinding {
  /**
   * Re-link the bound key to a different parent, with the same cycle check as
   * the bind. Valid only while nothing produced under the old parent is
   * retained — the blank-session recompose contract, which the holder upholds
   * because this relation cannot see what a session logged.
   * @param parent - the new enclosing scope key.
   */
  // rebind：把键重新挂到新父级（同样的环检查）。仅在旧父级下产出的内容
  // 都未被保留时合法（空白会话重组契约由持有者维护）。
  rebind(parent: ScopeKey): void
}

/** Cycle-checked write shared by the bind and every rebind. */
// linkScopeParent：bind 与 rebind 共用的写入——沿父链检查不会成环。
function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('dsh-scope: scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

/**
 * Bind `parent` as `key`'s enclosing scope, once.
 *
 * A key that already has a parent throws: there is no open re-link path, so a
 * scope's ancestry cannot be moved by anyone but the original binder, who
 * alone receives the {@link ScopeParentBinding}. A link that would close a
 * cycle is rejected, because every chain consumer walks parents to the root.
 * @param key - the child scope key.
 * @param parent - its enclosing scope key.
 * @returns the binding that alone may re-link this key.
 */
// bindScopeParent：一次性绑定父子作用域。已有父级的键抛错——除原始绑定者
// （唯一持有 rebind 句柄）外无人能改动谱系；成环的链接被拒绝（链消费方要走到根）。
export function bindScopeParent(key: ScopeKey, parent: ScopeKey): ScopeParentBinding {
  if (scopeParents.has(key)) {
    throw new Error('dsh-scope: scope key is already bound to a parent; re-linking requires the binding returned by the original bind')
  }
  linkScopeParent(key, parent)
  return {
    rebind(next: ScopeKey): void {
      linkScopeParent(key, next)
    },
  }
}

/**
 * Read one key's enclosing scope.
 * @param key - the scope key to inspect.
 * @returns its parent key, or `undefined` for a root scope.
 */
// scopeParentOf：读某个键的父作用域（根作用域返回 undefined）。
export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

/**
 * The chain from a key to its root ancestor.
 * @param key - the starting key, or `undefined` for the empty chain.
 * @returns keys nearest-first: `[key, parent, grandparent, …]`.
 */
// scopeChainOf：从键到根的链（近端优先）。
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

/** A minted registration scope and its quiescent disposal boundaries. */
// Scope：铸造出的注册作用域与两类卸载边界。
export interface Scope {
  /** Context through which scope-owned registrations are made. */
  // ctx：作用域专属上下文——在它上面的注册都归属本作用域。
  ctx: Context
  /** Exact Cordis disposer, used when nesting this scope in an ordered composite effect. */
  // rawDispose：Cordis 原生 disposer（在有序复合 effect 中嵌套作用域时用精确语义）。
  rawDispose: () => Promise<void> | void
  /** Dispose every scope-owned registration; racing calls await the same completion. */
  // dispose：卸载全部作用域内注册；并发调用共享同一个完成 Promise（幂等）。
  dispose(): Promise<void>
}

/** Follow a Cordis fiber through asynchronous teardown even if its raw disposer was already claimed. */
// quiesceFiber：即使原始 disposer 已被别人拿走，也能跟随 fiber 等到异步清理结束。
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  // inertia 不为空说明迁移（装载/卸载）仍在进行——逐一等待至静止。
  while (fiber.inertia !== undefined) await fiber.inertia
}

/** Shared no-op plugin used as the backing scope fiber. */
// scope：共享的空插件——每个作用域背后挂一个它的 fiber 作为注册宿主。
function scope(): void {}

/** Options accepted by {@link createScope}. */
export interface CreateScopeOptions {
  /** Enclosing scope bound via {@link bindScopeParent} before the scope is usable; the binding stays internal. */
  // parent：铸造前先经 bindScopeParent 绑定外层作用域（绑定关系保持内部）。
  parent?: ScopeKey
}

/**
 * Mint a scope under `ctx`. The scoped context inherits the minting plugin's
 * dependency API and owns every registration made through it.
 * @param ctx - active context whose dependency API the scope inherits.
 * @param key - opaque identity used for listener routing.
 * @param options - optional scope-chain placement.
 * @returns the scoped context and exact/shared disposal boundaries.
 */
// createScope：铸造作用域。空插件 fiber 提供宿主；子 ctx 原型继承铸造插件的
// 依赖 API 并打上 kScope 标签；dispose 幂等（并发调用共享同一 Promise）。
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  // 可选：先把 key 挂到指定父作用域（谱系一旦建立即受保护）。
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  // 以空插件为宿主开一个 fiber——作用域内全部注册都是该 fiber 的 effect。
  const fiber = ctx.plugin(scope)
  // 在插件 ctx 上 extend 出作用域上下文并写入标签。
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

/**
 * Read the nearest scope tag inherited by a context.
 * @param ctx - context to inspect.
 * @returns its scope key, or `undefined` for an unscoped context.
 */
// scopeOf：读 ctx 继承到的最近作用域标签（未标注返回 undefined）。
export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

/**
 * Build an opaque receiver that preserves the base filter, admits untagged
 * listeners globally, and admits tagged listeners for a matching key or any
 * of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
 * scope receives every descendant scope's events, which is what lets one
 * standing composition observe each of the agents composed under it. A tag
 * BELOW the dispatch key stays excluded — events flow up the chain, never
 * down.
 * @param base - subject or service whose existing Cordis filter is preserved.
 * @param key - routed scope identity, or `undefined` for an unscoped subject.
 * @returns a carrier whose subject remains available only through event arguments.
 */
// scopeTarget：构造事件路由接收器（上游注释详尽）：
// - 保留 base 原有的 Cordis 过滤器；
// - 未打标签的监听器全局放行；
// - 带标签的监听器：标签等于派发键或其任意祖先时放行——
//   即「外层作用域的监听器收到每个后代作用域的事件」，
//   这正是「一份常驻组合观察其下所有 agent」的实现方式；
// - 标签在派发键之下（更深的子作用域）被排除：事件只向上流，不向下。
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  // 先保留 base 已有的过滤器（如果有）。
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      // 原过滤器不过关的直接拒绝。
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      // 监听器上下文无标签：放行。
      const tag = scopeOf(ctx)
      if (tag === undefined) return true
      // 沿派发键的父链向上走：命中监听器标签即放行（事件向祖先流动）。
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  // 记录载体键：区分「无键载体」与「非载体」。
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

/**
 * Test whether a value is a scope carrier.
 * @param value - dispatch receiver to inspect.
 * @returns whether {@link scopeTarget} created it.
 */
// isScopeCarrier：判定是否为 scopeTarget 造出的载体（WeakMap 有键即载体）。
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === 'object' && value !== null && carrierKeys.has(value)
}

/**
 * Read a carrier's routing key.
 * @param value - dispatch receiver to inspect.
 * @returns the carrier key, or `undefined` for an unkeyed/non-carrier value.
 */
// carrierKeyOf：读取载体的路由键（非载体或无键返回 undefined）。
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}
