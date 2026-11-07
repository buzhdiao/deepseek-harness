// Web 呈现折叠器（fold）：把临时 Assistant 帧归并到一次持久 v2 结算上。
/** Web presentation fold joining transient Assistant frames to one durable v2 settlement. */

import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../../types.ts'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type {
  SessionAssistantSettlementEntry,
  SessionEventLikeEntry,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from '../contract/events.ts'

// 正在进行的尝试（attempt）：重建临时行所需的全部游标信息。
interface ActiveAttempt {
  readonly attemptId: LlmAttemptId
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

// Assistant 流折叠产出的一次 Web 发布决策。
/** One Web publication decision from the assistant stream fold. */
export type ClientAssistantStreamResult =
  // publish：发布一条实时持久条目（可在其 Step 结束后附带退休该尝试的临时行）。
  | {
    readonly type: 'publish'
    readonly entry: SessionLiveEventEntry
    // 成功尝试的临时行在其 Step 结束发布后退休。
    /** Retire the successful attempt's transient rows after publishing its Step end. */
    readonly retireAttemptId?: LlmAttemptId
  }
  // settlement：发布该尝试的持久结算条目（原子替换其临时行）。
  | {
    readonly type: 'settlement'
    readonly attemptId: LlmAttemptId
    readonly entry: SessionAssistantSettlementEntry
  }
  // abandonment：尝试被放弃，直接清理临时行。
  | { readonly type: 'abandonment'; readonly attemptId: LlmAttemptId }
  // transient：发布一条临时实时分块行。
  | { readonly type: 'transient'; readonly entry: SessionTransientEventEntry }
  // rebaseline：折叠状态与流不一致，需要整体重建基线。
  | { readonly type: 'rebaseline' }
  | undefined

// 把临时 Assistant 呈现收拢在一个具备结算意识（settlement-aware）的接口之后。
/** Keeps transient Assistant presentation behind one settlement-aware interface. */
export class ClientAssistantStream {
  // 当前正在进行的尝试（重建临时行的游标）。
  private activeAttempt: ActiveAttempt | undefined
  // 已成功发布、等待其 Step 结束以退休临时行的尝试。
  private retainedAttempt: Pick<ActiveAttempt, 'attemptId' | 'turn' | 'step'> | undefined
  // 已跟随到、等待流 end 帧确认的持久结算（按 seq）。
  private readonly pending = new Map<number, SessionAssistantSettlementEntry>()
  // 已发布过的持久 seq，防止重复发布。
  private publishedSeqs = new Set<number>()
  // 已见最大持久 seq 游标。
  private durableCursor = -1
  // 游标缺口内已发出的临时行数（用于合成小数 seq）。
  private transientInGap = 0

  // 替换持久 Web 窗口，并可选地采纳重连基线。
  /**
   * Replace the durable Web window and adopt an optional reconnect baseline.
   * @param entries - durable entries in the replacement window.
   * @param baseline - compact prefix for an Assistant attempt that is still live.
   * @returns immediately visible durable entries plus reconstructed transient chunks.
   */
  replace(
    entries: readonly SessionEventLikeEntry[],
    baseline?: SessionAssistantStreamBaseline,
  ): readonly SessionEventLikeEntry[] {
    // 清空全部折叠状态，从新窗口重新开始。
    this.pending.clear()
    this.transientInGap = 0
    this.activeAttempt = undefined
    this.retainedAttempt = undefined
    // 读取仍活跃尝试的压缩前缀基线。
    const opening = baseline?.activeAttempt
    if (opening !== undefined) {
      // 恢复该尝试的游标信息。
      this.activeAttempt = {
        attemptId: opening.attemptId,
        startedAfterSeq: opening.startedAfterSeq,
        turn: opening.turn,
        step: opening.step,
        nextIndex: opening.nextIndex,
      }
    }
    // 可见条目从持久窗口拷贝起步。
    const visible: SessionEventLikeEntry[] = [...entries]
    // 重建已发布 seq 集合。
    this.publishedSeqs = new Set(visible.map(entry => entry.event.seq))
    // 游标取窗口内最大持久 seq。
    this.durableCursor = visible.reduce((cursor, entry) => Math.max(cursor, entry.event.seq), -1)
    if (opening !== undefined) {
      // 把基线流记录逐个重放为临时行（挂在持久游标之后的缺口里）。
      for (const [index, member] of expandAssistantStream(
        opening.stream as unknown as readonly AssistantStreamRecord[],
      ).entries()) {
        // 缺口计数递增。
        this.transientInGap += 1
        // 合成一条临时实时分块行；seq 取游标后的小数，排在持久条目之前。
        visible.push({
          type: 'transient',
          event: {
            type: 'assistant/live-chunk',
            seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
            time: member.time,
            data: {
              attemptId: opening.attemptId,
              turn: opening.turn,
              step: opening.step,
              chunk: member.chunk,
            },
          },
        })
        // 只重放到基线记录的已消费位置为止。
        if (index + 1 >= opening.nextIndex) break
      }
    }
    // 返回立即可见的完整条目列表。
    return visible
  }

