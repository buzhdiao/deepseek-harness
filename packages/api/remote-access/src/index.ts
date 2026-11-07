// 模块说明：Host 方法级访问控制。网关在分发非拥有者调用或向非拥有者 Peer
// 转发事件之前先询问 `decide()`；列表方法经 `allows()` 过滤条目；
// 每个 Peer 读取自己的访问快照——先从索引读取，再经 `follow()` 跟随。
// 业务包为每个非拥有者主体种类注册一份策略。
/**
 * Host method-level access control. The Gateway asks `decide()` before it
 * dispatches a non-owner call or forwards an event to a non-owner Peer; list
 * methods filter items through `allows()`; every Peer reads its own access
 * snapshot, first from the index and then from `follow()`. Business packages
 * register one policy per non-owner principal kind.
 * @module @deepseek-ai/dsh-api-remote-access
 */

// Cordis 的 Context（上下文）类型。
import type { Context } from '@deepseek-ai/cordis'
// 空类型导入：引入宿主 Web 服务器的模块扩充（index-inject 事件）。
import type {} from '@deepseek-ai/dsh-host-webserver'
// Typert 协议：远端装饰器、远端服务基类、主体提取与访问资源类型。
import {
  Remote,
  TypertRemoteService,
  principalOf,
  type Principal,
  type PrincipalMap,
  type RemoteAccessResource,
} from '@deepseek-ai/dsh-typert-protocol'
// 首次访问快照的全局键：索引注入时使用。
import { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'
// 本包类型：访问控制契约（动作、裁决、帧、授权、策略、请求）。
import type {
  RemoteAccessAction,
  RemoteAccessDecision,
  RemoteAccessFrame,
  RemoteAccessGrant,
  RemoteAccessPolicy,
  RemoteAccessRequest,
} from './types.ts'

// 原样转发本包类型面。
export type * from './types.ts'
// 快照全局键的对外导出。
export { REMOTE_ACCESS_SNAPSHOT_KEY } from './snapshot.ts'

// 快照世代的打开帧（baseline）。
/** The opening frame of a snapshot generation. */
export type RemoteAccessBaseline = Extract<RemoteAccessFrame, { type: 'baseline' }>

// 模块扩充：在 Cordis Context 上登记 Host 远端访问服务。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // 面向非拥有者 Peer 的 Host 方法级访问控制。
    /** Host method-level access control for non-owner Peers. */
    remoteAccess: RemoteAccessService
  }
}

// 每个 Peer 都可为自己读取的快照端点动作。
/** The snapshot endpoint every Peer may read for itself. */
const FOLLOW_ACTION: RemoteAccessAction = 'remoteAccess/follow'
// 允许裁决单例。
const ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'allow' })
// no-allow 拒绝单例：没有任何绑定允许。
const NO_ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'no-allow' })
// policy-failed 拒绝单例：策略调用抛错。
const POLICY_FAILED: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'policy-failed' })
// 拥有者主体单例。
const OWNER: Principal = Object.freeze({ kind: 'owner' })
// 拥有者基线单例：只含 owner: true。
const OWNER_BASELINE: RemoteAccessBaseline = Object.freeze({ type: 'baseline', owner: true })

// 不带资源种类（kind）信息的绑定视图。用方法语法保证各 kind 的条件都可赋值；
// 每个条件只会被传入等于其自身绑定资源的资源。
/**
 * A binding seen without its resource kind. Method syntax keeps the condition
 * of every kind assignable; each condition is called only with a resource
 * equal to its own binding's resource.
 */
interface ErasedBinding {
  // 角色只保留动作列表。
  readonly role: { readonly actions: readonly RemoteAccessAction[] }
  // 绑定的资源。
  readonly resource: RemoteAccessResource
  // 可选条件：仅对资源匹配且角色列出该动作的绑定调用。
  condition?(request: {
    // 被询问的动作。
    readonly action: RemoteAccessAction
    // 绑定的资源。
    readonly resource: RemoteAccessResource
    // 调用实参（若有）。
    readonly args?: Readonly<Record<string, unknown>>
  }): RemoteAccessDecision
}

// 一条已注册策略及其服务的主体种类。
/** One registered policy with the principal kind it serves. */
interface PolicyEntry {
  // 主体种类。
  readonly kind: string
  // 该种类的策略。
  readonly policy: RemoteAccessPolicy<Principal>
}

