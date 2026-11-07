// 模块说明：不依赖 React 的 Client 访问状态——最新的 `remoteAccess/follow` 快照，
// 以及按资源与动作缓存的引用稳定布尔源。
/**
 * React-free Client access state: the latest `remoteAccess/follow` snapshot
 * and identity-stable boolean sources per resource and action.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/state
 */

// HostObservable（Host 可观察对象）：Client 侧布尔源要满足的槽位接口。
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// 本包类型：快照帧、授权（grant）与访问资源形状。
import type { RemoteAccessFrame, RemoteAccessGrant, RemoteAccessResource } from '../types.ts'

// 每个已声明资源类型（kind）下、按资源身份允许的动作集合。
/** Actions allowed per resource identity, for one declared resource kind. */
type KindGrants = ReadonlyMap<string, ReadonlySet<string>>

// 访问快照（AccessSnapshot）的三种形态。
type AccessSnapshot =
  // 关闭：没有基线，或非拥有者快照流已失败——所有答案都是假。
  /** No baseline, or a non-owner snapshot stream failed: every answer is false. */
  | { readonly kind: 'closed' }
  // 拥有者：全部答案为真。
  | { readonly kind: 'owner' }
  // 已授权：按全局资源与各资源类型/身份记录允许的动作集合。
  | {
    // 判别字段：granted。
    readonly kind: 'granted'
    // 全局资源上允许的动作集合。
    readonly global: ReadonlySet<string>
    // 各资源类型下、按身份到授权动作集合的映射。
    readonly resources: ReadonlyMap<string, KindGrants>
  }

// 已授权快照的窄化别名：仅取 kind === 'granted' 的成员。
type GrantedSnapshot = Extract<AccessSnapshot, { kind: 'granted' }>

// 关闭快照单例：冻结以保持引用稳定。
const CLOSED: AccessSnapshot = Object.freeze({ kind: 'closed' })
// 拥有者快照单例：冻结以保持引用稳定。
const OWNER_SNAPSHOT: AccessSnapshot = Object.freeze({ kind: 'owner' })
// 全局资源在资源映射中的内部键：以 NUL 前缀避免与真实 kind 撞名。
const GLOBAL_KEY = '\u0000global'

// 快照世代的打开帧（baseline）。
/** The opening frame of a snapshot generation. */
export type Baseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

/**
 * Validate the opening baseline an index injection row assigned to the page.
 * @param value - the injected global; `undefined` when the page carries none.
 * @returns the baseline, or `undefined` when none was injected.
 * @throws TypeError when the injected value is not a baseline frame.
 */
export function parseInjectedBaseline(value: unknown): Baseline | undefined {
  // 未注入快照：页面没有基线，返回 undefined。
  if (value === undefined) return undefined
  // 不是对象或类型字段不是 baseline：注入值不是基线帧，直接报错。
  if (!isRecord(value) || value['type'] !== 'baseline') throw new TypeError('remote access: the injected access snapshot is not a baseline frame')
  // 拥有者基线：原样构造 owner: true 的帧。
  if (value['owner'] === true) return { type: 'baseline', owner: true }
  // 取出授权数组做校验。
  const grants = value['grants']
  // 非拥有者基线必须携带合法的授权列表，否则报错。
  if (value['owner'] !== false || !Array.isArray(grants) || !grants.every(isGrant)) {
    throw new TypeError('remote access: the injected access snapshot carries malformed grants')
  }
  // 校验通过：返回非拥有者基线帧。
  return { type: 'baseline', owner: false, grants }
}

// 校验单个授权项：resource 合法且 actions 全为字符串。
function isGrant(value: unknown): value is RemoteAccessGrant {
  // 必须是记录且其 resource 字段是合法资源。
  if (!isRecord(value) || !isResource(value['resource'])) return false
  // 取出 actions 字段。
  const actions = value['actions']
  // actions 必须是字符串数组。
  return Array.isArray(actions) && actions.every(action => typeof action === 'string')
}

