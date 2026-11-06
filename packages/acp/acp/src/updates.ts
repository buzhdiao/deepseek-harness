/** Standard ACP updates derived from committed DSH session events. */
// 由已提交（committed）的 DSH 会话事件推导出的标准 ACP 更新。

import type { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context 类型。
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
// 导入 ACP 的会话更新与工具调用内容类型。
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 导入 DSH 的会话与事件类型。
import type {} from '@deepseek-ai/dsh-token-meter'
// 纯类型副作用导入：合并 token 计量服务声明。
// 导入同包内容模块：核心块到 ACP 线上内容的转换。
import { assistantBlockToAcp } from './content.ts'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
// 按块顺序把一条已提交的助手消息及其上下文用量转换为更新列表。
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  // 收集结果的更新列表。
  const updates: SessionUpdate[] = []
  // 遍历消息内容块。
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      // 推理块作为思考片段（agent_thought_chunk）更新；空文本跳过。
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      // 推理块处理完毕，继续下一块。
      continue
    }
    // 其余块转换为 ACP 线上内容（可能返回 undefined）。
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      // 非输出块不产生消息片段。
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  // 附加上下文用量更新（可能没有）。
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
// 从持久化的调用事实启动一个通用 ACP 工具生命周期。
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    // 通用生命周期固定为 other 类别与进行中状态。
    kind: 'other',
    status: 'in_progress',
    // 参数尽量解析为结构化输入；畸形模型输出原样保留。
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
// 从已提交的面向模型的结果结束一个通用工具生命周期。
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  // 结果消息。
  const message = event.data.message
  // 收集转换后的内容。
  const content: ToolCallContent[] = []
  // 逐块转换结果内容；非输出块被丢弃。
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    // 失败标记映射为 failed，否则 completed。
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
// 仅当 DSH 同时具备用量与容量两个事实时，才报告当前上下文占用。
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  // 无用量事实则不报告。
  if (event.data.usage === undefined) return undefined
  // 查询会话的上下文窗口大小。
  const size = session.requestContext()?.contextWindow
  // 获取 token 计量服务。
  const meter = ctx.get('tokenMeter')
  // 任一事实缺失则不报告。
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    // 已用 token 由计量服务测量。
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
// 把畸形的模型输出保留为不透明输入，而不是丢弃整个调用更新。
function parseToolArguments(value: string): unknown {
  try {
    // 正常解析为结构化 JSON。
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    // 解析失败时返回原始字符串。
    return value
  }
}
