// 模块说明：方法级访问控制契约——动作（actions）、角色（roles）、绑定（bindings）、
// 策略（policies）、裁决请求与访问快照流。
/**
 * Method-level access control contracts: actions, roles, bindings, policies,
 * decision requests, and the access snapshot stream.
 * @module @deepseek-ai/dsh-api-remote-access/types
 */

// 引入 Typert 协议的访问控制基础类型：主体（Principal）、访问资源及其类型/资源映射工具类型。
import type {
  Principal,
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
} from '@deepseek-ai/dsh-typert-protocol'

// 原样转发协议包的资源类型面，供业务包与本包统一引用。
export type {
  RemoteAccessResource,
  RemoteAccessResourceKind,
  RemoteAccessResourceOf,
  TypertResourceKind,
  TypertResourceMap,
} from '@deepseek-ai/dsh-typert-protocol'

// 规范的 `<namespace>/<method>` 远端端点；两个分段都不含 `:`。
/** Canonical `<namespace>/<method>` Remote endpoint; its segments never contain `:`. */
export type RemoteAccessEndpoint = `${string}/${string}`

// 访问动作：一个远端端点，或一条转发事件的 `event:<name>`。
/** A Remote endpoint, or `event:<name>` for one forwarded event. */
export type RemoteAccessAction = RemoteAccessEndpoint | `event:${string}`

// 角色（role）：在某类资源上的命名动作集合；是业务包拥有的普通值。
/** A named action set over one resource kind; a plain value the business package owns. */
export interface RemoteAccessRole<K extends RemoteAccessResourceKind> {
  // 名称仅用于诊断；决策只读取 `resource` 与 `actions`。
  /** Name for diagnostics; decisions read only `resource` and `actions`. */
  readonly name: string
  // 该角色的每个绑定都指向的资源类型。
  /** The resource kind every binding of this role names. */
  readonly resource: K
  // 角色在其绑定资源上允许的动作列表。
  /** Actions the role allows on its binding's resource. */
  readonly actions: readonly RemoteAccessAction[]
}

// `decide()` 与条件（condition）的裁决结果。
/** Answer of `decide()` and of a condition. */
export type RemoteAccessDecision =
  // 允许。
  | { readonly kind: 'allow' }
  // 拒绝，并携带拒绝理由。
  | { readonly kind: 'deny'; readonly reason: string }

// 细化某个绑定在其资源上某动作的裁决。同步调用，仅当绑定的资源匹配且其角色
// 列出该动作时才会被询问。
/**
 * Refines one binding for one action on its resource. Called synchronously,
 * only for a binding whose resource matches and whose role lists the action.
 * @param request - the action, the binding's resource, and the named
 *   arguments of a concrete call, validated against their Typert-compiled
 *   types with lookup parameters as wire identities; `args` is absent for
 *   events, snapshots, and list filtering, where the condition answers for
 *   the action alone.
 * @returns allow, or deny with the reason a refused call reports.
 */
