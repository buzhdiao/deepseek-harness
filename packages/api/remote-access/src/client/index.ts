// 模块说明：Client 面——从索引注入的访问快照起步，跟随调用方 Peer 的快照流，
// 提供 `remoteAccess` Client 服务：`source(kind, id, action)` 对任意已声明类型的资源作答，
// `whenAccess(action, callback)` 在全局资源允许某动作期间保持效果安装，
// 并在全局资源上发布 `useRemoteAccess(action)` Hook。领域 UI 适配器
// 基于 `source()` 发布自己的资源 Hook，基于 `whenResourceAccess()` 发布自己的 whenAccess。
// 每个答案都是布尔值：拥有者（owner）为真；没有快照或非拥有者流失败后为假；
// 无论客户端答案如何，Host 都会对每次调用强制执行访问控制。
/**
 * Client face: starts from the access snapshot the index injected, follows
 * the calling Peer's snapshot stream, provides the `remoteAccess` Client
 * service whose `source(kind, id, action)` answers for any declared-kind
 * resource and whose `whenAccess(action, callback)` keeps effects installed
 * while the global resource allows an action, and publishes
 * `useRemoteAccess(action)` on the global resource. Domain UI adapters
 * publish their own resource Hooks over `source()` and their own
 * `whenAccess` over `whenResourceAccess()`. Every
 * answer is a boolean: true for the owner, false without a snapshot or after
 * a non-owner stream fails; the Host enforces every call regardless.
 * @module @deepseek-ai/dsh-api-remote-access/client
 */

// Cordis 的 Context（上下文）类型：Client 插件装配目标。
import type { Context } from '@deepseek-ai/cordis'
// 生成的 remoteAccess 远端挂载面：用于向 Host 订阅快照流。
import remoteAccessRemote from '@deepseek-ai/dsh-api-remote-access/remote'
// 首次访问快照的全局键：读取索引注入行写入的打开基线。
import { REMOTE_ACCESS_SNAPSHOT_KEY } from '../snapshot.ts'
// 挂载逻辑：真正装配远端命名空间与访问 Hook 的函数。
import { mountAccess } from './mount.ts'
// 基线解析：校验注入的打开快照。
import { parseInjectedBaseline } from './state.ts'

// 原样转发本包的访问控制类型面，供 Client 侧引用。
export type {
  RemoteAccessAction, RemoteAccessEndpoint, RemoteAccessFrame, RemoteAccessGrant, RemoteAccessResource, TypertResourceKind,
} from '../types.ts'
// 转发挂载面的效果与客户端访问服务类型。
export type { AccessEffect, ClientRemoteAccess, RemoteEndpoint } from './mount.ts'

// 所需的 Client 服务：Remote 挂载面与 Slot（槽位）注册表。
/** Required Client services: the Remote mount face and the Slot registry. */
export const inject = ['remote', 'slots']

// 挂载生成的 `remoteAccess` 命名空间并发布访问 Hook。
/**
 * Mount the generated `remoteAccess` namespace and publish the access Hooks.
 * @param ctx - Client root Context.
 * @returns disposer that withdraws the namespace after the stream stops.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  // 从全局对象读取索引注入的快照并校验为基线，随后交给挂载逻辑装配。
  return mountAccess(ctx, remoteAccessRemote, parseInjectedBaseline(Reflect.get(globalThis, REMOTE_ACCESS_SNAPSHOT_KEY)))
}
