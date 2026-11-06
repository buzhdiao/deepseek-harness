/** Reviewed synthetic tool history shared by continuation and child-catalog measurements. */
// 文件头（JSDoc 补充）：由续跑（continuation）与子目录（child-catalog）两组测量共享的、经人工复核的合成工具历史。

import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Workload dimensions, independent of environment and recorded user material. */
// 中文补充（常量 JSDoc）：负载（workload）规模参数——与运行环境无关，也不含任何录制的用户素材。
export const WORKLOAD = {
  // 预播种的历史回合数（800 回合长历史）。
  historyTurns: 800,
  // 历史中每个回合包含的工具调用数。
  toolsPerHistoricalTurn: 4,
  // 单个工具结果文本的目标字符数。
  toolResultChars: 2_048,
  // 基线请求历史场景要构建的模型请求数。
  requestTurns: 40,
  // 工具续跑场景要跑的回合数。
  continuationTurns: 20,
  // profile 场景要跑的回合数。
  profileTurns: 100,
  // 活跃（直播）回合中每回合的工具调用数。
  toolsPerLiveTurn: 8,
  // 子目录场景的 fork 子会话数量。
  children: 16,
  // 每个子会话继承的历史回合数。
  childHistoryTurns: 80,
} as const

/** Fixed clock used only to author persisted synthetic input. */
// 中文补充（常量 JSDoc）：固定时钟，仅用于撰写持久化的合成输入，保证时间戳确定。
export const TIME_ZERO = 1_700_000_000_000
/** Durable parent identity of the measured continuation. */
// 中文补充（常量 JSDoc）：被测续跑会话的持久父会话 ID。
export const PARENT_ID = SessionId('bench-parent')

/**
 * Construct a deterministic model reply without retaining past requests.
 * @param serial - unique response ordinal.
 * @param tools - number of synthetic tool calls, or zero for a final text reply.
 * @returns streamed chunks and their known final blocks.
 */
// 中文补充（JSDoc）：构造一个确定性的模型回复，不保留既往请求状态。
// 中文补充（JSDoc）：@param serial —— 响应的唯一序号。
// 中文补充（JSDoc）：@param tools —— 合成工具调用数量；为 0 表示最终纯文本回复。
// 中文补充（JSDoc）：@returns —— 流式 chunk 序列及其已知的最终内容块。
export function response(serial: number, tools: number): { chunks: StreamChunk[]; content: ContentBlock[] } {
  // 内容块序列：推理块 + 文本块 + tools 个工具调用块。
  const content: ContentBlock[] = [
    // 推理（reasoning）块：重复 8 次的固定句子。
    { type: 'reasoning', text: 'Inspect the synthetic result. '.repeat(8) },
    // 最终文本块：重复 8 次的固定句子。
    { type: 'text', text: 'Synthetic response. '.repeat(8) },
    // 按序号生成 tools 个 bench_tool 调用，参数为确定性数字。
    ...Array.from({ length: tools }, (_, index): ContentBlock => ({
      type: 'tool-call', id: ToolCallId('call-' + String(serial) + '-' + String(index)), name: 'bench_tool',
      arguments: JSON.stringify({ ordinal: serial * 100 + index }),
    })),
  ]
  // 对应的流式 chunk 序列。
  const chunks: StreamChunk[] = []
  // 把每个内容块拆成开始、若干增量、结束三个阶段的 chunk。
  content.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type })
    // 文本/推理块：每 16 字符切一个 delta。
    if (block.type === 'text' || block.type === 'reasoning') {
      for (let offset = 0; offset < block.text.length; offset += 16) {
        chunks.push({ type: block.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text.slice(offset, offset + 16) })
      }
    } else if (block.type === 'tool-call') {
      // 工具调用块：参数 JSON 每 8 字符切一个 delta。
      for (let offset = 0; offset < block.arguments.length; offset += 8) {
        chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments.slice(offset, offset + 8) })
      }
    }
    chunks.push({ type: 'block-end', index, block })
  })
  // 附加 usage（用量）chunk：固定的输入/输出 token 数。
  chunks.push({ type: 'usage', usage: { inputTokens: 10_000, outputTokens: 100 } })
  // 结束 chunk：有工具调用时以 tool-calls 结束，否则以 stop 结束。
  chunks.push({ type: 'finish', reason: { kind: tools === 0 ? 'stop' : 'tool-calls' } })
  return { chunks, content }
}