export type RemoteAccessCondition<K extends RemoteAccessResourceKind> = (request: {
  // 被询问的动作。
  readonly action: RemoteAccessAction
  // 绑定的资源。
  readonly resource: RemoteAccessResourceOf<K>
  // 具体调用的命名实参，按其 Typert 编译类型校验、以 lookup 参数作为线上身份；
  // 事件、快照与列表过滤没有 `args`，此时条件仅针对动作本身作答。
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

// 绑定（binding）：角色在其类型某个资源上的一次绑定；资源类型由角色推导。
/** One role on one resource of the role's kind; the resource type follows from the role. */
export type RemoteAccessBinding = {
  [K in RemoteAccessResourceKind]: {
    // 绑定采用的角色。
    readonly role: RemoteAccessRole<K>
    // 绑定指向的资源。
    readonly resource: RemoteAccessResourceOf<K>
    // 没有条件时，绑定允许其角色列出的全部动作。
    /** Without a condition, the binding allows every action its role lists. */
    readonly condition?: RemoteAccessCondition<K>
  }
}[RemoteAccessResourceKind]

// 一次访问提问：`principal` 可否在 `resources` 上执行 `action`。
/** One access question: may `principal` take `action` on `resources`. */
export interface RemoteAccessRequest<P extends Principal> {
  // 提问的主体。
  readonly principal: P
  // 被询问的动作。
  readonly action: RemoteAccessAction
  // 该动作触及的全部资源；未指明时仅为全局资源，只有动作在所有列出的资源上
  // 都被允许时整体才被允许。
  /**
   * Every resource the action touches, the global resource alone when it
   * names none; allowed only when the action is allowed on every listed resource.
   */
  readonly resources: readonly RemoteAccessResource[]
  // 具体调用的命名实参，按其 Typert 编译类型校验、以 lookup 参数作为线上身份；
  // 事件、快照与列表过滤时缺省。
  /**
   * Named arguments of a concrete call, validated against their Typert-compiled types
   * with lookup parameters as wire identities; absent for events, snapshots, and list filtering.
   */
  readonly args?: Readonly<Record<string, unknown>>
}

// 某类非拥有者主体的业务规则。每个成员都从业务包内存中的状态同步作答。
/**
 * Business rules for one non-owner principal kind. Every member answers
 * synchronously from state the business package holds in memory.
 */
export interface RemoteAccessPolicy<P extends Principal> {
  // 列出主体的绑定。每次 `decide()`、`allows()` 与快照计算各调用一次；从不缓存。
  /**
   * List the principal's bindings. Called once per `decide()`, once per
   * `allows()`, and once per snapshot computation; never cached.
   * @param principal - non-owner caller of this policy's kind.
   * @returns every binding the principal holds now.
   */
  bindings(principal: P): readonly RemoteAccessBinding[]
  // 为没有任何绑定允许的请求给出理由；只在裁决已是拒绝之后调用，因此不会改变裁决。
  /**
   * Name the reason for a request no binding allows; called only after the
   * decision is already a deny, so it never changes the decision.
   * @param request - the refused request.
   * @returns the reason a refused call reports, or `undefined` for `no-allow`.
   */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

// 被拒绝的非拥有者调用的详情。
/** Details of a refused non-owner call. */
export interface RemoteAccessDeniedDetails {
  // 被拒绝调用的规范 `<namespace>/<method>` 端点。
  /** Canonical `<namespace>/<method>` endpoint of the refused call. */
  readonly action: string
  /**
   * A condition's or `explain()`'s reason, `no-allow`, or `policy-failed`;
   * the Gateway refuses a call whose resources are invalid with
   * `resource-invalid` before `decide()` is asked.
   */
  readonly reason: string
}

// 模块扩充：登记 remote-access 拒绝错误的详情类型。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    // 拒绝详情形状：RemoteAccessDeniedDetails。
    'remote-access/denied': RemoteAccessDeniedDetails
  }
}

// 一个主体可在一个资源上调用的端点动作集合。
/** The endpoint actions one principal may call on one resource. */
export interface RemoteAccessGrant {
  // 授权的目标资源。
  readonly resource: RemoteAccessResource
  // 在该资源上允许的端点动作，无需调用实参、已排序；因为 Typert 不为模板字面量
  // 类型生成编解码器，所以这里是普通字符串。
  /**
   * Endpoint actions allowed on this resource without call arguments, sorted;
   * plain strings because Typert generates no codec for template literal types.
   */
  readonly actions: readonly string[]
}

// `remoteAccess/follow` 的一帧。世代以一帧 baseline 打开；
// 拥有者基线是其世代中唯一的一帧。
/**
 * One frame of `remoteAccess/follow`. A generation opens with one baseline;
 * an owner baseline is the only frame of its generation.
 */
export type RemoteAccessFrame =
  // 拥有者基线：调用方即拥有者，不需要授权列表。
  | { readonly type: 'baseline'; readonly owner: true }
  // 非拥有者基线：携带该主体的全部授权快照。
  | { readonly type: 'baseline'; readonly owner: false; readonly grants: readonly RemoteAccessGrant[] }
  // upsert：写入或覆盖一条授权。
  | { readonly type: 'upsert'; readonly grant: RemoteAccessGrant }
  // remove：撤销一个资源的授权。
  | { readonly type: 'remove'; readonly resource: RemoteAccessResource }
