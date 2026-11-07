// 模块说明：Client 访问挂载——跟随调用方 Peer 的访问快照，提供 `remoteAccess`
// Client 服务，并发布全局资源的 `useRemoteAccess` Hook。入口模块提供生成的
// remoteAccess 贡献，因此测试规范（spec）可以挂载一个假的。
/**
 * Client access mount: follows the calling Peer's access snapshot, provides
 * the `remoteAccess` Client service, and publishes the global-resource `useRemoteAccess` Hook.
 * The entry module supplies the generated `remoteAccess` contribution, so
 * specs mount a fake one.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/mount
 */

// Cordis 的 Service（服务基类）与 Context（上下文）类型。
import { Service, type Context } from '@deepseek-ai/cordis'
// 网关客户端工具：远端快照流、流载体错误、客户端远端类型。
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
// 空类型导入：引入生成的 remoteAccess 远端贡献的模块扩充。
import type {} from '@deepseek-ai/dsh-api-remote-access/remote'
// 槽位（slots）类型：HostObservable 布尔源与根标准源贡献。
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the SlotRegistry (`ctx.slots`) merge.
// 纯类型导入：合并 SlotRegistry（`ctx.slots`）的类型面。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Typert 协议类型：远端贡献、远端映射、资源种类。
import type { TypertRemoteContribution, TypertRemoteMap, TypertResourceKind } from '@deepseek-ai/dsh-typert-protocol'
// 本包类型：访问快照帧。
import type { RemoteAccessFrame } from '../types.ts'
// 客户端访问状态：快照拥有者与布尔源缓存。
import { ClientAccessState, type Baseline } from './state.ts'
// 访问效果控制器：whenAllowed 及其效果类型。
import { whenAllowed, type AccessEffect } from './when-allowed.ts'

// 原样转发访问效果类型。
export type { AccessEffect } from './when-allowed.ts'

// Client 各 Remote 命名空间声明的全部端点。
/** Every endpoint the Client Remote namespaces declare. */
export type RemoteEndpoint = Extract<keyof TypertRemoteMap, string>

/** Client access answers over the calling Peer's snapshot; it never issues a request. */
export interface ClientRemoteAccess {
  /**
   * Whether the current Peer may call `action` on one resource.
   * True for the owner; false without a baseline and after a non-owner
   * stream fails; otherwise whether the resource's grant lists the action.
   * Only the package that owns a resource kind calls it, to build that kind's
   * access Hook; other plugins read access through the access Hooks or
   * `whenAccess`.
   * @param kind - resource kind declared in `TypertResourceMap`.
   * @param id - resource identity.
   * @param action - endpoint action the caller would invoke.
   * @returns identity-stable boolean source for this `(kind, id, action)`.
   */
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean>
  /**
   * Keep `callback`'s effects installed while the current Peer may call
   * `action` on the global resource: run it when the answer becomes true,
   * dispose its effects in reverse order when it becomes false, and run it
   * again on the next true. The callback runs synchronously when the answer
   * is already true, as it always is for the owner. Effect forms and fiber
   * ownership match `ctx.slots.inject`.
   * @param action - endpoint action the guarded effects depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer for the observation and any installed effects.
   */
  whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void
  /**
   * {@link whenAccess} for one resource of a declared kind. Only the package
   * that owns a resource kind calls it, to build that kind's `whenAccess`, as
   * it builds the kind's access Hook over {@link source}.
   * @param kind - resource kind declared in `TypertResourceMap`.
   * @param id - resource identity.
   * @param action - endpoint action the guarded effects depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer for the observation and any installed effects.
   */
  whenResourceAccess(kind: TypertResourceKind, id: string, action: RemoteEndpoint, callback: () => AccessEffect): () => void
}

// 模块扩充：在 Cordis Context 上登记 Client 访问服务。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // 面向调用方 Peer 的 Client 访问答案。
    /** Client access answers for the calling Peer. */
    remoteAccess: ClientRemoteAccess
  }
}

// 模块扩充：在全局标准属性上登记 useRemoteAccess Hook。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    // 当前 Peer 可否在全局资源上调用某动作。
    /** Whether the current Peer may call `action` on the global resource. */
    useRemoteAccess: (action: RemoteEndpoint) => boolean
  }
}

// 增量帧类型：快照帧中除 baseline 之外的成员。
type IncrementFrame = Exclude<RemoteAccessFrame, { type: 'baseline' }>

// 基于单个快照拥有者的 `remoteAccess` Client 服务。
/** The `remoteAccess` Client service over one snapshot owner. */
class ClientRemoteAccessService extends Service implements ClientRemoteAccess {
  // 构造服务：注册为 'remoteAccess' 并持有快照状态。
  /**
   * @param ctx - Client Context the service is provided on.
   * @param state - snapshot owner answering every source.
   */
  constructor(ctx: Context, private readonly state: ClientAccessState) {
    // 调用服务基类：服务名 remoteAccess。
    super(ctx, 'remoteAccess')
  }

  // 查询某已声明资源上某动作的访问布尔源：委托给状态对象。
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean> {
    return this.state.resource(kind, id, action)
  }