// 条件的拒绝结果。
/** A condition's refusal. */
type Refusal = Extract<RemoteAccessDecision, { kind: 'deny' }>

// 在 `explain()` 之前、单个动作于单个资源上的评估结果。
/** The answer for one action on one resource, before any `explain()`. */
type Evaluation =
  // 允许。
  | { readonly kind: 'allow' }
  // 拒绝：没有绑定允许；refusal 是第一个拒绝条件的裁决（若有条件运行过）。
  /** No binding allows; `refusal` is the first refusing condition's decision, if any condition ran. */
  | { readonly kind: 'refuse'; readonly refusal: Refusal | undefined }
  // 策略失败。
  | { readonly kind: 'failed' }

// 允许评估单例。
const ALLOWED: Evaluation = Object.freeze({ kind: 'allow' })
// 失败评估单例。
const FAILED: Evaluation = Object.freeze({ kind: 'failed' })

// 一条打开的非拥有者快照世代：变更先合并，直到其读取者被唤醒。
/** One open non-owner snapshot generation; changes coalesce until its reader wakes. */
class AccessFollower {
  // 脏标志：世代自上次推送后是否有变化。
  private dirty = false
  // 读取者挂起等待的唤醒回调。
  private wake: (() => void) | undefined

  // 构造：记录该世代的调用者身份（绝不是拥有者）。
  /** @param principal - the generation's caller identity; never the owner. */
  constructor(readonly principal: Principal) {}

  // 把世代标记为过期并唤醒其读取者。
  /** Mark the generation stale and wake its reader. */
  touch(): void {
    // 置位脏标志。
    this.dirty = true
    // 若读取者正在等待则唤醒。
    this.wake?.()
  }

  // 等待世代过期或被取消。
  /**
   * Wait until the generation is stale or cancelled.
   * @param signal - generation cancellation.
   * @returns true when stale; false once cancelled.
   */
  async changed(signal: AbortSignal): Promise<boolean> {
    // 中止处理器：通过唤醒回调打断等待。
    const abort = (): void => { this.wake?.() }
    // 注册一次性 abort 监听。
    signal.addEventListener('abort', abort, { once: true })
    try {
      // 未过期且未取消时挂起等待 touch 唤醒。
      while (!this.dirty && !signal.aborted) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        // 唤醒后清空登记，避免悬挂引用。
        this.wake = undefined
      }
    } finally {
      // 无论哪条路径退出都移除监听。
      signal.removeEventListener('abort', abort)
    }
    // 消费脏标志。
    this.dirty = false
    // 返回是否因过期（而非取消）而唤醒。
    return !signal.aborted
  }
}

// 访问策略注册表、网关的访问裁决、列表过滤与按 Peer 的访问快照。
// 每个挂载网关的组合都会挂载本服务。
/**
 * Registry of access policies, the Gateway's access decisions, list
 * filtering, and the per-Peer access snapshot. Every composition that mounts
 * the Gateway mounts this service too.
 */
export class RemoteAccessService extends TypertRemoteService {
  // 已注册的策略：按主体种类键。
  private readonly policies = new Map<string, PolicyEntry>()
  // 自上次 invalidate() 以来已记录过失败的策略；其后续失败保持沉默。
  /** Policies whose failure was logged since the last `invalidate()`; their later failures stay silent. */
  private readonly reported = new Set<PolicyEntry>()
  // 当前打开的快照世代集合。
  private readonly followers = new Set<AccessFollower>()
  // 本实例卸载时中止；所有打开的快照世代随之结束。
  /** Aborted when this instance unloads; every open snapshot generation ends with it. */
  private readonly lifetime = new AbortController()

  // 构造服务并接线索引注入。
  /** @param ctx - owning Host plugin Context. */
  constructor(ctx: Context) {
    // 调用远端服务基类：服务名 remoteAccess。
    super(ctx, 'remoteAccess')
    // 注册卸载效果：服务卸载时中止生命周期信号，结束全部快照世代。
    ctx.effect(() => () => { this.lifetime.abort() }, 'remoteAccess: snapshot generations')
    // Every index opens with the access snapshot of the Peer it speaks for.
    // 每个索引页都以它所代表的 Peer 的访问快照开场。
    ctx.inject(['webServer'], (webCtx) => {
      // 订阅 index-inject：向页面全局表注入打开基线。
      webCtx.on('webserver/index-inject', (table, peer) => {
        // 注入快照键及其对应 Peer 主体的基线。
        table.push({ kind: 'global', name: REMOTE_ACCESS_SNAPSHOT_KEY, value: this.snapshotFor(peer.principal) })
      })
    })
  }