// 校验单个资源：必须带字符串 kind；非 global 资源还必须带字符串 id。
function isResource(value: unknown): value is RemoteAccessResource {
  // 必须是记录且 kind 为字符串。
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false
  // global 资源没有 id；其余资源必须有 id。
  return value['kind'] === 'global' || typeof value['id'] === 'string'
}

// 判断值是否为普通对象（非数组、非 null）。
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 单个 Client 世代的快照拥有者。每个 `(kind, id, action)` 组合的源（source）都会被缓存，
// 以保证 Hook 绑定的引用稳定；每个源都从当前快照计算其布尔值。
/**
 * Snapshot owner for one Client generation. Sources are cached per
 * `(kind, id, action)` so Hook bindings keep their identity; each source
 * computes its boolean from the current snapshot.
 */
export class ClientAccessState {
  // 当前访问快照，初始为关闭态。
  private snapshot: AccessSnapshot = CLOSED

  // 构造时可注入页面的打开基线；没有基线时所有答案保持为假，直到基线到达。
  /** @param initial - the page's injected opening baseline; without one every answer is false until a baseline arrives. */
  constructor(initial?: Baseline) {
    // 有注入基线则立即用它替换初始关闭态。
    if (initial !== undefined) this.replace(initial)
  }
  // 快照订阅者集合：源变化时逐个通知。
  private readonly listeners = new Set<() => void>()
  // 源缓存：按 `(kind,id,action)` 组合键缓存布尔源，保证引用稳定。
  private readonly sources = new Map<string, HostObservable<boolean>>()

  // 全局资源上某个动作的答案：以内部全局键查询缓存源。
  /**
   * Answer for one action on the global resource.
   * @param action - endpoint action the caller may invoke.
   * @returns identity-stable boolean source.
   */
  global(action: string): HostObservable<boolean> {
    return this.cached(GLOBAL_KEY, '', action)
  }

  // 某个已声明资源类型下、指定身份资源上某动作的答案。
  /**
   * Answer for one action on one resource of a declared kind.
   * @param kind - declared resource kind.
   * @param id - resource identity.
   * @param action - endpoint action the caller may invoke.
   * @returns identity-stable boolean source.
   */
  resource(kind: string, id: string, action: string): HostObservable<boolean> {
    return this.cached(kind, id, action)
  }

  // 用某个世代的打开帧替换整个快照。
  /**
   * Replace the snapshot from one generation's opening frame.
   * @param frame - owner or non-owner baseline.
   */
  replace(frame: Baseline): void {
    // 拥有者基线：发布拥有者快照。
    if (frame.owner) {
      this.publish(OWNER_SNAPSHOT)
      return
    }
    // 全局动作集合，默认为空。
    let global: ReadonlySet<string> = new Set()
    // 各资源类型到（资源身份到动作集合）的映射。
    const resources = new Map<string, Map<string, ReadonlySet<string>>>()
    // The baseline is unpublished, so its maps are filled in place.
    // 基线尚未发布，因此可以直接就地填充这些映射。
    for (const { resource, actions } of frame.grants) {
      // 全局授权：填入全局集合后继续。
      if (resource.kind === 'global') {
        global = new Set(actions)
        continue
      }
      // 取该资源类型下的授权映射，缺失则先建。
      let grants = resources.get(resource.kind)
      if (grants === undefined) {
        grants = new Map()
        resources.set(resource.kind, grants)
      }
      // 记录该资源身份允许的动作集合。
      grants.set(resource.id, new Set(actions))
    }
    // 发布已授权快照。
    this.publish({ kind: 'granted', global, resources })
  }

  // 应用当前世代的一帧增量更新（upsert 或 remove）。
  /**
   * Apply one increment of the current generation.
   * @param frame - `upsert` or `remove`.
   */
  update(frame: Exclude<RemoteAccessFrame, { type: 'baseline' }>): void {
    // 取当前快照。
    const current = this.snapshot
    // 基线未建立（关闭/拥有者态）时不消费增量。
    if (current.kind !== 'granted') return
    // 按帧类型处理。
    switch (frame.type) {
      // upsert：写入（或覆盖）一条授权。
      case 'upsert':
        this.publish(withGrant(current, frame.grant))
        return
      // remove：以空动作集合应用该资源授权，等效于删除。
      case 'remove':
        this.publish(withGrant(current, { resource: frame.resource, actions: [] }, true))
        return
      // 封闭联合的兜底：编解码器已保证不会到达。
      /* v8 ignore next -- the generated Remote codec validates this closed union. */
      default:
        return assertNever(frame)
    }
  }

