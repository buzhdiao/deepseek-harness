/** Deterministic released-v0 Zstandard Session input for opening benchmarks. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { generationLogFilename } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import {
  SYNTHETIC_SESSION_CWD,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_V0_FILENAME,
} from './session-open.constants.ts'

export {
  SYNTHETIC_SESSION_CWD,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_V0_FILENAME,
} from './session-open.constants.ts'

/** Fixed workload parameters used by every Session-opening scenario. */
export interface SyntheticV0SessionShape {
  /** Completed turns, each with one user prompt and one streamed assistant reply. */
  readonly turns: number
  /** Text deltas per reply; each reply also contains one quarter as many reasoning deltas. */
  readonly textDeltas: number
}

/** Canonical current-generation filename produced by the runtime under test. */
// 被测运行时产出的当前代（current generation）规范文件名。
export const SYNTHETIC_CURRENT_FILENAME = generationLogFilename(SESSION_FORMAT_VERSION, 'zstd')
/** Report label for a fresh-process reopen of the runtime's current generation. */
// 全新进程重开当前代的报告标签。
export const SYNTHETIC_CURRENT_GENERATION = `current-v${String(SESSION_FORMAT_VERSION)}`

// 事件与创建时间的基准时间戳。
const TIME_ZERO = 1_700_000_000_000
/** One body frame per row preserves the historical many-frame workload deterministically. */
// 每帧一行：确定性地保留历史上“许多小帧”的工作负载形态。
const ROWS_PER_FRAME = 1

// released-v0 物理行的只读表示（字段随行类型而异）。
type SyntheticPhysicalRow = Readonly<Record<string, unknown>>

/** Complete metadata returned after writing one synthetic source generation. */
// 写出一个合成源代之后返回的完整元数据。
export interface SyntheticV0SessionWrite {
  // 写出的 v0 文件路径。
  readonly path: string
  // 压缩后的总字节。
  readonly compressedBytes: number
  // 解压后的逻辑字节。
  readonly logicalBytes: number
  // 逻辑事件数。
  readonly events: number
  // 物理行数。
  readonly rows: number
  // Zstandard 帧数。
  readonly frames: number
}

/** Owns the immutable released-v0 physical layout used only as benchmark input. */
class ReleasedV0FixtureBuilder {
  // 累积的物理行列表。
  readonly rows: SyntheticPhysicalRow[] = []
  // 下一个逻辑事件的序号。
  private seq = 0
  // 下一个逻辑事件的时间。
  private time = TIME_ZERO

  // 逻辑事件数等于已推进到的序号。
  get eventCount(): number {
    return this.seq
  }

  // 按工作负载形状逐轮追加事件。
  appendTurns(shape: SyntheticV0SessionShape): void {
    // 推理增量为文本增量的四分之一（向下取整）。
    const reasoningDeltas = Math.floor(shape.textDeltas / 4)
    // 从第 1 轮循环到最后一轮。
    for (let turn = 1; turn <= shape.turns; turn += 1) {
      // 追加单轮的完整事件序列。
      this.appendTurn(turn, reasoningDeltas, shape.textDeltas)
    }
  }