  // 在调用者纤程内注册某非拥有者主体种类的策略；注册与移除时重算打开的快照。
  /**
   * Register the policy of one non-owner principal kind in the caller's
   * fiber; open snapshots are recomputed on registration and removal.
   * @param kind - the principal kind the policy serves; never `owner`.
   * @param policy - business-owned bindings and refusal reasons for principals of `kind`.
   * @returns disposer removing this policy.
   * @throws Error when `kind` already has a policy.
   */
  registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void {
    // 取策略表。
    const policies = this.policies
    // 同一种类重复注册：报错。
    if (policies.has(kind)) throw new Error(`remote access: principal kind ${JSON.stringify(kind)} already has a policy`)
    // 组装策略条目。
    const entry: PolicyEntry = { kind, policy }
    // 注册为纤程效果：装载时登记策略并失效快照；卸载时移除并再次失效。
    const dispose = this.ctx.effect(() => {
      policies.set(kind, entry)
      this.invalidate()
      return () => {
        policies.delete(kind)
        this.invalidate()
      }
    }, `remoteAccess.registerPolicy(${JSON.stringify(kind)})`)
    // 返回幂等的注销函数。
    return () => { void dispose() }
  }

  // 上报某主体的绑定或条件答案可能已变化。业务包在每次授予、撤销、
  // 模式变化与过期时调用；打开的快照会重新推送，且每个策略的下一次失败会再次记日志。
  /**
   * Report that the bindings or condition answers for `principal` may have
   * changed. Business packages call this on every grant, revocation, mode
   * change, and expiry; open snapshots re-push, and the next failure of each
   * policy is logged again.
   * @param principal - affected principal; omitted for every principal.
   */
  invalidate(principal?: Principal): void {
    // 重置失败日志静默集。
    this.reported.clear()
    // 计算目标主体的规范化键；缺省表示全部主体。
    const key = principal === undefined ? undefined : canonicalJson(principal)
    // 遍历打开的世代：只唤醒匹配主体的世代。
    for (const follower of this.followers) {
      if (key === undefined || canonicalJson(follower.principal) === key) follower.touch()
    }
  }