  // 当前快照是否为拥有者：拥有者的答案从不依赖快照流。
  /** Whether the current snapshot is the owner's, whose answers never depend on the stream. */
  get owner(): boolean {
    return this.snapshot.kind === 'owner'
  }

  // 流已终态失败：拥有者保留全部答案；非拥有者的答案全部变假。
  /** The stream failed terminally: the owner keeps every answer; a non-owner's answers become false. */
  unavailable(): void {
    // 非拥有者：发布关闭快照。
    if (this.snapshot.kind !== 'owner') this.publish(CLOSED)
  }

  // 取（或创建）`(kind,id,action)` 对应的缓存布尔源。
  private cached(kind: string, id: string, action: string): HostObservable<boolean> {
    // 组合键：kind、id、action 以 NUL 分隔，避免歧义。
    const key = `${kind}\u0000${id}\u0000${action}`
    // 查缓存。
    let source = this.sources.get(key)
    // 缓存未命中：创建一个新源并登记。
    if (source === undefined) {
      source = {
        // 快照读取：从当前快照计算该组合的布尔答案。
        getSnapshot: () => answer(this.snapshot, kind, id, action),
        // 订阅：把监听器加入全局集合，返回取消订阅的清理函数。
        subscribe: (listener) => {
          this.listeners.add(listener)
          return () => { this.listeners.delete(listener) }
        },
      }
      // 登记到缓存，后续调用复用同一引用。
      this.sources.set(key, source)
    }
    // 返回缓存源（引用稳定）。
    return source
  }

  // 发布新快照：替换当前值并通知所有监听器。
  private publish(next: AccessSnapshot): void {
    // 替换快照。
    this.snapshot = next
    // 复制监听器集合后逐个通知，避免通知过程中增删导致的迭代问题。
    for (const listener of [...this.listeners]) listener()
  }
}

// 核心答案函数：给定快照与 (kind,id,action) 组合，计算布尔结果。
function answer(snapshot: AccessSnapshot, kind: string, id: string, action: string): boolean {
  // 按快照形态分派。
  switch (snapshot.kind) {
    // 关闭态：没有依据，全部为假。
    case 'closed':
      return false
    // 拥有者：全部为真。
    case 'owner':
      return true
    // 已授权：查全局或对应资源类型的授权集合。
    case 'granted': {
      // 全局键查全局集合，否则查对应类型与身份的集合。
      const allowed = kind === GLOBAL_KEY ? snapshot.global : snapshot.resources.get(kind)?.get(id)
      // 集合包含该动作才为真；缺失一律为假。
      return allowed?.has(action) ?? false
    }
    // 封闭联合的兜底分支。
    /* v8 ignore next -- closed union. */
    default:
      return assertNever(snapshot)
  }
}

// 不可变地应用一条授权变更：返回新的已授权快照。
function withGrant(snapshot: GrantedSnapshot, grant: RemoteAccessGrant, remove = false): GrantedSnapshot {
  // 取授权目标资源。
  const resource = grant.resource
  // 全局资源：直接替换全局动作集合。
  if (resource.kind === 'global') return { ...snapshot, global: new Set(grant.actions) }
  // 复制资源映射（浅拷贝外层，保持其余类型不变）。
  const resources = new Map(snapshot.resources)
  // 复制该资源类型的授权映射。
  const grants = new Map(resources.get(resource.kind))
  // remove：删除该资源身份的授权；否则写入新的动作集合。
  if (remove) grants.delete(resource.id)
  else grants.set(resource.id, new Set(grant.actions))
  // 回写该资源类型的授权映射。
  resources.set(resource.kind, grants)
  // 返回携带新映射的快照。
  return { ...snapshot, resources }
}

// 封闭联合的兜底：理论上不可达，到达即抛错。
/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`unreachable access frame: ${JSON.stringify(value)}`)
}