  // 在匹配的活跃尝试仍在进行时，暂存一条持久 v2 结算。
  /**
   * Stage one durable v2 settlement while its matching live attempt is open.
   * @param entry - newly followed durable entry.
   * @returns a publication decision, or `undefined` when no entry becomes visible.
   */
  acceptDurable(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    // 取出事件便于复用。
    const event = entry.event
    // 推进持久游标。
    this.durableCursor = Math.max(this.durableCursor, event.seq)
    // 持久条目落位后缺口清零。
    this.transientInGap = 0
    // 判断该条目是否为 Assistant 结算类型。
    const settlement = assistantSettlementEntry(entry)
    // 匹配到活跃尝试的结算：暂存，等待其 end 帧确认。
    if (settlement !== undefined && this.attemptForSettlement(settlement.event) !== undefined) {
      // 同 seq 重复到达：状态漂移，要求重建基线。
      if (this.pending.has(event.seq)) return { type: 'rebaseline' }
      // 按 seq 暂存结算。
      this.pending.set(event.seq, settlement)
      // 暂存期间不发布任何条目。
      return undefined
    }
    // 非结算条目走普通发布路径。
    return this.publish(entry)
  }

  // 折叠一帧密集瞬态帧，并释放其指名的持久结算；成功消息的临时行保留到所属 Step 结束，被中断消息、失败尝试与放弃立即退休。
  /**
   * Fold one dense transient frame and release its named durable settlement.
   * Successful messages retain their transient rows until the owning Step ends;
   * interrupted messages, failed attempts, and abandonment retire them immediately.
   * @param frame - next Assistant stream frame received by the follow connection.
   * @returns a transient, publication, or rebaseline decision, or `undefined` when no entry becomes visible.
   */
  acceptFrame(frame: SessionAssistantStreamFrame): ClientAssistantStreamResult {
    switch (frame.type) {
      case 'start':
        // 已有进行中或保留的尝试、或未决结算：流错位，要求重建基线。
        if (this.activeAttempt !== undefined || this.retainedAttempt !== undefined
          || this.pending.size > 0) return { type: 'rebaseline' }
        // 清空未决结算。
        this.pending.clear()
        // 记录新尝试的游标信息，从索引 0 开始等待分块。
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: frame.startedAfterSeq,
          turn: frame.turn,
          step: frame.step,
          nextIndex: 0,
        }
        // start 帧本身不产生可见条目。
        return undefined
      case 'chunk': {
        // 取当前尝试。
        const attempt = this.activeAttempt
        // A controller mounted after the Host saw this attempt has no start
        // frame to reconstruct. Its durable settlement publishes directly;
        // ignore the transient suffix until the next known start.
        // 在 Host 已见过该尝试之后才挂载的控制器没有 start 帧可重建；其持久结算直接发布，忽略该尝试的瞬态尾巴，直到下一个已知 start。
        // 尝试未知或不匹配：静默丢弃该分块。
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
        // 分块索引不连续：要求重建基线。
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        // 推进期望索引。
        attempt.nextIndex += 1
        // 缺口计数递增。
        this.transientInGap += 1
        // 发布一条临时实时分块行；seq 取持久游标后的小数，排在持久条目之前。
        return {
          type: 'transient',
          entry: {
            type: 'transient',
            event: {
              type: 'assistant/live-chunk',
              seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
              time: frame.time,
              data: {
                attemptId: frame.attemptId,
                turn: attempt.turn,
                step: attempt.step,
                chunk: frame.chunk as never,
              },
            },
          },
        }
      }
      case 'end': {
        // 取当前尝试。
        const attempt = this.activeAttempt
        // 尝试未知或不匹配：忽略该结束帧。
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) {
          return undefined
        }
        // 尝试结束，清空进行中状态。
        this.activeAttempt = undefined
        // 结束帧索引不连续：要求重建基线。
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        // 尝试被放弃：无未决结算时直接清理临时行，否则视为状态错位。
        if (frame.outcome.kind === 'abandoned') {
          return this.pending.size === 0
            ? { type: 'abandonment', attemptId: attempt.attemptId }
            : { type: 'rebaseline' }
        }
        // 该结算已发布过：无需再动。
        if (this.publishedSeqs.has(frame.outcome.seq)) return undefined
        // 取出暂存的结算。
        const entry = this.pending.get(frame.outcome.seq)
        // 结算缺失或事件类型与结束帧不符：状态漂移，要求重建基线。
        if (entry === undefined
          || entry.event.type !== frame.outcome.eventType) {
          return { type: 'rebaseline' }
        }
        // 结算已被 end 帧确认，移出未决集合。
        this.pending.delete(frame.outcome.seq)
        // 成功且未被中断的消息：保留尝试身份，等其 Step 结束再退休临时行。
        if (entry.event.type === 'assistant/message' && entry.event.data.interrupted !== true) {
          // 记录保留的尝试信息。
          this.retainedAttempt = { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step }
          // 立即发布该持久条目。
          return this.publish(entry)
        }
        // 标记该 seq 已发布。
        this.publishedSeqs.add(entry.event.seq)
        // 交出结算决策：由调用方原子替换该尝试的临时行。
        return { type: 'settlement', attemptId: attempt.attemptId, entry }
      }
    }
  }

  // 判断一条持久结算是否属于当前活跃尝试。
  private attemptForSettlement(
    event: SessionAssistantSettlementEntry['event'],
  ): ActiveAttempt | undefined {
    // 取当前尝试。
    const attempt = this.activeAttempt
    // 无活跃尝试、消息非追加写（append）、seq 不在尝试开始之后、回合或步号不匹配：都不视为该尝试的结算。
    if (attempt === undefined
      || (event.type === 'assistant/message' && event.surfaceOp !== 'append')
      || event.seq <= attempt.startedAfterSeq
      || attempt.turn !== event.data.turn
      || attempt.step !== event.data.step) return undefined
    // 匹配成功。
    return attempt
  }

  // 发布一条持久条目，并处理保留尝试的退休时机。
  private publish(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    // 记录已发布 seq。
    this.publishedSeqs.add(entry.event.seq)
    // 取保留中的尝试。
    const retained = this.retainedAttempt
    // 保留尝试所属的 Step 已结束：发布的同时退休其临时行。
    if (retained !== undefined && entry.event.type === 'step/end'
      && entry.event.data.turn === retained.turn && entry.event.data.step === retained.step) {
      // 清除保留状态。
      this.retainedAttempt = undefined
      // 携带退休指示的发布。
      return { type: 'publish', entry, retireAttemptId: retained.attemptId }
    }
    // 普通发布。
    return { type: 'publish', entry }
  }
}

// 若条目是 Assistant 结算类型（message 或 attempt），收窄为结算条目；否则返回 undefined。
function assistantSettlementEntry(
  entry: SessionLiveEventEntry,
): SessionAssistantSettlementEntry | undefined {
  // 只有 assistant/message 与 assistant/attempt 两种事件类型构成结算。
  return entry.event.type === 'assistant/message' || entry.event.type === 'assistant/attempt'
    ? entry as SessionAssistantSettlementEntry
    : undefined
}
