/** Compiled worker for Client history folding, live Assistant text, and tool preparation. */
// 文件头（JSDoc 补充）：编译产物 worker，承载三类测量——Client 历史折叠、直播 Assistant 文本发布、工具参数准备。

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
// These Client-only fold modules have no plain-Node package export and are compiled into this worker.
import { ConversationNodeAssembler } from '../../packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { ConversationEventRegistry } from '../../packages/client/ui-conversation/src/client/conversation/event-registry.ts'
import { inspectRequestPrompt } from '../../packages/client/ui-conversation/src/client/contract/request-inspection.ts'
import type { ConversationViewDefinition } from '../../packages/client/ui-conversation/src/client/contract/conversation.ts'
import { registerAssistantConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { processGroupDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts'
import { requestPromptDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/retry.ts'
import { registerToolConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts'
import { registerTurnProcess } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import { registerTurnTailConversationNode } from '../../packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

// 合成数据的固定时钟起点，保证时间戳确定。
const TIME_ZERO = 1_700_000_000_000

/** Result emitted by the compiled conversation-fold worker. */
// 中文补充（接口 JSDoc）：编译后的 conversation-fold worker 产出的结果。
export interface ConversationFoldWorkerReport {
  // 窗口内的事件总数。
  readonly events: number
  // 压缩（compaction）后的流记录数。
  readonly compactRecords: number
  // 流式 delta 总数。
  readonly streamedDeltas: number
  // 折叠后产生的 Chat 节点数。
  readonly chatNodes: number
  // 小窗口折叠耗时（毫秒）。
  readonly smallFoldMs: number
  // 大窗口折叠耗时（毫秒）。
  readonly largeFoldMs: number
  // 缩放比 = 大窗口耗时 / 小窗口耗时。
  readonly scaling: number
}

/** Incremental argument folding through the Tool Definition and Chat group publication. */
// 中文补充（接口 JSDoc）：经由工具（Tool）定义与 Chat 分组发布完成的增量参数折叠报告。
export interface PreparingToolWorkerReport {
  // 被测工具名：write 或 bash。
  readonly tool: 'write' | 'bash'
  // 参数字符总数。
  readonly characters: number | undefined
  // 流式碎片（chunks）数量。
  readonly fragments: number
  // 发布全部参数的耗时（毫秒）。
  readonly elapsedMs: number
  // 保留堆内存增量（MB）。
  readonly retainedMb: number
  // 进程峰值 RSS（MB）。
  readonly maxRssMb: number
  // 工具行（tool row）快照读取次数。
  readonly rowReads: number
  // write 工具的进度值（KiB）。
  readonly progressKb: number | undefined
  // write 工具解析出的文件路径。
  readonly filePath: string | undefined
  // 分组摘要中的运行详情文本。
  readonly detail: string | undefined
}

/** One live Assistant block folded and read through the published Chat snapshot. */
// 中文补充（接口 JSDoc）：单个直播 Assistant 块经折叠并通过已发布 Chat 快照读取的报告。
export interface StreamingAssistantWorkerReport {
  // 块类型：text 或 reasoning。
  readonly blockType: 'text' | 'reasoning'
  // 内容模式：普通文本或前导空白。
  readonly pattern: 'ordinary' | 'leading-whitespace'
  // 总字符数。
  readonly characters: number
  // 碎片数量。
  readonly fragments: number
  // 全文字符码累加校验和。
  readonly checksum: number
  // 追加 + 发布 + 完整读取的耗时（毫秒）。
  readonly elapsedMs: number
  // 用户态 CPU 时间（毫秒）。
  readonly cpuUserMs: number
  // 内核态 CPU 时间（毫秒）。
  readonly cpuSystemMs: number
  // 保留堆内存增量（MB）。
  readonly retainedMb: number
  // 进程峰值 RSS（MB）。
  readonly maxRssMb: number
}

// 注册全部事件定义到 ConversationEventRegistry，复刻生产 Chat 界面的事件路由。
function registerEventDefinitions(ctx: Context): ConversationEventRegistry {
  const events = new ConversationEventRegistry(ctx)
  // Only the service holder is an adapter; registrations and routing use production code.
  Object.defineProperty(ctx, 'uiConversation', { value: { events } })
  // 注册收件箱（inbox）、消息、请求提示词（request prompt）等节点定义。
  events.register(nextStepInboxDefinition)
  events.register(messageDefinition)
  events.register(requestPromptDefinition(inspectRequestPrompt))
  // 注册助手节点与回合进程（turn process）注册器。
  registerAssistantConversationNode(ctx)
  registerTurnProcess(ctx)
  registerToolConversationNode(ctx)
  // 注册命令、压缩、重试、回合错误、回合 token 上限等节点定义。
  events.register(commandDefinition)
  events.register(compactionDefinition)
  events.register(retryDefinition)
  events.register(turnErrorDefinition)
  events.register(turnMaxTokensDefinition)
  // 注册回合尾部节点与未知事件兜底（fallback）定义。
  registerTurnTailConversationNode(ctx)
  events.registerFallback(unknownFallbackDefinition)
  return events
}

// 基准视图定义：仅提供 chat 视图，贴近真实 Chat 界面的单一视图场景。
class BenchViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

// 构造一个"普通事件"形态的条目（entry）：序号、时间、类型与数据。
function entry(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { seq, time: TIME_ZERO + seq, type, data, ...extra } as unknown as SessionEvent,
  }
}

// 合成一个大历史窗口：turns 条回复，每条含 deltas 个文本 delta 与四分之一数量的推理 delta。
function synthesizeWindow(
  turns: number,
  deltas: number,
): { readonly entries: readonly SessionEventLikeEntry[]; readonly records: number } {
  const entries: SessionEventLikeEntry[] = []
  // 事件序号计数器。
  let seq = 0
  // 压缩后的流记录计数器。
  let records = 0
  // 快捷推入函数：追加一条事件并递增序号。
  const push = (type: string, data: unknown, extra: Record<string, unknown> = {}): void => {
    entries.push(entry(seq, type, data, extra))
    seq += 1
  }
  // 推理 delta 数为文本 delta 数的四分之一。
  const reasoningDeltas = Math.floor(deltas / 4)
  for (let turn = 1; turn <= turns; turn += 1) {
    // 回合开始与用户消息事件。
    push('turn/start', { turn })
    push('user/message', {
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('step/start', { turn, step: 1 })
    // 用累加器录制流式 chunk，得到压缩后的流记录快照。
    const accumulator = new AssistantStreamAccumulator()
    let time = TIME_ZERO + seq * 1_000
    const stream = (chunk: StreamChunk): void => {
      accumulator.push({ time, chunk })
      time += 1
    }
    // 推理块：开始 + reasoningDeltas 个增量 + 结束。
    stream({ type: 'block-start', index: 0, blockType: 'reasoning' })
    let reasoning = ''
    for (let index = 0; index < reasoningDeltas; index += 1) {
      const delta = `r${String(index)} `
      reasoning += delta
      stream({ type: 'reasoning-delta', index: 0, text: delta })
    }
    stream({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    // 文本块：开始 + deltas 个增量 + 结束。
    stream({ type: 'block-start', index: 1, blockType: 'text' })
    let text = ''
    for (let index = 0; index < deltas; index += 1) {
      const delta = `w${String(index)} `
      text += delta
      stream({ type: 'text-delta', index: 1, text: delta })
    }
    stream({ type: 'block-end', index: 1, block: { type: 'text', text } })
    // 用量与结束 chunk。
    const usage = { inputTokens: 100, outputTokens: deltas }
    stream({ type: 'usage', usage })
    stream({ type: 'finish', reason: { kind: 'stop' } })
    // 累计压缩记录数。
    const snapshot = accumulator.snapshot()
    records += snapshot.length
    // 追加助手消息事件：含最终内容块与完整流快照。
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
      stream: snapshot,
    }, { surfaceOp: 'append' })
    // 步骤结束与回合结束事件。
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { entries, records }
}

// 执行一次完整折叠并计时：替换窗口、激活 chat 视图、产出快照。
function foldOnce(entries: readonly SessionEventLikeEntry[], definitions: ConversationEventRegistry): { readonly ms: number; readonly nodes: number } {
  const started = performance.now()
  const assembler = new ConversationNodeAssembler(definitions, new BenchViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  return { ms: performance.now() - started, nodes: snapshot?.order.length ?? 0 }
}

// 取多次尝试中的最快结果——消除调度器延迟对冷测量的干扰。
function bestOf(
  entries: readonly SessionEventLikeEntry[],
  attempts: number,
  definitions: ConversationEventRegistry,
): { readonly ms: number; readonly nodes: number } {
  let best = foldOnce(entries, definitions)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const next = foldOnce(entries, definitions)
    if (next.ms < best.ms) best = next
  }
  return best
}

// 参数校验工具：把字符串参数解析为正整数，非法则报错。
function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

// 工具参数准备测量：流式发布 16 字符一片的参数增量，模拟 Watching 模型流式写文件/执行命令。
function preparingTool(tool: 'write' | 'bash', characters: number, definitions: ConversationEventRegistry): PreparingToolWorkerReport {
  // 内存测量依赖显式 GC。
  if (globalThis.gc === undefined) throw new Error('preparing benchmark requires --expose-gc')
  // 每片增量 16 字符，每发布 64 片刷写一次。
  const chunkSize = 16
  const chunksPerPublication = 64
  // 生成指定长度的合成参数负载。
  const payload = 'abcdefghijklmno '.repeat(Math.ceil(characters / chunkSize)).slice(0, characters)
  // 尾部附加闭合引号，构造合法的 JSON 参数串。
  const tail = `${payload}"}`
  const callId = ToolCallId('preparing-benchmark')
  const attemptId = LlmAttemptId('preparing-benchmark')
  // 构造一条 transient 的直播工具调用增量事件。
  const delta = (index: number, argumentsDelta: string): SessionEventLikeEntry => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq: 2 + index / (tail.length + 1), time: TIME_ZERO + index,
      data: { turn: 1, step: 1, attemptId, chunk: {
        type: 'tool-call-delta', index: 0, id: callId, argumentsDelta,
        // 仅第一片携带工具名。
        ...index === 0 ? { name: tool } : {},
      } },
    },
  })
  // 把完整参数串切成增量片。
  const chunks: SessionEventLikeEntry[] = []
  for (let at = 0; at < tail.length; at += chunkSize) chunks.push(delta(at + 1, tail.slice(at, at + chunkSize)))
  // 带过程分组（process group）视图定义的装配器（assembler），贴近真实工具行渲染路径。
  const assembler = new ConversationNodeAssembler(
    definitions, new BenchViewDefinitions(),
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  // 初始窗口：回合/步骤开始 + 首片增量（携带 JSON 前缀）。
  assembler.replaceWindow([
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'step/start', { turn: 1, step: 1 }),
    delta(0, tool === 'write' ? '{"file_path":"preview.md","content":"' : '{"command":"'),
  ], false)
  assembler.activateTarget('chat')
  const snapshot = assembler.get('chat')
  // 找到刚创建的工具调用节点。
  const node = snapshot?.nodes.values().find((candidate): candidate is ChatNode<'tool-call'> => candidate.kind === 'tool-call')
  if (snapshot === undefined || node === undefined) throw new Error('preparing benchmark did not create its Tool node')
  const args = node.data.root.args
  // 取该节点的快照源（source），用于订阅与逐行读取。
  const source = snapshot.nodes.source(node.key)
  let rowReads = 0
  let progressKb: number | undefined
  let filePath: string | undefined
  // 读取一次工具行：校验快照仍是 tool-call，并读取 write 工具的进度与文件路径。
  const readRow = (): void => {
    const current = source.getSnapshot()
    if (current?.kind !== 'tool-call') throw new Error('preparing benchmark lost its Tool node')
    const currentArgs = (current as ChatNode<'tool-call'>).data.root.args
    if (tool === 'write') {
      const length = currentArgs.stringLength('content', { step: 1024 })
      progressKb = length === undefined ? undefined : Math.ceil(length / 1024)
      filePath = currentArgs.text('file_path')
    }
    rowReads++
  }
  readRow()
  // write 工具额外订阅行更新（模拟 GUI 的进度订阅）；bash 不订阅。
  const unsubscribe = tool === 'write' ? source.subscribe(readRow) : () => {}
  globalThis.gc()
  // 记录 GC 后的堆基线。
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  // 逐片追加增量，按 chunksPerPublication 分批刷写。
  for (let index = 0; index < chunks.length; index++) {
    assembler.append(chunks[index]!)
    if ((index + 1) % chunksPerPublication === 0) assembler.flush()
  }
  // 最终刷写并计时。
  assembler.flush()
  const elapsedMs = performance.now() - start
  unsubscribe()
  globalThis.gc()
  // 计算 GC 后仍保留的堆内存增量（MB）。
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
  // 取 Chat 分组列表，定位过程分组。
  const groups = assembler.grouped('chat')
  const group = groups?.entries.find(reference => reference.kind === 'group')
  return {
    // write 统计 content 字段长度，bash 统计 command 字段长度。
    tool, characters: args.stringLength(tool === 'write' ? 'content' : 'command'), fragments: chunks.length,
    elapsedMs, retainedMb, maxRssMb: process.resourceUsage().maxRSS / 1024,
    rowReads, progressKb, filePath,
    // 详情取自分组摘要的 runningDetail 文本。
    detail: group === undefined ? undefined : groups?.groupSource(group.key).getSnapshot()?.data.summary.runningDetail,
  }
}

// 直播 Assistant 文本测量：追加碎片增量、发布、完整读取并校验内容。
function streamingAssistant(
  blockType: StreamingAssistantWorkerReport['blockType'],
  pattern: StreamingAssistantWorkerReport['pattern'],
  characters: number,
  fragments: number,
  definitions: ConversationEventRegistry,
): StreamingAssistantWorkerReport {
  // 内存测量依赖显式 GC。
  if (globalThis.gc === undefined) throw new Error('streaming benchmark requires --expose-gc')
  // 总字符数必须能被碎片数整除，否则切片不均。
  if (characters % fragments !== 0) throw new Error('streaming characters must divide evenly into fragments')
  const chunkSize = characters / fragments
  // 按内容模式生成负载：普通文本，或前一半空白 + 后一半字符（考验前导空白处理）。
  const payload = pattern === 'ordinary'
    ? 'abcdefghijklmno '.repeat(Math.ceil(characters / 16)).slice(0, characters)
    : ' '.repeat(characters / 2) + 'abcdefghijklmno '.repeat(Math.ceil(characters / 32)).slice(0, characters / 2)
  const attemptId = LlmAttemptId('streaming-benchmark')
  // 构造一条 transient 的直播 chunk 事件。
  const live = (index: number, chunk: StreamChunk): SessionEventLikeEntry => ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq: 2 + index / (fragments + 1), time: TIME_ZERO + index,
      data: { turn: 1, step: 1, attemptId, chunk },
    },
  })
  // 把负载按碎片数切片，生成 text-delta 或 reasoning-delta 增量序列。
  const chunks: SessionEventLikeEntry[] = []
  for (let index = 0; index < fragments; index++) {
    chunks.push(live(index + 1, {
      type: blockType === 'text' ? 'text-delta' : 'reasoning-delta', index: 0,
      text: payload.slice(index * chunkSize, (index + 1) * chunkSize),
    }))
  }
  // 装配器初始窗口：回合/步骤开始 + 块开始事件。
  const assembler = new ConversationNodeAssembler(definitions, new BenchViewDefinitions())
  assembler.replaceWindow([
    entry(0, 'turn/start', { turn: 1 }),
    entry(1, 'step/start', { turn: 1, step: 1 }),
    live(0, { type: 'block-start', index: 0, blockType }),
  ], false)
  assembler.activateTarget('chat')
  globalThis.gc()
  // 记录堆基线与 CPU/墙钟计时起点。
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  const cpuStart = process.cpuUsage()
  // 依次追加全部碎片增量并刷写。
  for (const chunk of chunks) assembler.append(chunk)
  assembler.flush()
  // 读取发布后的文本。
  const text = streamingText(assembler, blockType)
  // Consuming every character includes any deferred string materialization in the endpoint.
  let checksum = 0
  for (let index = 0; index < text.length; index++) checksum += text.charCodeAt(index)
  const cpu = process.cpuUsage(cpuStart)
  const elapsedMs = performance.now() - start
  // 内容完整性校验：发布文本必须与原始负载完全一致。
  if (text !== payload) throw new Error('streaming benchmark did not publish the complete Assistant text')
  globalThis.gc()
  // GC 后的保留堆内存增量（MB）。
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
  // This read keeps the complete owner graph reachable across endpoint collection.
  if (streamingText(assembler, blockType) !== text) throw new Error('streaming benchmark lost its published Assistant text')
  // 汇总报告。
  return {
    blockType, pattern, characters: text.length, fragments, checksum,
    elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    retainedMb, maxRssMb: process.resourceUsage().maxRSS / 1024,
  }
}

