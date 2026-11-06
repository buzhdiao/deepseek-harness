/** Synthetic current-generation history and paced reply for browser measurements. */
// 文件头（JSDoc 补充）：为浏览器测量提供合成的新一代历史与按节奏（paced）回放的回复。
import { createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** Closed turns in the browser history workload. */
// 中文补充（常量 JSDoc）：浏览器历史负载中的已完成回合数（240 回合）。
export const HISTORY_TURNS = 240
/** Identity private to each isolated scaffold. */
// 中文补充（常量 JSDoc）：每个隔离脚手架（scaffold）私有的会话标识。
export const SESSION_ID = 'benchmark-browser-history'
// 会话标题：固定字符串，便于播种后校验。
const TITLE = 'SYNTHETIC_BROWSER_HISTORY'
/** First streamed text marker. */
// 中文补充（常量 JSDoc）：首个流式文本标记。
export const FIRST = 'SYNTHETIC_REPLY_FIRST'
/** Last streamed text marker. */
// 中文补充（常量 JSDoc）：最后一个流式文本标记。
export const DONE = 'SYNTHETIC_REPLY_DONE'
/** Paced text chunks per continuation. */
// 中文补充（常量 JSDoc）：每次续跑（continuation）发送的节奏化文本 chunk 数。
export const DELTAS = 120
/** Replay delay per stream chunk, in milliseconds. */
// 中文补充（常量 JSDoc）：回放时每个流式 chunk 之间的延迟（毫秒）。
export const PACE_MS = 16

/** Create mixed prose, code, reasoning and tool history without reading user data.
 * @returns Current Session JSONL accepted by the shared Web seeder.
 */
// 中文补充（JSDoc）：构造散文、代码、推理与工具混合的历史，不读取任何用户数据。
// 中文补充（JSDoc）：@returns —— 共享 Web 播种器（seeder）可接受的当前代 Session JSONL 文本。
export function syntheticHistory(): string {
  // 用生产 Session 实现撰写事件，保证结构与真实会话一致。
  const session = Session.create(SessionId(SESSION_ID))
  for (let turn = 1; turn <= HISTORY_TURNS; turn++) {
    // 回合开始与第一步开始事件。
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    // 仅第一回合插入空内容的系统消息头部。
    if (turn === 1) session.append('system/message', {
      turn, step: 1, message: createSystemMessage(''),
    }, { surfaceOp: 'append' })
    // 用户消息：中英混合、重复 30 次的长文本，考验渲染性能。
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Review synthetic change ' + String(turn) + ': 检查增量渲染。 '.repeat(30) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // 仅第一回合根据首条用户消息设置会话标题。
    if (turn === 1) session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    // 工具调用 ID 按回合命名。
    const callId = ToolCallId('synthetic-tool-' + String(turn))
    // 每 6 回合出现一次工具调用。
    const tool = turn % 6 === 0
    // 每 12 回合附上一段 60 行的 TypeScript 代码块。
    const code = turn % 12 === 0
      ? '\n\n```ts\n' + Array.from({ length: 60 }, (_, i) => 'const value' + String(i) + ' = ' + String(i)).join('\n') + '\n```'
      : ''
    // 推理文本与正文文本（含可选代码块）。
    const reasoning = 'Compare the synthetic module and test. '.repeat(40)
    const text = 'Synthetic answer ' + String(turn) + '. ' + 'Preserve ordering and validate the output. '.repeat(30) + code
    // 工具参数为固定的 JSON 路径。
    const args = '{"path":"src/example.ts"}'
    // 用累加器录制流式 chunk，时间戳逐个递增。
    const stream = new AssistantStreamAccumulator()
    let time = 1700000000000 + turn * 10000
    const push = (chunk: StreamChunk): void => { stream.push({ time: time++, chunk }) }
    // 推理块与文本块：开始、每 12 字符一个 delta、结束。
    for (const [index, block] of [{ type: 'reasoning' as const, text: reasoning }, { type: 'text' as const, text }].entries()) {
      push({ type: 'block-start', index, blockType: block.type })
      for (let offset = 0; offset < block.text.length; offset += 12) {
        push({ type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text.slice(offset, offset + 12) })
      }
      push({ type: 'block-end', index, block })
    }
    // 工具回合额外产生第三个块：工具调用（首片带工具名，参数每 8 字符一片）。
    if (tool) {
      push({ type: 'block-start', index: 2, blockType: 'tool-call' })
      for (let offset = 0; offset < args.length; offset += 8) {
        push({ type: 'tool-call-delta', index: 2, id: callId, ...offset === 0 ? { name: 'synthetic_tool' } : {}, argumentsDelta: args.slice(offset, offset + 8) })
      }
      push({ type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'synthetic_tool', arguments: args } })
    }
    // 用量与结束 chunk：有工具调用时以 tool-calls 结束。
    push({ type: 'usage', usage: { inputTokens: 4000, outputTokens: 800 } })
    push({ type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } })
    // 追加助手消息事件：携带流快照与最终内容（含可选工具调用块）。
    session.append('assistant/message', {
      turn, step: 1, stream: [...stream.snapshot()],
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text },
          ...tool ? [{ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: args }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    // 工具回合补齐 tool/call 与 tool/result 事件对（结果为 160 行固定输出）。
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: args })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output line.\n'.repeat(160) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    // 步骤结束与回合结束事件。
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // 输出 JSONL：首行为带占位符（{{sessionId}}/{{cwd}}）的会话头，随后是全部快照事件，末尾留一个空行。
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

/** Create one paced response; replay owns delays outside the browser.
 * @returns Stream chunks ending in a visible completion marker.
 */
// 中文补充（JSDoc）：构造一次节奏化回复；延迟由浏览器之外的回放器控制。
// 中文补充（JSDoc）：@returns —— 以可见完成标记结尾的流式 chunk 序列。
export function syntheticReply(): StreamChunk[] {
  // 生成 DELTAS 个文本片段：首片为 FIRST 标记，末片为 DONE 标记，中间为编号句子。
  const deltas = Array.from({ length: DELTAS }, (_, i) => i === 0 ? FIRST + ' ' : i === DELTAS - 1 ? DONE : 'Synthetic response ' + String(i) + '. ')
  // 组装完整 chunk 序列：块开始 + 全部文本增量 + 块结束 + 用量 + 结束。
  return [{ type: 'block-start', index: 0, blockType: 'text' }, ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })), { type: 'block-end', index: 0, block: { type: 'text', text: deltas.join('') } }, { type: 'usage', usage: { inputTokens: 4000, outputTokens: 800 } }, { type: 'finish', reason: { kind: 'stop' } }]
}