  private appendTurn(turn: number, reasoningDeltaCount: number, textDeltaCount: number): void {
    // 追加轮开始事件。
    this.appendEvent('turn/start', { turn })
    // 追加第 1 步开始事件。
    this.appendEvent('step/start', { turn, step: 1 })
    // 追加该轮的用户提示消息。
    this.appendEvent('user/message', {
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // 记录推理块开始分块的序号（助手消息稍后引用）。
    const firstChunkSeq = this.appendChunk(turn, { type: 'block-start', index: 0, blockType: 'reasoning' })
    // 生成本轮的推理增量文本列表。
    const reasoningDeltas = Array.from(
      { length: reasoningDeltaCount },
      (_, index) => `r${String(index)} `,
    )
    // 追加推理增量分块。
    this.appendDeltas('reasoning', turn, 0, reasoningDeltas)
    // 拼接完整推理文本。
    const reasoning = reasoningDeltas.join('')
    // 追加推理块结束分块。
    this.appendChunk(turn, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    // 追加文本块开始分块。
    this.appendChunk(turn, { type: 'block-start', index: 1, blockType: 'text' })
    // 生成本轮的文本增量列表。
    const textDeltas = Array.from(
      { length: textDeltaCount },
      (_, index) => `w${String(index)} `,
    )
    // 追加文本增量分块。
    this.appendDeltas('text', turn, 1, textDeltas)
    // 拼接完整文本。
    const text = textDeltas.join('')
    // 追加文本块结束分块。
    this.appendChunk(turn, { type: 'block-end', index: 1, block: { type: 'text', text } })
    // 用量：输入固定 100，输出等于文本增量数。
    const usage = { inputTokens: 100, outputTokens: textDeltaCount }
    // 追加用量分块。
    this.appendChunk(turn, { type: 'usage', usage })
    // 记录结束分块的序号。
    const lastChunkSeq = this.appendChunk(turn, { type: 'finish', reason: { kind: 'stop' } })
    // 追加助手消息事件（内容与流式分块对应，引用块起止序号）。
    this.appendEvent('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
    }, { sourceEventSeqs: [[firstChunkSeq, lastChunkSeq]], surfaceOp: 'append' })
    // 追加步骤结束事件。
    this.appendEvent('step/end', { turn, step: 1 })
    // 追加轮结束事件（正常完成）。
    this.appendEvent('turn/end', { turn, reason: { kind: 'completed' } })
  }

  private appendChunk(turn: number, chunk: unknown): number {
    // 分块以 assistant/chunk 事件形式追加并返回其序号。
    return this.appendEvent('assistant/chunk', { turn, step: 1, chunk })
  }

  private appendDeltas(
    kind: 'reasoning' | 'text',
    turn: number,
    index: number,
    deltas: readonly string[],
  ): void {
    // 少于 3 个增量时逐个写普通行（合并行格式至少需要 3 个）。
    if (deltas.length < 3) {
      // 逐个追加增量分块。
      for (const delta of deltas) {
        this.appendChunk(turn, {
          type: `${kind}-delta`,
          index,
          text: delta,
        })
      }
      // 处理完毕返回。
      return
    }
    // 3 个及以上增量合并为一行紧凑的 chunks 行（released-v0 的合并行格式）。
    this.rows.push({
      type: `${kind}-chunks`,
      seq0: this.seq,
      time0: this.time,
      data: {
        turn,
        step: 1,
        index,
        dt: Array.from({ length: deltas.length - 1 }, () => 1),
        texts: deltas,
      },
    })
    // 序号按增量个数推进（一行代表多个逻辑事件）。
    this.seq += deltas.length
    // 时间同样按增量个数推进。
    this.time += deltas.length
  }

  private appendEvent(
    type: string,
    data: unknown,
    extra: Readonly<Record<string, unknown>> = {},
  ): number {
    // 记录本事件的序号。
    const seq = this.seq
    // 追加一行物理事件（合并 extra 附加字段）。
    this.rows.push({ type, seq, time: this.time, data, ...extra })
    // 序号推进 1。
    this.seq += 1
    // 时间推进 1（每事件 1 个时间单位）。
    this.time += 1
    // 返回事件序号。
    return seq
  }
}

/**
 * Write one deterministic released-v0 Zstandard generation.
 * @param root - JSONL persistence root.
 * @param shape - workload size.
 * @returns physical and logical workload facts.
 */
export async function writeSyntheticReleasedV0Session(
  root: string,
  shape: SyntheticV0SessionShape,
): Promise<SyntheticV0SessionWrite> {
  // 创建物理行构建器。
  const fixture = new ReleasedV0FixtureBuilder()
  // 按形状生成全部轮次的事件行。
  fixture.appendTurns(shape)
  // released-v0 格式的会话头（version 0）。
  const header = {
    type: 'session',
    version: 0,
    id: SYNTHETIC_SESSION_ID,
    createdAt: TIME_ZERO,
    cwd: SYNTHETIC_SESSION_CWD,
    delegationDepth: 0,
  }
  // 头行文本（JSONL 一行）。
  const headerLine = `${JSON.stringify(header)}\n`
  // 正文各帧的缓冲列表。
  const bodyFrames: Buffer[] = []
  // 逻辑字节数从头行开始累计。
  let logicalBytes = Buffer.byteLength(headerLine)
  // 按每帧行数切片逐帧压缩。
  for (let index = 0; index < fixture.rows.length; index += ROWS_PER_FRAME) {
    // 取本帧包含的行。
    const rows = fixture.rows.slice(index, index + ROWS_PER_FRAME)
    // 把行序列化为 JSONL 文本。
    const text = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    // 累计逻辑字节。
    logicalBytes += Buffer.byteLength(text)
    // 压缩本帧并收集。
    bodyFrames.push(await compressZstdFrame(text))
  }
  // 物理文件 = 独立压缩的头帧 + 全部正文帧。
  const physical = Buffer.concat([
    await compressZstdFrame(headerLine),
    ...bodyFrames,
  ])
  // 计算会话存储目录（由 cwd 与会话 id 推导）。
  const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
  // 确保目录存在。
  await mkdir(directory, { recursive: true })
  // 计算目标文件路径。
  const path = join(directory, SYNTHETIC_V0_FILENAME)
  // 写出 v0 生成文件。
  await writeFile(path, physical)
  // 返回工作负载的物理与逻辑事实。
  return {
    path,
    compressedBytes: physical.byteLength,
    logicalBytes,
    events: fixture.eventCount,
    rows: fixture.rows.length,
    frames: fixture.rows.length + 1,
  }
}