// 从装配器中取出 assistant-step 节点首块文本；块缺失或类型不符即报错。
function streamingText(assembler: ConversationNodeAssembler, blockType: StreamingAssistantWorkerReport['blockType']): string {
  const node = assembler.get('chat')?.nodes.values().find((candidate): candidate is ChatNode<'assistant-step'> => candidate.kind === 'assistant-step')
  const block = node?.data.blocks[0]
  if (block?.kind !== blockType || (block.kind !== 'text' && block.kind !== 'reasoning')) {
    throw new Error('streaming benchmark did not create its Assistant block')
  }
  return block.text
}

// 断言以构建产物运行时各关键模块从真实解析地址加载。
assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-brand': import.meta.resolve('@deepseek-ai/dsh-brand'),
  '@deepseek-ai/dsh-client-store': import.meta.resolve('@deepseek-ai/dsh-client-store'),
  '@deepseek-ai/dsh-llm/assistant-stream': import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'),
  '@deepseek-ai/dsh-session/surface': import.meta.resolve('@deepseek-ai/dsh-session/surface'),
  '@deepseek-ai/dsh-token-meter/client': import.meta.resolve('@deepseek-ai/dsh-token-meter/client'),
  '@deepseek-ai/dsh-util-values': import.meta.resolve('@deepseek-ai/dsh-util-values'),
})
// 创建根 context，按命令行模式分发执行。
const scope = new Context()
try {
  const definitions = registerEventDefinitions(scope)
  // preparing 模式：测量工具参数增量发布。
  if (process.argv[2] === 'preparing') {
    const tool = process.argv[3]
    if (tool !== 'write' && tool !== 'bash') throw new Error('preparing benchmark tool must be write or bash')
    const report = preparingTool(tool, positiveInteger(process.argv[4], 'characters'), definitions)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else if (process.argv[2] === 'streaming') {
    // streaming 模式：测量直播文本块发布；校验块类型与内容模式参数。
    const blockType = process.argv[3]
    const pattern = process.argv[4]
    if (blockType !== 'text' && blockType !== 'reasoning') throw new Error('streaming block type must be text or reasoning')
    if (pattern !== 'ordinary' && pattern !== 'leading-whitespace') throw new Error('streaming pattern must be ordinary or leading-whitespace')
    const report = streamingAssistant(
      blockType, pattern, positiveInteger(process.argv[5], 'characters'),
      positiveInteger(process.argv[6], 'fragments'), definitions,
    )
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    // 默认模式（折叠）：比较小/大两个窗口的折叠耗时并计算缩放比。
    const [turnsValue, smallDeltasValue, largeDeltasValue, attemptsValue] = process.argv.slice(2)
    const turns = positiveInteger(turnsValue, 'turns')
    const smallDeltas = positiveInteger(smallDeltasValue, 'small deltas')
    const largeDeltas = positiveInteger(largeDeltasValue, 'large deltas')
    const attempts = positiveInteger(attemptsValue, 'attempts')
    // 合成两个事件数与压缩记录数相同、仅 delta 数不同的窗口。
    const small = synthesizeWindow(turns, smallDeltas)
    const large = synthesizeWindow(turns, largeDeltas)
    if (large.entries.length !== small.entries.length || large.records !== small.records) {
      throw new Error('conversation-fold workloads must have matching event and compact-record counts')
    }
    // 各取最快折叠结果。
    const smallFold = bestOf(small.entries, attempts, definitions)
    const largeFold = bestOf(large.entries, attempts, definitions)
    // 汇总报告：耗时保留 1 位小数，缩放比保留 2 位小数。
    const report: ConversationFoldWorkerReport = {
      events: large.entries.length,
      compactRecords: large.records,
      streamedDeltas: turns * (largeDeltas + Math.floor(largeDeltas / 4)),
      chatNodes: largeFold.nodes,
      smallFoldMs: Math.round(smallFold.ms * 10) / 10,
      largeFoldMs: Math.round(largeFold.ms * 10) / 10,
      scaling: Math.round((largeFold.ms / Math.max(smallFold.ms, 1)) * 100) / 100,
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
  }
} finally {
  // 无论成败都释放 context 生命周期。
  await scope.fiber.dispose()
}