  // 网关专用裁决入口：详见下方 JSDoc 的拒绝理由与失败语义说明。
  // 仅供网关调用：裁决一个资源已被网关解析的请求。拥有者被允许，
  // `remoteAccess/follow` 亦然：每个 Peer 都要能读自己的快照。其余动作只有在
  // 每个列出的资源上、主体策略的某个绑定指名该资源、其角色列出该动作、
  // 且无条件或条件允许时才被允许。`bindings()` 每次裁决只调用一次。
  /**
   * Gateway-only: decide one request whose resources the Gateway resolved.
   * The owner is allowed, and so is `remoteAccess/follow`: every Peer reads
   * its own snapshot. Otherwise the action is allowed only when, on every
   * listed resource, some binding of the principal's policy names that
   * resource, has a role listing the action, and has no condition or a
   * condition that allows. `bindings()` is called once per decision.
   * @param request - the caller or recipient, the action, the resources it
   *   touches, and a call's arguments.
   * @returns `allow`; or `deny` with `no-allow` when the principal kind has
   *   no policy, the first refusing condition's reason on the first resource
   *   no binding allows, else `explain()`'s reason, else `no-allow`;
   *   `policy-failed` when `bindings()`, a condition, or `explain()` throws,
   *   logged once per policy until the next `invalidate()`. The Gateway
   *   throws `remote-access/denied` for a denied call and drops a denied event.
   */
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    // 取出主体与动作。
    const { principal, action } = request
    // 拥有者或快照端点：直接允许。
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner' || action === FOLLOW_ACTION) return ALLOW
    // 查找该主体种类的策略。
    const entry = this.policies.get(principal.kind)
    // 无策略：一律 no-allow 拒绝。
    if (entry === undefined) return NO_ALLOW
    // 取绑定列表（失败则返回策略失败）。
    const bindings = this.bindingsOf(entry, principal, action)
    if (bindings === undefined) return POLICY_FAILED
    // 逐个资源评估：全部资源都允许才整体允许。
    for (const resource of request.resources) {
      // 评估该动作在该资源上的结果。
      const evaluation = this.evaluate(entry, bindings, action, resource, request.args)
      switch (evaluation.kind) {
        // 该资源允许：继续检查下一资源。
        case 'allow':
          continue
        // 策略失败：整体返回策略失败。
        case 'failed':
          return POLICY_FAILED
        // 该资源被拒绝：优先返回首个拒绝条件的理由，否则走 explain()。
        case 'refuse':
          return evaluation.refusal ?? this.explain(entry, request)
        // 封闭联合的兜底。
        /* v8 ignore next -- closed union. */
        default:
          return assertNever(evaluation)
      }
    }
    // 所有资源均允许：放行。
    return ALLOW
  }

  // 在远端方法内部过滤结果项。调用从访问本服务的 Context 读取调用信息，
  // 因此应写作 `this.ctx.remoteAccess.allows(resource)`。每次检查都会重新
  // 读取策略绑定，因此长时间运行的流从下一次检查起就能看到绑定变化。
  /**
   * Filter items inside a Remote method. The invocation is read from the
   * Context that accessed this service, so call it as
   * `this.ctx.remoteAccess.allows(resource)` from the Remote method. Each
   * check reads the policy's bindings again, so a long-running stream sees
   * binding changes from the next check on.
   * @param resource - resource of one result item.
   * @returns true for the owner and outside a Remote call; otherwise whether
   *   the invocation's endpoint action is allowed on `resource` without call
   *   arguments, false when the policy is absent or fails.
   */
  allows(resource: RemoteAccessResource): boolean {
    // 取当前调用信息。
    const invocation = this.ctx.invocation
    // 提取调用主体。
    const principal = principalOf(invocation)
    // 不在远端调用内或无主体（拥有者）：不过滤。
    if (invocation === undefined || principal === undefined) return true
    // 由调用信息拼出规范的端点动作。
    const action: RemoteAccessAction = `${invocation.request.namespace}/${invocation.request.method}`
    // 查找该主体种类的策略。
    const entry = this.policies.get(principal.kind)
    // 无策略：一律过滤掉。
    if (entry === undefined) return false
    // 取绑定列表。
    const bindings = this.bindingsOf(entry, principal, action)
    // 绑定可用且该资源上（不带实参）动作被允许时才保留该项。
    return bindings !== undefined && this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow'
  }

  // 计算页面在其快照流连接前打开时的基线；webServer 渲染的每个索引都以
  // {@link REMOTE_ACCESS_SNAPSHOT_KEY} 携带它（针对页面所代表的 Peer）。
  /**
   * The baseline a page opens with before its snapshot stream connects; every
   * index the webServer renders carries it under
   * {@link REMOTE_ACCESS_SNAPSHOT_KEY} for the Peer the page speaks for.
   * @param principal - the page's caller identity.
   * @returns the owner baseline for the owner; otherwise the principal's current grants.
   */
  snapshotFor(principal: Principal): RemoteAccessBaseline {
    // 拥有者：返回拥有者基线。
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (principal.kind === 'owner') return OWNER_BASELINE
    // 非拥有者：返回其当前授权快照。
    return { type: 'baseline', owner: false, grants: this.grantsFor(principal) }
  }

  // 流式输出调用方 Peer 的访问快照：一条基线，之后每逢 invalidate() 或
  // 改变授权的策略注册/移除，输出 upsert 与 remove 帧。拥有者只会收到
  // `{ owner: true }`。信号中止或服务卸载时世代结束，因此重载后的服务
  // 会让每个读取者从新基线重新开始。
  /**
   * Stream the calling Peer's access snapshot: one baseline, then `upsert`
   * and `remove` frames after each `invalidate()` and each policy
   * registration or removal that changes a grant. The owner receives only
   * `{ owner: true }`. The generation ends when `signal` aborts or this
   * service unloads, so a reloaded service starts every reader from a fresh
   * baseline.
   * @param signal - generation cancellation.
   * @returns the access frames of one generation.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<RemoteAccessFrame> {
    // 进入前检查取消：已中止则抛出。
    signal.throwIfAborted()
    // 世代信号：请求取消或服务卸载任一发生即结束。
    const generation = AbortSignal.any([signal, this.lifetime.signal])
    // 提取调用主体。
    const principal = principalOf(this.ctx.invocation)
    // 无主体（例如服务内部读取）：按拥有者输出基线并挂起直到世代结束。
    if (principal === undefined) {
      yield this.snapshotFor(OWNER)
      await abortion(generation)
      return
    }
    // 创建该主体的快照世代并登记。
    const follower = new AccessFollower(principal)
    this.followers.add(follower)
    try {
      // 首次计算授权并发送基线。
      let sent = this.grantsFor(principal)
      yield { type: 'baseline', owner: false, grants: sent }
      // 主循环：每逢世代过期重算授权并产出差量帧。
      while (await follower.changed(generation)) {
        // 重算当前授权。
        const next = this.grantsFor(principal)
        // 记住上一份授权用于对比。
        const previous = sent
        sent = next
        // 新增或变化：产出 upsert 帧。
        for (const grant of next) {
          const before = previous.find(other => sameResource(other.resource, grant.resource))
          if (before === undefined || !sameActions(before.actions, grant.actions)) yield { type: 'upsert', grant }
        }
        // 消失的资源：产出 remove 帧。
        for (const grant of previous) {
          if (!next.some(other => sameResource(other.resource, grant.resource))) yield { type: 'remove', resource: grant.resource }
        }
      }
    } finally {
      // 收尾：从世代集合中注销本世代。
      this.followers.delete(follower)
    }
  }

  // 调用一次 `bindings()`；失败（已记日志）后返回 undefined。
  /** One `bindings()` call; `undefined` after a logged failure. */
  private bindingsOf(entry: PolicyEntry, principal: Principal, purpose: string): readonly ErasedBinding[] | undefined {
    try {
      // 调用策略的绑定列表。
      return entry.policy.bindings(principal)
    } catch (error) {
      // A policy failure is contained to this question, so one faulty rule cannot break a shared event stream.
      // 策略失败被隔离在本次提问之内，一条坏规则无法打断共享的事件流。
      this.report(entry, `list bindings for ${purpose}`, error)
      // 失败：返回 undefined。
      return undefined
    }
  }

  // 找到资源匹配、角色列出该动作、且（若有）条件允许的绑定。
  /** Find a binding on `resource` whose role lists `action` and whose condition, if any, allows. */
  private evaluate(
    entry: PolicyEntry,
    bindings: readonly ErasedBinding[],
    action: RemoteAccessAction,
    resource: RemoteAccessResource,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Evaluation {
    // 记录第一个拒绝条件的裁决。
    let refusal: Refusal | undefined
    // 逐个绑定检查。
    for (const binding of bindings) {
      // 资源不匹配或角色未列出该动作：跳过。
      if (!sameResource(binding.resource, resource) || !binding.role.actions.includes(action)) continue
      // 无条件绑定：直接允许。
      if (binding.condition === undefined) return ALLOWED
      // 调用条件（按需附带实参）。
      let decision: RemoteAccessDecision
      try {
        decision = binding.condition(args === undefined ? { action, resource } : { action, resource, args })
      } catch (error) {
        // 条件抛错：记录并按策略失败处理。
        this.report(entry, `evaluate a condition for ${action}`, error)
        return FAILED
      }
      // 条件允许：放行。
      if (decision.kind === 'allow') return ALLOWED
      // 条件拒绝：记下第一个拒绝理由。
      refusal ??= decision
    }
    // 没有绑定允许：返回拒绝（可携带首个条件的理由）。
    return { kind: 'refuse', refusal }
  }

  // 取 `explain()` 给出的拒绝理由；缺省时 no-allow；抛错时 policy-failed。
  /** The refusal reason `explain()` names, else `no-allow`; `policy-failed` when it throws. */
  private explain(entry: PolicyEntry, request: RemoteAccessRequest<Principal>): RemoteAccessDecision {
    // 理由占位。
    let reason: string | undefined
    try {
      // 调用可选的 explain 钩子。
      reason = entry.policy.explain?.(request)
    } catch (error) {
      // explain 抛错：记录并按策略失败处理。
      this.report(entry, `explain a refusal of ${request.action}`, error)
      return POLICY_FAILED
    }
    // 未给出理由：no-allow；否则以该理由拒绝。
    return reason === undefined ? NO_ALLOW : { kind: 'deny', reason }
  }

  // 按首个绑定的顺序、每个被绑定资源一条授权：`decide()` 在该资源上
  // 不带实参就会允许的端点动作。没有这类动作的资源不产生授权；
  // 事件动作不进入快照。
  /**
   * One grant per bound resource, in first-binding order: the endpoint
   * actions of the resource's bindings that `decide()` would allow there
   * without call arguments. A resource with no such action gets no grant;
   * event actions stay out of the snapshot.
   */
  private grantsFor(principal: Principal): readonly RemoteAccessGrant[] {
    // 查找该主体种类的策略。
    const entry = this.policies.get(principal.kind)
    // 无策略：空授权。
    if (entry === undefined) return []
    // 取绑定列表。
    const bindings = this.bindingsOf(entry, principal, 'a snapshot')
    // 取绑定失败：空授权。
    if (bindings === undefined) return []
    // 结果授权列表。
    const grants: RemoteAccessGrant[] = []
    // 已见资源去重表。
    const seen: RemoteAccessResource[] = []
    // 按首个绑定顺序遍历各绑定资源。
    for (const { resource } of bindings) {
      // 已处理过的资源：跳过。
      if (seen.some(other => sameResource(other, resource))) continue
      seen.push(resource)
      // 收集该资源上所有绑定角色的候选动作。
      const candidates = new Set<RemoteAccessAction>()
      for (const binding of bindings) {
        // 只看该资源的绑定。
        if (!sameResource(binding.resource, resource)) continue
        for (const action of binding.role.actions) {
          // 事件动作不进入快照。
          if (!action.startsWith('event:')) candidates.add(action)
        }
      }
      // 过滤出真正会被 evaluate 允许的动作并排序。
      const actions = [...candidates].filter(action => this.evaluate(entry, bindings, action, resource, undefined).kind === 'allow').sort()
      // 有可允许动作才产出一条冻结授权。
      if (actions.length > 0) grants.push(Object.freeze({ resource, actions: Object.freeze(actions) }))
    }
    // 返回授权快照。
    return grants
  }

  // 每个策略在两次 invalidate() 之间只记录一次失败日志；快照与列表会在
  // 一次变化内多次询问。
  /** Log a policy failure once per policy until the next `invalidate()`; snapshots and lists ask many times per change. */
  private report(entry: PolicyEntry, action: string, error: unknown): void {
    // 已记录过：保持沉默。
    if (this.reported.has(entry)) return
    // 登记本策略已记录。
    this.reported.add(entry)
    // 记录策略失败摘要。
    this.ctx.logger.warn(
      `remote access: the ${JSON.stringify(entry.kind)} policy failed to ${action}; its further failures are not logged until access state changes`)
    // 记录错误本体。
    this.ctx.logger.warn(error)
  }
}

