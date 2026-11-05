/**
 * Shared insertion-ordered storage and effect ownership for scope-aware registries.
 *
 * @module @deepseek-ai/dsh-scope
 */

// 【中文逐行注释 · DSH 核心包 2：core/scope/store.ts —— 作用域注册表存储】
// 本模块为「作用域感知的注册表」（如 per-agent 工具表）提供三块积木：
// NamedEntries——具名条目（名字唯一，重名由调用方给出诊断错误）；
// AnonymousEntries——匿名条目（同值也算独立注册）；
// ScopedLayers——全局层 + 各作用域层的所有权管理：
// 注册的可见性与 effect 归属都来自注册时所用 ctx 的作用域标签。
// 这是「一个插件的能力按 agent 隔离」的数据基础（配合 index.ts 的 createScope）。
import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from './index.ts'
import type { ScopeKey } from './index.ts'

/** One scope's aggregate contribution to a registry. */
// ScopeLayer：一个作用域对注册表的聚合贡献（由具体注册表实现层内容）。
export interface ScopeLayer {
  /** Whether every table in this layer is empty. */
  // 层内所有表是否全空（空层会被回收）。
  isEmpty(): boolean
}

/** Internal common read contract for the two entry-table implementations. */
// 两种条目表共同的对内读契约。
interface EntryValues<V> {
  values(): IterableIterator<V>
  isEmpty(): boolean
}

/**
 * Insertion-ordered named entries with caller-owned duplicate diagnostics.
 *
 * Values are borrowed. Iterators are live within one nonempty table
 * generation; draining the table detaches them from later insertions. Each
 * successful insertion returns an idempotent undo for that exact entry.
 */
// NamedEntries：插入序的具名条目表（上游注释）：
// 值是借用（不拥有）；迭代器在一个非空「代」内是活的——清空换代后与后续插入脱钩；
// 每次成功插入返回只针对本条的幂等 undo。
export class NamedEntries<V> implements EntryValues<V> {
  private data = new Map<string, V>()