  // Prototype methods: the Cordis service proxy binds `this.ctx` to the caller's Context.
  // 全局资源上的 whenAccess：跟随全局布尔源安装/清理回调效果。
  whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    // 委托给 whenAllowed，诊断标签中带上序列化的动作名。
    return whenAllowed(this.ctx, this.state.global(action), callback, `remoteAccess.whenAccess(${JSON.stringify(action)})`)
  }

  // 某已声明资源上的 whenResourceAccess：跟随该资源的布尔源。
  whenResourceAccess(kind: TypertResourceKind, id: string, action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    // 委托给 whenAllowed，诊断标签中带上 kind/id/action。
    return whenAllowed(this.ctx, this.state.resource(kind, id, action), callback,
      `remoteAccess.whenResourceAccess(${JSON.stringify(kind)}, ${JSON.stringify(id)}, ${JSON.stringify(action)})`)
  }
}

// 挂载 `remoteAccess` 命名空间，跟随访问快照，提供 `remoteAccess` Client 服务，
// 并发布全局资源的 `useRemoteAccess` Hook。答案从页面注入的基线起步（没有则为假），
// 之后持续跟随流的帧。
/**
 * Mount the `remoteAccess` namespace, follow the access snapshot, provide the
 * `remoteAccess` Client service, and publish the global-resource `useRemoteAccess` Hook.
 * Answers start from the page's injected baseline, or false without one,
 * and follow the stream's frames from then on.
 * @param ctx - Client root Context injecting `remote` and `slots`.
 * @param contribution - generated `remoteAccess` Remote contribution.
 * @param initial - the page's injected opening baseline, read before the stream connects.
 * @returns disposer that withdraws the namespace after the stream stops.
 */
export async function mountAccess(
  ctx: Context,
  contribution: TypertRemoteContribution,
  initial?: Baseline,
): Promise<() => Promise<void>> {
  // 创建快照状态：从页面注入的打开基线起步（可为空）。
  const state = new ClientAccessState(initial)
  // 实例化 Client 访问服务：注册到 ctx 上供其他插件读取。
  new ClientRemoteAccessService(ctx, state)
  // 发布根级标准源贡献：把 remoteAccess 键控 Hook 指到全局布尔源。
  ctx.slots.provideRoot({
    keyedHooks: { remoteAccess: action => state.global(action) },
  } satisfies RootStandardSourceContribution)
  // 挂载生成的 remoteAccess 远端贡献，稍后可卸载。
  const unmount = await ctx.remote.$mount(contribution)
  // 在 remote.remoteAccess 服务可用时启动快照跟随流。
  const follow = ctx.inject(['remote.remoteAccess'], (remoteCtx) => {
    // 创建可重连的访问快照流控制句柄并启动。
    const control = createAccessStream(remoteCtx.remote, state, remoteCtx.logger)
    control.start()
    // 注册效果：随该注入纤程卸载时释放流。
    remoteCtx.effect(() => async () => { await control.dispose() }, 'remote-access.client.follow')
  })
  // 返回卸载函数：先停跟随流，再卸载远端命名空间。
  return async () => {
    await follow.dispose()
    await unmount()
  }
}

// 创建可重连的访问快照流。载体丢失时在重连期间保留最后一份快照；
// 终态失败时保留拥有者的答案，并把非拥有者的答案转为假。
/**
 * Create the reconnecting access snapshot stream. A carrier loss keeps the
 * last snapshot while the stream reconnects; a terminal failure keeps the
 * owner's answers and turns a non-owner's answers false.
 */
function createAccessStream(
  remote: ClientRemote,
  state: ClientAccessState,
  logger: Context['logger'],
): RemoteSnapshotStream<Baseline, IncrementFrame> {
  // 建立底层远端流：打开时调用 remoteAccess.follow，异常结束按是否有终态结果分类。
  const stream = remote.$stream<RemoteAccessFrame>({
    // 流名称：用于诊断。
    name: 'Remote access stream',
    // 打开函数：以给定信号调用远端 follow。
    open: signal => remote.remoteAccess.follow(signal),
    // 结束分类：已收到过接受的结果视为载体错误；否则视为在打开快照之前就结束。
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Remote access stream ended without a terminal result')
      : new Error('Remote access stream ended before its opening snapshot'),
  })
  // 用快照流包装：识别基线帧、分派替换与增量、处理终态失败。
  return new RemoteSnapshotStream<Baseline, IncrementFrame>(stream, {
    // 流名称：用于诊断。
    name: 'Remote access stream',
    // 快照识别：baseline 帧即快照。
    isSnapshot: (frame): frame is Baseline => frame.type === 'baseline',
    // 快照替换：整代基线替换状态。
    replace: (frame) => { state.replace(frame) },
    // 增量更新：应用 upsert/remove 帧。
    update: (frame) => { state.update(frame) },
    // 终态失败处理。
    failed: (error) => {
      // Only a non-owner's answers turn false after a terminal failure, so only its report names the recovery.
      // 只有非拥有者的答案会在终态失败后变假，因此只有它的报告给出恢复方式。
      if (state.owner) logger.error('access snapshot stream failed; owner access answers are unaffected', error)
      else logger.error('access snapshot stream failed; reload the page to reconnect', error)
      // 通知状态：拥有者保持答案，非拥有者转假。
      state.unavailable()
    },
  })
}