// 封闭联合的兜底：理论上不可达，到达即抛错。
/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`remote access: unreachable value ${JSON.stringify(value)}`)
}

// 与键顺序无关的 JSON 文本，用于唯一标识一个主体。
/** Key-order-independent JSON text identifying one principal. */
function canonicalJson(value: unknown): string {
  // 数组：逐元素规范化后拼接。
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  // 普通对象：按键排序后逐项规范化，保证键序无关。
  if (typeof value === 'object' && value !== null) {
    // Own keys are unique, so no two entries compare equal.
    // 自有键唯一，因此不存在相等的两项。
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  // 基本类型：直接 JSON 序列化。
  return JSON.stringify(value)
}

// 资源相等当且仅当 kind 与 id 都相等；`global` 没有 id。
/** Resources are equal when their kinds and ids are; `global` carries no id. */
function sameResource(
  left: { readonly kind: string; readonly id?: unknown },
  right: { readonly kind: string; readonly id?: unknown },
): boolean {
  return left.kind === right.kind && left.id === right.id
}

// 动作列表相等：长度一致且逐项相同。
function sameActions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((action, index) => action === right[index])
}

// 等待信号中止；已中止则立即返回。
function abortion(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // 已中止：立即兑现。
    if (signal.aborted) resolve()
    // 注册一次性 abort 监听兑现。
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

// 默认导出：RemoteAccessService 服务类。
export default RemoteAccessService