  constructor(
    // duplicateError：重名时的错误工厂由调用方提供（各自报各自的错）。
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /**
   * Insert one unique name.
   * @param name - name unique within this table.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo that removes only this insertion.
   */
  // insert：插入唯一名字；重名抛调用方诊断错误；undo 幂等且只删本条；
  // 表被清空时换代（新 Map），使旧迭代器与后续插入脱钩。
  insert(name: string, value: V): () => void {
    const data = this.data
    if (data.has(name)) throw this.duplicateError(name)
    data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(name)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Read one named value.
   * @param name - name to resolve.
   * @returns the retained value, or `undefined` when absent.
   */
  // get：按名读取（不存在返回 undefined）。
  get(name: string): V | undefined {
    return this.data.get(name)
  }

  /**
   * Test one name for membership.
   * @param name - name to test.
   * @returns whether the table contains that name.
   */
  // has：名字存在性测试。
  has(name: string): boolean {
    return this.data.has(name)
  }

  /**
   * Iterate live names in insertion order.
   * @returns the native live key iterator.
   */
  // keys：插入序的活键迭代器。
  keys(): IterableIterator<string> {
    return this.data.keys()
  }

  /**
   * Iterate live entries in insertion order.
   * @returns the native live entry iterator.
   */
  // entries：插入序的活条目迭代器。
  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  // values：插入序的活值迭代器。
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  // isEmpty：是否为空表。
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * Insertion-ordered anonymous entries with independent registration identity.
 *
 * Equal values remain separate registrations. Values are borrowed, and
 * iterators are live within one nonempty table generation; draining the table
 * detaches them from later appends.
 */
// AnonymousEntries：插入序的匿名条目表（上游注释）：
// 相等的值仍是相互独立的注册；值为借用；迭代器在一代内有效。
export class AnonymousEntries<V> implements EntryValues<V> {
  private data = new Map<symbol, V>()

  /**
   * Append one independently owned value.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo for this exact append.
   */
  // append：追加一个独立注册（内部用一次性 symbol 作键）；undo 只删本条。
  append(value: V): () => void {
    const data = this.data
    const key = Symbol()
    data.set(key, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(key)
      // 清空换代（与 NamedEntries 相同的代际语义）。
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  // values：插入序的活值迭代器。
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  // isEmpty：是否为空表。
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * Own the global and exact-scope layers for one registry.
 *
 * Reads never create scoped layers. Registrations derive both visibility and
 * effect ownership from the supplied Cordis context, collect undo before
 * notification, and reclaim only a completely empty aggregate layer.
 */
// ScopedLayers：为一个注册表管理「全局层 + 各精确作用域层」（上游注释）：
// 读操作不创建层；注册的可见性与 effect 归属都来自传入 ctx；先收集 undo 再通知；
// 只回收完全为空的聚合层。
export class ScopedLayers<L extends ScopeLayer> {
  /** The eagerly constructed context-global layer. */
  // global：构造时就建好的全局层（scope === undefined 的注册都进这里）。
  readonly global: L

  // 精确作用域层：作用域键 → 层。
  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    // createLayer：层的工厂（由具体注册表提供层内容）。
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    // onChange：任何变更后的回调（注册表据此失效缓存/发事件）。
    private readonly onChange: () => void,
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * Read an existing exact-scope overlay. Deliberately chain-blind: callers
   * addressing one scope's OWN contributions (its restrictions, its guards)
   * must not silently pick up an ancestor's — use {@link chainLayers} where
   * inheritance is the point.
   * @param scope - exact scope key; `undefined` denotes no overlay.
   * @returns the existing scoped layer, or `undefined` without creating one.
   */
  // peek：读「精确作用域」的层。刻意不沿链向上看：查某作用域自己的限制/守卫
  // 时绝不能悄悄拿祖先的；需要继承语义请用 chainLayers。只读不建。
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * Existing overlays along the scope's parent chain ({@link scopeChainOf}),
   * farthest ancestor first and the exact scope last, so a caller layering
   * them in order gives the nearest scope the final word.
   * @param scope - viewing scope, or `undefined` for no overlays.
   * @returns the existing layers, nearest last; absent overlays are skipped.
   */
  // chainLayers：沿父链收集已存在的层——最远祖先在前、精确作用域在最后，
  // 调用方按此顺序叠加即「最近的作用域说了算」。
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * Materialize global named entries followed by scope-chain shadows,
   * farthest ancestor first, so the nearest scope's entry wins a name.
   * @param scope - viewing scope, or `undefined` for the global view.
   * @param pick - select the named table from a layer.
   * @returns an insertion-ordered effective map.
   */
  // merge：合成有效视图——先全局具名条目，再按链（远祖先在前）逐层遮蔽，
  // 最近作用域的同名条目获胜（典型的层叠覆盖语义）。
  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V> {
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * Attach one synchronous layer mutation to its registration context.
   * @param ctx - context that determines both scope visibility and effect ownership.
   * @param action - atomic mutation returning its synchronous undo.
   * @param options - Cordis effect label and optional change notification.
   * @returns the exact disposer returned by `ctx.effect()`.
   */
  // effect：把一次同步层变更挂到注册上下文（「注册即 effect」约定在此落地）：
  // - 作用域取自 ctx（scopeOf）；
  // - 全局层直用；作用域层懒创建；
  // - action 抛错时回滚刚创建的空层；
  // - 生成器 effect：undo 侧（插件卸载时）先撤销注册、回收空层、按需通知；
  //   成功侧立即通知一次。
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
      let layer: L
      let created = false
      if (scope === undefined) {
        // 无作用域：写全局层。
        layer = this.global
      } else {
        const existing = this.scoped.get(scope)
        if (existing === undefined) {
          // 该作用域第一笔注册：建层并登记。
          layer = this.createLayer(scope)
          this.scoped.set(scope, layer)
          created = true
        } else {
          layer = existing
        }
      }

      let undo: () => void
      try {
        undo = action(layer)
      } catch (error) {
        // 注册失败：若刚创建的层仍为空则回收，保持状态干净。
        if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
        throw error
      }

      yield () => {
        // 卸载路径：撤销注册 → 空层回收 → 通知。
        undo()
        if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
        if (notify) this.onChange()
      }
      if (notify) this.onChange()
    }.bind(this), options.label)
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    // 返回 ctx.effect 的原始 disposer（保持 Cordis effect 身份，便于有序组合）。
    return dispose
  }
}
