// Client Session 对象层、Agent 作用域（scope）与 Remote 生命周期装配。
/** Client Session object layer, Agent scopes, and Remote lifecycle wiring. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionControlStream } from './transport.ts'
import { ClientSessions } from './sessions/service.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type {} from '../remote-events.ts'

export {
  createSessionControlStream,
  SessionEventStream,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './transport.ts'
export type {
  ClientSessionPageRequest,
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from './transport.ts'
export { createScope, scopeOf } from './scope.ts'
export type { AgentContext, AgentScopeHandle } from './scope.ts'
export { SessionCreateError, SessionForkError } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export type {
  SessionListPhase,
  SessionListSnapshot,
  SessionSearchResultItem,
  SessionProjectionSnapshot,
} from './sessions/manager.ts'
export type { Session } from './sessions/session.ts'
export type {
  ProjectionsBaseline,
  ProjectionValueStore,
  SessionProjectionMap,
  UseProjection,
} from './sessions/projection-store.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type {
  ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from './contract/sessions.ts'
export { MutableSessionEventSource } from './contract/events.ts'
export type {
  AssistantLiveChunkEvent,
  SessionAssistantSettlementEntry,
  SessionEventChange,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from './contract/events.ts'
export type {
  OpenState,
  PendingSubmission,
  PendingSubmissionAttachment,
  PendingSubmissionFileAttachment,
  PendingSubmissionImage,
  PendingSubmissionImageAttachment,
  PendingSubmissionPlacement,
  PromptError,
  SessionSnapshot,
} from './contract/snapshot.ts'

// 消费者自有的引用来源标签；通过本包的规范 /client 入口扩展该映射。
/** Consumer-owned reference labels; extend this map through the package's canonical /client entry. */
export interface SessionReferenceSourceMap {
  // 临时性的 Client Controller 操作，含 fork 标题准备。
  /** Temporary Client Controller work, including fork-title preparation. */
  controllerOperation: unknown
  // 一次 Client Gateway 调用的同步 Context 所有权。
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}

// 声明合并（declaration-merge）可扩展的标签类型，由独立的 Client 引用携带。
/** Declaration-merge-extensible labels carried by independent Client references. */
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

// 给 Cordis 的 Context 接口补充 sessions 服务的类型声明。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // Client Session 对象层与 Agent 作用域所有者。
    /** Client Session object layer and Agent scope owner. */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

// 必需的 Remote 与 Context 投影服务清单。
/** Required Remote and Context projection services. */
export const inject = [
  'connection',
  'fileUpload',
  'typert',
  'remote',
  'remote.commands',
  'remote.session',
  'remote.subagents',
]

// 安装 Client Session 状态及其可重连的控制流（control stream）。
/**
 * Install Client Session state and its reconnecting control stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  // 取出 Remote 命名空间并收窄为 Session 集群使用的窄接口。
  const remotes = ctx.remote as unknown as SessionRemotes
  // 取出连接句柄，用于监听连接代（generation）变化。
  const connection = ctx.get('connection') as ConnectionHandle
  // 创建会话管理器（目录、实例与投影的宿主）。
  const sessions = new ClientSessions(ctx, remotes)
  // Host 事件：会话新增 → 合并进目录。
  ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
  // Host 事件：会话移除 → 从目录移除。
  ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
  // Host 事件：运行状态变更 → 更新 Agent 运行位。
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    sessions.handleSessionStatus(sessionId, running)
  })
  // Host 事件：活动时间变更 → 推进列表活动时间。
  ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
    sessions.handleSessionActivity(sessionId, updatedAt)
  })
  // Host 事件：Agent 失败 → 转发给已实例化的会话。
  ctx.remote.$on('api-session/error', (sessionId, message) => {
    sessions.handleSessionError(sessionId, message)
  })

  // 创建可重连的控制流：接受的帧交给管理器，流失败只记日志（由重连流程恢复）。
  const control = createSessionControlStream(remotes, {
    accept: (frame) => { sessions.handleControlFrame(frame) },
    failed: (error) => { console.error('[session-controller] control stream failed:', error) },
  })
  // 连接代建立（或变更）时的恢复流程。
  const connected = (): void => {
    // 连接代尚未就绪：等待下一次订阅回调再触发。
    if (connection.generation.getSnapshot() === undefined) return
    // A ready control baseline may arrive before Cordis delivers connection/reset.
    // 就绪的控制基线可能先于 Cordis 的 connection/reset 到达。
    sessions.handleConnected()
    // 重建控制流通道并启动（重新请求基线）。
    control.restart()
    control.start()
  }
  // 订阅连接代变化，context 结束时自动退订。
  ctx.effect(() => connection.generation.subscribe(connected), 'session-controller.client.generation')
  // 立即执行一次，覆盖安装时连接已就绪的情况。
  connected()
  // 注册 typert 的 agent 上下文解析：从候选 context 解出会话身份，并按需暴露其作用域。
  ctx.typert.contexts.registerClient('agent', {
    // identity：从候选 context 解出会话 id。
    identity: candidate => sessions.sessionOf(candidate)?.sessionId,
    // resolve：保留该会话的 Agent 作用域，包装为 typert 拥有的值，值释放时同步释放引用。
    resolve: (sessionId) => {
      // 保留该会话的 Agent 作用域引用。
      const reference = sessions.retainAgentScope(sessionId)
      // 返回绑定 ctx 的 typert 拥有值；值销毁时释放引用。
      return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
    },
  })
  // context 销毁时等待控制流完全释放。
  ctx.effect(() => async () => { await control.dispose() }, 'session-controller.client.control')
}
