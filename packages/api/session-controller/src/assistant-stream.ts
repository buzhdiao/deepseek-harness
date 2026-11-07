// 模块说明：为重连的 Web 跟随者（follower）保留的进程本地（process-local）助手状态。
/** Process-local assistant state retained for reconnecting Web followers. */

// 助手流帧（AssistantStreamFrame）：Agent 发出的稠密流帧类型。
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
// 助手流累积器（AssistantStreamAccumulator）：把流帧折叠成快照的核心工具。
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
// SessionSeqCursor（会话序号游标）：标记帧观察时刻的持久化位置。
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
// JsonValue（JSON 值）：快照中流状态的对外类型标注。
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// 本包类型：重连基线中的尝试（attempt）与基线（baseline）形状。
import type {
  SessionAssistantStreamAttempt,
  SessionAssistantStreamBaseline,
} from './types.ts'

// 可变尝试（MutableAttempt）：正在进行的流尝试的内部记账结构。
interface MutableAttempt {
  // 尝试 id：与帧中的 attemptId 对齐。
  readonly attemptId: SessionAssistantStreamAttempt['attemptId']
  // 该尝试开始时所处会话序号游标之后的起点。
  readonly startedAfterSeq: SessionSeqCursor
  // 尝试所属的轮次（turn）编号。
  readonly turn: number
  // 尝试所属的步骤（step）编号。
  readonly step: number
  // 流累积器：折叠该尝试的全部帧。
  readonly stream: AssistantStreamAccumulator
  // 下一个期待的块（chunk）索引：保证帧按序折叠。
  nextIndex: number
}

// 空基线常量：尚无任何尝试时的初始快照（修订号为 0）。
const EMPTY_BASELINE: SessionAssistantStreamBaseline = { revision: 0 }

// 会话助手流累积器：折叠稠密的 Agent 帧，并按每个被接受的修订号（revision）
// 物化一份共享的不可变重连基线。
/**
 * Folds dense Agent frames and materializes one shared immutable reconnect
 * baseline per accepted revision.
 */
export class SessionAssistantStreamAccumulator {
  // 当前活跃尝试：仅有正在进行的流时非空。
  private activeAttempt: MutableAttempt | undefined
  // 最近被接受的修订号。
  private revision = 0
  // 已物化的快照缓存：未变化时原样返回以保持引用稳定。
  private snapshotValue: SessionAssistantStreamBaseline = EMPTY_BASELINE
  // 脏标志：状态自上次快照后是否发生了变化。
  private dirty = false

  // 折叠一帧来自当前已附着 Agent 生命周期的受信帧。
  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    // 修订号回到 1 意味着新的会话周期开始：清空旧周期残留状态。
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      // 丢弃活跃尝试并归零修订号。
      this.activeAttempt = undefined
      this.revision = 0
    }
    // 修订号不连续（发生跳变/回退）：无法增量折叠，放弃当前尝试并跳到新修订号。
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = undefined
      this.revision = frame.revision
      this.dirty = true
      return
    }
    // 正常推进：记录新的修订号。
    this.revision = frame.revision
    // 按帧类型折叠。
    switch (frame.type) {
      // start 帧：开启一个新尝试并登记其起点元数据。
      case 'start':
        this.activeAttempt = {
          // 尝试 id 取自帧。
          attemptId: frame.attemptId,
          // 起点游标：该帧观察时的最后已提交会话序号。
          startedAfterSeq: durableCursor,
          // 轮次与步骤编号。
          turn: frame.turn,
          step: frame.step,
          // 为该尝试新建流累积器。
          stream: new AssistantStreamAccumulator(),
          // 从第 0 块开始期待。
          nextIndex: 0,
        }
        break
      // chunk 帧：按序追加到活跃尝试的流中。
      case 'chunk': {
        // 取出当前活跃尝试做校验。
        const attempt = this.activeAttempt
        // 无活跃尝试、尝试 id 不匹配、或索引乱序：本帧不可折叠，作废该尝试。
        if (attempt === undefined
          || attempt.attemptId !== frame.attemptId
          || frame.index !== attempt.nextIndex) {
          this.activeAttempt = undefined
          break
        }
        // 校验通过：把时间戳与块内容推入流累积器。
        attempt.stream.push({ time: frame.time, chunk: frame.chunk })
        // 推进期待索引。
        attempt.nextIndex += 1
        break
      }
      // end 帧：尝试结束，清空活跃尝试。
      case 'end':
        this.activeAttempt = undefined
        break
    }
    // 状态已变化：标记快照为脏。
    this.dirty = true
  }

  // 读取缓存的重连基线；状态变化后重新物化。
  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): SessionAssistantStreamBaseline {
    // 未变化：直接返回缓存快照，保持引用稳定（identity-stable）。
    if (!this.dirty) return this.snapshotValue
    // 重新物化基线：修订号加上可选的活跃尝试投影。
    this.snapshotValue = {
      // 当前修订号。
      revision: this.revision,
      // 无活跃尝试时不展开任何字段；有则投影其元数据与流快照。
      ...this.activeAttempt === undefined ? {} : {
        // 活跃尝试的对外形状。
        activeAttempt: {
          // 尝试 id。
          attemptId: this.activeAttempt.attemptId,
          // 尝试起点游标。
          startedAfterSeq: this.activeAttempt.startedAfterSeq,
          // 轮次与步骤编号。
          turn: this.activeAttempt.turn,
          step: this.activeAttempt.step,
          // 下一个期待的块索引。
          nextIndex: this.activeAttempt.nextIndex,
          // 流快照：内部累积器产出经二次断言为只读 JSON 值数组。
          stream: this.activeAttempt.stream.snapshot() as unknown as readonly JsonValue[],
        },
      },
    }
    // 物化完成：清除脏标志。
    this.dirty = false
    // 返回新快照。
    return this.snapshotValue
  }
}