/**
 * Author completed two-step turns through production Session append and stream compaction.
 * @param turns - completed historical turns.
 * @returns detached current-generation events with fixed ids, timestamps and payloads.
 */
// 中文补充（JSDoc）：通过生产版 Session 的 append 与流压缩（compaction）撰写完整的历史回合。
// 中文补充（JSDoc）：@param turns —— 要生成的已完成历史回合数。
// 中文补充（JSDoc）：@returns —— 与会话解耦的当前代事件，ID、时间戳与负载全部固定。
export function syntheticHistory(turns: number): SessionEvent[] {
  // 用生产实现创建临时会话，保证事件结构与真实会话一致。
  const session = Session.create(PARENT_ID)
  for (let turn = 1; turn <= turns; turn++) {
    // 每回合：回合开始事件 + 第一步开始事件。
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    // 仅第一个回合插入受保护的系统头部消息。
    if (turn === 1) session.append('system/message', {
      turn, step: 1, message: { id: MessageId('system-head'), role: 'system', content: [], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    // 用户消息：要求检查第 turn 个合成模块。
    session.append('user/message', {
      id: MessageId('prompt-' + String(turn)), role: 'user',
      content: [{ type: 'text', text: 'Inspect synthetic module ' + String(turn) }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // 每回合两个步骤：第一步带工具调用，第二步为纯文本收尾。
    for (const step of [1, 2]) {
      if (step === 2) session.append('step/start', { turn, step })
      // 第一步带 toolsPerHistoricalTurn 个工具调用，第二步不带。
      const reply = response(turn * 2 + step, step === 1 ? WORKLOAD.toolsPerHistoricalTurn : 0)
      // 用累加器把 chunk 播放一遍，得到快照形态的流记录。
      const stream = new AssistantStreamAccumulator()
      reply.chunks.forEach((chunk, index) => { stream.push({ time: TIME_ZERO + turn * 1_000 + step * 100 + index, chunk }) })
      // 追加助手消息事件：含最终内容块与流快照。
      session.append('assistant/message', {
        turn, step,
        message: { id: MessageId('reply-' + String(turn) + '-' + String(step)), role: 'assistant', content: reply.content, source: { kind: 'model', provider: 'bench', model: 'bench' } },
        stream: [...stream.snapshot()],
      }, { surfaceOp: 'append' })
      // 为回复中的每个工具调用补齐 tool/call 与 tool/result 事件对。
      for (const block of reply.content) {
        if (block.type !== 'tool-call') continue
        // 先追加调用事件。
        const call = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
        // 再追加结果事件：固定文本、无错误，并通过 sourceEventSeqs 回指调用事件。
        session.append('tool/result', {
          turn, step,
          message: {
            id: MessageId('result-' + block.id), role: 'tool', toolCallId: block.id, isError: false,
            source: { kind: 'tool', callId: block.id },
            content: [{ type: 'text', text: resultText(turn) }],
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      }
      // 步骤结束事件。
      session.append('step/end', { turn, step })
    }
    // 回合结束事件。
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // 从临时会话导出快照事件，并把时间戳统一改写为基于固定时钟的确定值。
  return session.snapshotEvents().map(event => ({ ...event, time: TIME_ZERO + event.seq }))
}

/**
 * Build a bounded synthetic file-read result with a varying prefix.
 * @param ordinal - deterministic result identifier.
 * @returns exactly the reviewed number of UTF-16 characters.
 */
// 中文补充（JSDoc）：构造有长度上限、前缀可变的合成文件读取结果。
// 中文补充（JSDoc）：@param ordinal —— 确定性的结果标识序号。
// 中文补充（JSDoc）：@returns —— 恰好等于复核规定的 UTF-16 字符数。
export function resultText(ordinal: number): string {
  // 模块头（含序号）+ 重复 100 行的固定导出语句，再截断到 WORKLOAD.toolResultChars 个字符。
  return ('module ' + String(ordinal) + '\n' + 'export const synthetic = 42;\n'.repeat(100)).slice(0, WORKLOAD.toolResultChars)
}
