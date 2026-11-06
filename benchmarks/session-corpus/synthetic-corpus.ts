/** Deterministic current-generation Session corpus whose length distribution follows `corpus-shape.ts`. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  eventLines,
  generationLogPath,
  toHeaderLine,
} from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { anchorShape, sessionShape, type SessionShape } from './corpus-shape.ts'

/** Time of every body's first event; Sessions are created in the preceding minutes. */
// 所有正文首个事件的时间基准；各会话的创建时间在此之前的若干分钟内。
const TIME_ZERO = 1_700_000_000_000
/** Prime stride that permutes creation order independently of length rank. */
// 素数步长：把创建顺序按长度秩做置换，使创建时间与长度排序互不相关。
const CREATION_STRIDE = 7_919
/** Concurrent frame compressions and file writes while materializing a corpus. */
// 物化语料时并发执行帧压缩与文件写入的数量。
const IO_CONCURRENCY = 8
/** Measured local Sessions per project directory: 1,650 Sessions in 88 directories. */
// 每个项目目录存放的会话数（实测场景：88 个目录共 1,650 个会话）。
const SESSIONS_PER_PROJECT = 19
/** Every sixth Session is a subagent child; the measured share is 288 of 1,650. */
// 每第 6 个会话是子代理（subagent）子会话；实测占比 288/1,650。
const CHILD_EVERY = 6
/** Turn-one system prompt size; the measured median largest event is 21.9 KB. */
// 首轮系统提示词的字符数；实测中位最大事件约 21.9 KB。
const SYSTEM_PROMPT_CHARS = 20_000
/** Characters per streamed text or reasoning delta; the measured mean is 3.9. */
// 每个流式文本/推理增量（delta）的字符数；实测均值 3.9。
const DELTA_CHARS = 4
/** Share of remaining payload characters by message slot. */
// 各消息槽位分得的剩余负载字符比例。
const PAYLOAD_SHARE = { user: 0.1, reasoning: 0.2, text: 0.25, toolResult: 0.45 } as const
/** Distinct words in the synthetic vocabulary and total words in the shared text pool. */
// 合成词表的单词数与共享文本池的总词数。
const VOCABULARY = { words: 8_192, poolWords: 2_000_000 } as const
/** Word ranks used by the measured searches: one frequent and one uncommon token. */
// 测量搜索使用的词秩：一个高频词与一个不常见词（函数声明提升，可在定义前调用）。
export const SEARCH_QUERIES = [vocabularyWord(40), vocabularyWord(1_500)] as const

/** Physical and logical facts of one written corpus. */
export interface SyntheticCorpusFacts {
  /** Logical Sessions. */
  readonly sessions: number
  /** Distinct event bodies; Sessions of one anchor share one body. */
  readonly distinctBodies: number
  /** Project directories. */
  readonly projects: number
  /** Logical events across all Sessions. */
  readonly events: number
  /** Decompressed JSONL bytes across all Sessions. */
  readonly logicalBytes: number
  /** Stored Zstandard bytes across all Sessions. */
  readonly compressedBytes: number
  /** Zstandard frames across all Sessions. */
  readonly frames: number
}

/** One written Session. */
export interface WrittenSession {
  /** Stored header. */
  readonly header: SessionHeader
  /** Measured anchor whose body the Session stores. */
  readonly anchor: number
}

/**
 * Identify one Session by length rank.
 * @param rank - zero-based ascending length rank.
 * @returns stable Session id.
 */
export function corpusSessionId(rank: number): SessionId {
  // 用 bench- 前缀加五位补零秩号构造稳定的会话 id。
  return SessionId('bench-' + String(rank).padStart(5, '0'))
}

// 把词秩确定性地映射为一个合成单词（基于固定字母频率表的变体进制编码）。
function vocabularyWord(rank: number): string {
  // 加上词表大小避免 0 值（0 无法产生任何字母）。
  let value = rank + VOCABULARY.words
  // 逐位拼接出的单词。
  let word = ''
  // 按英文常用字母频率排序的字母表。
  const letters = 'etaoinsrhdlucmfywgpbvkxqjz'
  // 逐位取出 value 在字母表进制下的“数字”。
  while (value > 0) {
    // 取模得到当前位对应的字母。
    word += letters[value % letters.length]
    // 整除推进到下一位。
    value = Math.floor(value / letters.length)
  }
  // 返回合成词。
  return word
}

