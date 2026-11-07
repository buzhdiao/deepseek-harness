// Session 集群调用的 Remote 命名空间：一个概念一个参数，即会话及其管理器访问 Host 的生成面（generated surface）。
/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/sessions/remotes
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest,
} from '@deepseek-ai/dsh-subagent/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemote } from '../transport.ts'

// Client Session 消费的窄 Commands 命名空间。
/** Narrow Commands namespace consumed by a Client Session. */
export interface SessionCommandsRemote {
  // 对某个 agent 执行一行命令（可带提交附件、可取消）。
  execute(
    agentId: SessionId,
    line: string,
    attachments: readonly CommandSubmitAttachment[],
    signal?: AbortSignal,
  ): Promise<RemoteResult<object | undefined>>
}

// Client Session 及其管理器消费的窄 subagent 命名空间。
/** Narrow subagent namespace consumed by a Client Session and its manager. */
export interface SessionSubagentsRemote {
  // 向子会话发起 prompt。
  prompt(
    request: SubagentPromptRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<SubagentPromptReceipt>>
  // 由用户中断子会话。
  interruptByUser(
    childSessionId: SessionId,
  ): Promise<RemoteResult<SubagentInterruptReceipt>>
}

// Client Session 对象层消费的生成 Remote 命名空间。
/** Generated Remote namespaces consumed by the Client Session object layer. */
export interface SessionRemotes {
  // 事件流通道。
  readonly $stream: ClientRemote['$stream']
  // 命令命名空间。
  readonly commands: SessionCommandsRemote
  // 会话命名空间。
  readonly session: SessionRemote
  // 子代理命名空间。
  readonly subagents: SessionSubagentsRemote
}