/** Mulberry32: a small deterministic generator for fixture construction only. */
// Mulberry32 伪随机数生成器：仅用于夹具构造的确定性随机源。
function random(seed: number): () => number {
  // 用初始种子初始化内部状态（无符号 32 位）。
  let state = seed >>> 0
  // 返回生成函数：每次调用推进状态并产出 [0,1) 的数。
  return () => {
    // 状态按黄金比例常数递增（Mulberry32 的核心步进）。
    state = (state + 0x6D2B79F5) >>> 0
    // 取当前状态副本参与混淆。
    let value = state
    // 三轮位运算混淆（imul 为 32 位整数乘法），保证输出统计质量。
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    // 混淆后再异或高位并归一化到 [0,1)。
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Zipf-distributed prose from which every message body takes a deterministic slice. */
// Zipf 分布的散文文本池：每条消息正文都从它截取确定性的片段。
class TextPool {
  // 完整的共享文本（构造时一次性生成）。
  private readonly text: string

  constructor() {
    // 用固定种子 1 创建词序随机源。
    const next = random(1)
    // 词秩的累积 Zipf 权重表。
    const cumulative: number[] = []
    // 累积权重总和。
    let total = 0
    // 为每个词秩累加 1/rank（Zipf 权重）。
    for (let rank = 1; rank <= VOCABULARY.words; rank++) {
      // 累加当前词的权重。
      total += 1 / rank
      // 记录累积权重上界。
      cumulative.push(total)
    }
    // 按秩生成全部词表单词。
    const words = Array.from({ length: VOCABULARY.words }, (_, rank) => vocabularyWord(rank))
    // 文本池片段列表（词与分隔符交替）。
    const parts: string[] = []
    // 按池总词数逐词填充文本池。
    for (let index = 0; index < VOCABULARY.poolWords; index++) {
      // 在 [0,total) 上取一个随机目标权重。
      const target = next() * total
      // 二分查找的下界。
      let low = 0
      // 二分查找的上界。
      let high = cumulative.length - 1
      // 在累积权重表中定位目标词的秩。
      while (low < high) {
        // 取中点。
        const middle = (low + high) >>> 1
        // 目标落在右半区则收窄下界。
        if ((cumulative[middle] as number) < target) low = middle + 1
        // 否则收窄上界。
        else high = middle
      }
      // 追加选中的词；每 13 个词用“句号+换行”分隔一次，其余用空格。
      parts.push(words[low] as string, index % 13 === 12 ? '.\n' : ' ')
    }
    // 拼接成完整文本池。
    this.text = parts.join('')
  }

  // 从文本池按随机起点截取指定长度的片段。
  slice(next: () => number, length: number): string {
    // 非正长度直接返回空串。
    if (length <= 0) return ''
    // 截取长度不超过文本池本身。
    const span = Math.min(length, this.text.length)
    // 随机选择起点，保证 start+span 不越界。
    const start = Math.floor(next() * (this.text.length - span))
    // 返回该片段。
    return this.text.slice(start, start + span)
  }
}

// 各消息槽位的负载字符分配计划。
interface PayloadPlan {
  // 用户消息总字符数。
  readonly userChars: number
  // 推理块总字符数。
  readonly reasoningChars: number
  // 助手文本总字符数。
  readonly textChars: number
  // 工具结果总字符数。
  readonly resultChars: number
}

// 把负载字符预算按槽位比例分配到各消息类型。
function planPayload(shape: SessionShape, toolSteps: number, payloadChars: number): PayloadPlan {
  // 回复次数 = 工具步数 + 轮次数（推理/文本按它均摊）。
  const replies = toolSteps + shape.turns
  // 无工具步时把工具结果的份额并入助手文本。
  const textShare = toolSteps === 0 ? PAYLOAD_SHARE.text + PAYLOAD_SHARE.toolResult : PAYLOAD_SHARE.text
  // 按轮次/回复数向上取整分配各槽位字符。
  return {
    userChars: Math.ceil((payloadChars * PAYLOAD_SHARE.user) / shape.turns),
    reasoningChars: Math.ceil((payloadChars * PAYLOAD_SHARE.reasoning) / replies),
    textChars: Math.ceil((payloadChars * textShare) / replies),
    resultChars: toolSteps === 0 ? 0 : Math.ceil((payloadChars * PAYLOAD_SHARE.toolResult) / toolSteps),
  }
}

// 把内容块序列展开为模拟模型流式输出的分块（chunk）序列。
function streamChunks(content: readonly ContentBlock[], finish: 'stop' | 'tool-calls'): StreamChunk[] {
  // 收集全部分块。
  const chunks: StreamChunk[] = []
  // 逐块展开每个内容块。
  content.forEach((block, index) => {
    // 推入块开始标记。
    chunks.push({ type: 'block-start', index, blockType: block.type })
    // 文本/推理块按固定字符数切分成增量分块。
    if (block.type === 'text' || block.type === 'reasoning') {
      // 依据块类型选择增量分块类型。
      const type = block.type === 'text' ? 'text-delta' : 'reasoning-delta'
      // 按增量字符数滑动切片。
      for (let offset = 0; offset < block.text.length; offset += DELTA_CHARS) {
        // 推入一个增量分块。
        chunks.push({ type, index, text: block.text.slice(offset, offset + DELTA_CHARS) })
      }
    } else if (block.type === 'tool-call') {
      // 工具调用块整体作为一个增量分块（一次性给出完整参数）。
      chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
    }
    // 推入块结束标记。
    chunks.push({ type: 'block-end', index, block })
  })
  // 追加用量分块（固定的输入/输出令牌数）。
  chunks.push({ type: 'usage', usage: { inputTokens: 20_000, outputTokens: 500 } })
  // 追加结束分块（停止原因由 finish 参数决定）。
  chunks.push({ type: 'finish', reason: { kind: finish } })
  // 返回完整分块序列。
  return chunks
}

/** Raw log builder emitting the fields `Session.append` records, without its per-append validation. */
// 原始日志构建器：产出与 Session.append 相同的字段，但跳过其逐条校验。
class RawLog {
  // 累积的原始事件列表。
  readonly events: SessionEvent[] = []
  // 帧起始事件序号集合（每个序号开启一个新的持久化批次）。
  readonly frameStarts = new Set<number>()

  // 记录会话创建时间（事件时间按序号线性递增）。
  constructor(private readonly createdAt: number) {}

  // 事件序号等于已累积的事件数。
  get seq(): number {
    return this.events.length
  }

  /** Start a durable flush batch at the next event. */
  // 在下一个事件处开启一个新的持久化帧。
  flush(): void {
    // 把下一个事件的序号记为帧起点。
    this.frameStarts.add(this.events.length)
  }

  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    surface: { readonly surfaceOp?: 'append'; readonly sourceEventSeqs?: readonly number[] } = {},
  ): number {
    // 以当前事件数作为新事件的序号。
    const seq = this.events.length
    // 追加事件：时间 = 创建时间 + 序号×1ms，并合并 surface 附加字段。
    this.events.push({ type, seq, time: this.createdAt + seq * 1_000, data, ...surface } as SessionEvent<T>)
    // 返回新事件的序号。
    return seq
  }
}

/** Authors one Session with production stream compaction; replay validation belongs to the fixture test. */
// 撰写一个会话的事件日志（使用与生产一致的流式压缩）；回放验证由夹具测试负责。
function authorEvents(
  shape: SessionShape,
  payloadChars: number,
  pool: TextPool,
  seed: number,
): { readonly events: SessionEvent[]; readonly frameStarts: ReadonlySet<number> } {
  // 用事件种子创建确定性随机源。
  const next = random(seed)
  // 需要的工具步数：总事件数减去每轮 6 个固定事件与收尾事件后按每步 5 个事件折算。
  const toolSteps = Math.max(0, Math.ceil((shape.events - 6 * shape.turns - 1) / 5))
  // 计算各槽位的负载字符分配。
  const plan = planPayload(shape, toolSteps, payloadChars)
  // 从时间基准开始构建原始日志。
  const log = new RawLog(TIME_ZERO)
  // 逐轮撰写事件。
  for (let turn = 1; turn <= shape.turns; turn++) {
    // 本轮分得的工具步数（余数轮依次多 1 步）。
    const turnSteps = Math.floor(toolSteps / shape.turns) + (turn <= toolSteps % shape.turns ? 1 : 0)
    // 开启新的持久化帧（轮边界即帧边界）。
    log.flush()
    // 追加轮开始事件。
    log.append('turn/start', { turn })
    // 追加第 1 步开始事件。
    log.append('step/start', { turn, step: 1 })
    // 仅首轮写入约 20k 字符的系统提示词消息（取自文本池切片）。
    if (turn === 1) log.append('system/message', {
      turn, step: 1,
      message: {
        id: MessageId('system-head'), role: 'system',
        content: [{ type: 'text', text: pool.slice(next, SYSTEM_PROMPT_CHARS) }],
        source: { kind: 'system-prompt' },
      },
    }, { surfaceOp: 'append' })
    // 追加用户提示消息（按计划分配的字符数取池切片）。
    log.append('user/message', {
      id: MessageId('prompt-' + String(turn)), role: 'user',
      content: [{ type: 'text', text: pool.slice(next, plan.userChars) }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // 本轮各步：前 turnSteps 步带工具调用，最后一步为纯回复。
    for (let step = 1; step <= turnSteps + 1; step++) {
      // 非首步需要新的步骤开始事件。
      if (step > 1) log.append('step/start', { turn, step })
      // 前 turnSteps 步生成工具调用 id，最后一步无调用。
      const callId = step <= turnSteps ? ToolCallId(`call-${String(turn)}-${String(step)}`) : undefined
      // 本步助手消息的内容块：推理、文本、可选的工具调用。
      const content: ContentBlock[] = [
        { type: 'reasoning', text: pool.slice(next, plan.reasoningChars) },
        { type: 'text', text: pool.slice(next, plan.textChars) },
        ...callId === undefined ? [] : [{
          type: 'tool-call' as const, id: callId, name: 'read_file',
          arguments: JSON.stringify({ path: `src/module-${String(turn)}-${String(step)}.ts` }),
        }],
      ]
      // 创建流式累加器（与生产相同的压缩逻辑）。
      const stream = new AssistantStreamAccumulator()
      // 本助手消息的起始时间（按当前序号推算）。
      const time = TIME_ZERO + log.seq * 1_000
      // 依次把每个分块推入累加器（时间逐个递增 1ms）。
      for (const [index, chunk] of streamChunks(content, callId === undefined ? 'stop' : 'tool-calls').entries()) {
        // 推入单个分块。
        stream.push({ time: time + index, chunk })
      }
      // 开启新的持久化帧（助手消息独占一帧）。
      log.flush()
      // 追加助手消息事件（携带快照后的流式分块）。
      log.append('assistant/message', {
        turn, step,
        message: {
          id: MessageId(`reply-${String(turn)}-${String(step)}`), role: 'assistant', content,
          source: { kind: 'model', provider: 'bench', model: 'bench' },
        },
        stream: [...stream.snapshot()],
      }, { surfaceOp: 'append' })
      // 有工具调用时追加调用/结果事件对。
      if (callId !== undefined) {
        // 开启新帧（工具调用开始）。
        log.flush()
        // 追加工具调用事件并记录其序号。
        const callSeq = log.append('tool/call', {
          turn, step, callId, name: 'read_file', arguments: JSON.stringify({ path: `src/module-${String(turn)}-${String(step)}.ts` }),
        })
        // 开启新帧（工具结果开始）。
        log.flush()
        // 追加工具结果事件，并通过 sourceEventSeqs 引用调用事件。
        log.append('tool/result', {
          turn, step,
          message: {
            id: MessageId('result-' + callId), role: 'tool', toolCallId: callId, isError: false,
            source: { kind: 'tool', callId },
            content: [{ type: 'text', text: pool.slice(next, plan.resultChars) }],
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
      }
      // 追加本步结束事件。
      log.append('step/end', { turn, step })
    }
    // 追加本轮结束事件（正常完成）。
    log.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // 返回事件列表与帧起点集合。
  return { events: log.events, frameStarts: log.frameStarts }
}

// 把事件列表按帧起点切分成多个 JSONL 帧文本。
function frameTexts(events: readonly SessionEvent[], frameStarts: ReadonlySet<number>): string[] {
  // 收集各帧文本。
  const frames: string[] = []
  // 当前帧的起始序号。
  let start = 0
  // 扫描到每个帧边界时切出一帧。
  for (let index = 1; index <= events.length; index++) {
    // 到达末尾或遇到帧起点即切帧。
    if (index === events.length || frameStarts.has(index)) {
      // 把 [start,index) 的事件序列化为 JSONL 文本并补换行。
      frames.push(eventLines(events.slice(start, index)) + '\n')
      // 下一帧从当前位置开始。
      start = index
    }
  }
  // 返回全部帧文本。
  return frames
}

function headerLine(header: SessionHeader): string {
  // 把会话头序列化为一行 JSONL 文本（含换行）。
  return JSON.stringify(toHeaderLine(header)) + '\n'
}

/** Size facts of one anchor body, saved beside its compressed frames. */
// 一个锚点正文的尺寸事实（与其压缩帧一起保存）。
export interface AnchorBodyFacts {
  // 压缩帧数。
  readonly frameCount: number
  // 事件数。
  readonly events: number
  // 解压后的逻辑字节数。
  readonly logicalBytes: number
}

/** One compressed event body shared by every Session of one measured anchor. */
// 一个被测锚点的压缩正文：由该锚点下的所有会话共享。
interface AnchorBody extends AnchorBodyFacts {
  // 全部压缩帧拼接后的字节缓冲。
  readonly frames: Buffer
}

/** One corpus written from authored anchor bodies. */
export interface WrittenCorpus {
  /** Physical and logical totals. */
  readonly facts: SyntheticCorpusFacts
  /** Every stored Session in rank order. */
  readonly sessions: readonly WrittenSession[]
}

/**
 * Tell whether one corpus rank stores a subagent child.
 * @param rank - zero-based ascending length rank.
 * @returns whether the rank is a child of the preceding rank.
 */
export function subagentRank(rank: number): boolean {
  // 每 6 个秩中的最后一个（秩号对 6 取模为 5）是前一个秩的子代理子会话。
  return rank % CHILD_EVERY === CHILD_EVERY - 1
}

/**
 * Build the stored header of one corpus rank.
 * @param rank - zero-based ascending length rank.
 * @param count - corpus size.
 * @returns the rank's header; every sixth rank is a subagent child of the preceding rank.
 */
export function corpusHeader(rank: number, count: number): SessionHeader {
  // 语料数量必须与创建步长互质，否则置换会产生重复的创建时间。
  if (count % CREATION_STRIDE === 0) throw new Error('corpus size must be coprime with the creation stride')
  // 判断该秩是否为子代理子会话。
  const child = subagentRank(rank)
  // Creation time is a fixed permutation of length rank. List order follows each body's last prompt time,
  // which Sessions sharing an anchor also share.
  // 创建时间 = 基准时间 −（秩×步长 对 count 取模 + 1）分钟：它是长度秩的固定置换。
  const createdAt = TIME_ZERO - (((rank * CREATION_STRIDE) % count) + 1) * 60_000
  // 组装存储头：版本、id、创建时间、按秩分布的项目目录与子代理标记。
  return {
    version: SESSION_FORMAT_VERSION,
    id: corpusSessionId(rank),
    createdAt,
    cwd: `/bench/project-${String(rank % Math.ceil(count / SESSIONS_PER_PROJECT))}`,
    isSeeded: false,
    ...child
      ? { origin: 'subagent' as const, parentSession: corpusSessionId(rank - 1), delegationDepth: 1 }
      : { delegationDepth: 0 },
  }
}

/**
 * Build the header under which one anchor's projections are folded before identity rebinding.
 * @param anchor - measured anchor index.
 * @returns a top-level header outside every corpus.
 */
export function anchorHeader(anchor: number): SessionHeader {
  // 组装锚点专用头：独立 id 前缀与 /bench/anchors 目录，不与任何语料会话重叠。
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(`bench-anchor-${String(anchor).padStart(2, '0')}`),
    createdAt: TIME_ZERO - 60_000,
    cwd: '/bench/anchors',
    isSeeded: false,
    delegationDepth: 0,
  }
}

function anchorBodyPath(directory: string, anchor: number): string {
  // 计算锚点正文压缩帧文件的保存路径（anchor-NN.zst）。
  return join(directory, `anchor-${String(anchor).padStart(2, '0')}.zst`)
}

/**
 * Run one asynchronous compression or file operation per index with bounded concurrency.
 * @param count - number of indexes, starting at zero.
 * @param operation - operation for one index.
 */
export async function forEachConcurrently(count: number, operation: (index: number) => Promise<void>): Promise<void> {
  // 共享的下一个待处理索引。
  let next = 0
  // 每个工人（worker）循环领取下一个索引并执行，直到超出总数。
  const worker = async (): Promise<void> => {
    // 先领取（next++ 返回领取到的索引）再判断是否越界。
    for (let index = next++; index < count; index = next++) await operation(index)
  }
  // 启动固定数量的工人并发消化全部索引。
  await Promise.all(Array.from({ length: IO_CONCURRENCY }, () => worker()))
}

/** Authors each anchor body once, exchanges bodies between seeding processes, and writes corpora that share them. */
// 每个锚点正文只撰写一次，在播种进程之间交换正文，并写出共享正文的语料库。
export class SyntheticCorpusWriter {
  // 惰性创建的共享文本池（首次撰写时构建一次）。
  private pool: TextPool | undefined
  // 已撰写/已载入的锚点正文（锚点号 → 正文）。
  private readonly bodies = new Map<number, AnchorBody>()
  /** Stored-byte model from the previous anchor: fixed system prompt, bytes per event, and bytes per payload character. */
  // 上一锚点标定出的存储字节模型：每事件固定字节与每负载字符字节。
  private model = { bytesPerEvent: 0, bytesPerChar: 4 }

  /**
   * Author one anchor's body; its body bytes alone reach the anchor's logical-byte target.
   * @param anchor - measured anchor index.
   * @returns the authored events, which the writer does not retain.
   */
  async author(anchor: number): Promise<readonly SessionEvent[]> {
    // 取该锚点的目标形状（事件数与逻辑字节目标）。
    const shape = anchorShape(anchor)
    // Start from the previous anchor's model, then take secant steps from below.
    // 取出上一锚点标定的模型参数。
    const { bytesPerEvent, bytesPerChar } = this.model
    // 用模型估算初始负载字符数（向上取整，1.01 为安全裕度）。
    let payloadChars = Math.max(0, Math.ceil(
      (1.01 * (shape.logicalBytes - SYSTEM_PROMPT_CHARS - bytesPerEvent * shape.events)) / bytesPerChar,
    ))
    // 记录上一次试探的（负载字符数, 实际字节），用于割线法标定。
    let previous: { readonly payloadChars: number; readonly bytes: number } | undefined
    // 最多尝试 8 次割线步进，直到达到逻辑字节目标。
    for (let attempt = 0; attempt < 8; attempt++) {
      // 首次尝试时构建共享文本池。
      this.pool ??= new TextPool()
      // 以当前负载规模撰写事件。
      const authored = authorEvents(shape, payloadChars, this.pool, anchor + 1)
      // 撰写出的事件数必须达到形状要求（负载大小不能改变事件结构）。
      if (authored.events.length < shape.events) {
        throw new Error(`corpus anchor ${String(anchor)} authored ${String(authored.events.length)} of ${String(shape.events)} events`)
      }
      // 把事件切分成帧文本。
      const frames = frameTexts(authored.events, authored.frameStarts)
      // 统计全部帧的逻辑字节总数。
      const bytes = frames.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
      // 有前一次试探时用割线斜率更新每字符字节模型。
      if (previous !== undefined && payloadChars > previous.payloadChars) {
        this.model.bytesPerChar = (bytes - previous.bytes) / (payloadChars - previous.payloadChars)
      }
      // 用残差更新每事件固定字节模型。
      this.model.bytesPerEvent = (bytes - SYSTEM_PROMPT_CHARS - this.model.bytesPerChar * payloadChars) / authored.events.length
      // 尚未达到目标字节：记录本次试探并放大负载后重试。
      if (bytes < shape.logicalBytes) {
        // 保存本次试探结果。
        previous = { payloadChars, bytes }
        // Every message rounds its share up, so each step adds at least one character per event.
        // 按标定斜率放大负载（额外加每事件 1 字符的裕度，保证单调推进）。
        payloadChars += Math.ceil((1.01 * (shape.logicalBytes - bytes)) / this.model.bytesPerChar) + shape.events
        // 进入下一次尝试。
        continue
      }
      // Each pending compression owns a native Zstandard context, so compression is bounded like writes.
      // 收集各帧的压缩结果。
      const compressed: Buffer[] = []
      // 并发压缩全部帧（与写入一样限流，避免过多本地 Zstandard 上下文）。
      await forEachConcurrently(frames.length, async (index) => {
        // 压缩单个帧文本。
        compressed[index] = await compressZstdFrame(frames[index] as string)
      })
      // 把该锚点正文（拼接帧与尺寸事实）登记到正文表。
      this.bodies.set(anchor, {
        frames: Buffer.concat(compressed), frameCount: frames.length, events: authored.events.length, logicalBytes: bytes,
      })
      // 返回撰写的事件（调用方不保留引用）。
      return authored.events
    }
    // 8 次尝试仍未达标即失败。
    throw new Error(`corpus anchor ${String(anchor)} did not reach ${String(shape.logicalBytes)} logical bytes`)
  }

  /**
   * Save one authored body's compressed frames for another process.
   * @param directory - body directory shared by the seeding processes.
   * @param anchor - authored anchor index.
   * @returns the body's size facts.
   */
  async saveBody(directory: string, anchor: number): Promise<AnchorBodyFacts> {
    // 取出已撰写的正文。
    const body = this.bodies.get(anchor)
    // 未撰写过该锚点即失败。
    if (body === undefined) throw new Error(`corpus anchor ${String(anchor)} was not authored`)
    // 确保正文目录存在。
    await mkdir(directory, { recursive: true })
    // 把压缩帧写到共享目录，供其他播种进程读取。
    await writeFile(anchorBodyPath(directory, anchor), body.frames)
    // 返回正文的尺寸事实。
    return { frameCount: body.frameCount, events: body.events, logicalBytes: body.logicalBytes }
  }

  /**
   * Load one body saved by another process.
   * @param directory - body directory shared by the seeding processes.
   * @param anchor - anchor index.
   * @param facts - size facts recorded with the body.
   */
  async loadBody(directory: string, anchor: number, facts: AnchorBodyFacts): Promise<void> {
    // 从共享目录读入正文压缩帧，并与尺寸事实一起登记。
    this.bodies.set(anchor, { ...facts, frames: await readFile(anchorBodyPath(directory, anchor)) })
  }

  /**
   * Write every rank of one corpus from authored bodies.
   * @param root - JSONL persistence root.
   * @param count - corpus size; the length distribution is sampled at this many ranks.
   * @returns totals and the stored headers.
   */
  async writeCorpus(root: string, count: number): Promise<WrittenCorpus> {
    // 各类物理/逻辑总量累加器。
    const totals = { events: 0, logicalBytes: 0, compressedBytes: 0, frames: 0 }
    // 按秩收集已写出的会话。
    const sessions: WrittenSession[] = []
    // 并发写出全部秩。
    await forEachConcurrently(count, async (rank) => {
      // 取该秩采样的锚点（长度分布由 corpus-shape 决定）。
      const { anchor } = sessionShape(rank, count)
      // 取该锚点的共享正文。
      const body = this.bodies.get(anchor)
      // 正文缺失即失败。
      if (body === undefined) throw new Error(`corpus anchor ${String(anchor)} was not authored`)
      // 构建该秩的存储头。
      const header = corpusHeader(rank, count)
      // 头序列化为一行 JSONL。
      const line = headerLine(header)
      // 物理文件 = 独立压缩的头帧 + 共享正文帧。
      const physical = Buffer.concat([await compressZstdFrame(line), body.frames])
      // 计算生成日志的落盘路径（按 cwd 与会话 id 分目录）。
      const path = generationLogPath(root, header.cwd, header.id, SESSION_FORMAT_VERSION, 'zstd')
      // 确保目录存在。
      await mkdir(dirname(path), { recursive: true })
      // 写出物理文件。
      await writeFile(path, physical)
      // 按秩登记已写会话。
      sessions[rank] = { header, anchor }
      // 累加事件数。
      totals.events += body.events
      // 累加逻辑字节（头行 + 正文）。
      totals.logicalBytes += Buffer.byteLength(line) + body.logicalBytes
      // 累加压缩字节。
      totals.compressedBytes += physical.byteLength
      // 累加帧数（正文帧 + 1 个头帧）。
      totals.frames += body.frameCount + 1
    })
    // 汇总语料事实与全部会话。
    return {
      facts: {
        sessions: count,
        projects: Math.ceil(count / SESSIONS_PER_PROJECT),
        distinctBodies: new Set(sessions.map(session => session.anchor)).size,
        ...totals,
      },
      sessions,
    }
  }
}
