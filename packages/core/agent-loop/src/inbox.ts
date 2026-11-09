// 模块说明：驱动器所有的持久收件箱（inbox）投影与命令门面——agent-loop 的
// "排队输入系统"。两个队列：next-turn（等待独立轮次的提示）与 next-step
// （等待下一个步边界的输入）。关键设计：
// 1. 持久优先：每次变更都先落盘 agent/inbox/spliced 事件，内存状态是日志
//    折叠出来的投影，崩溃后从日志重建；
// 2. 折叠严格校验：越界的 splice、重复的消息 id 都拒绝（fail-closed），
//    保证重放历史永远合法；
// 3. 唯一性约束：同一条消息不允许同时在两个队列里挂起（id 全局查重）。
/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

// 消息 id 类型。
import type { MessageId } from '@deepseek-ai/dsh-llm'
// 投影定义类型。
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// 会话核心类型：会话、事件映射、用户消息。
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
// 智能体侧类型：分发器、收件箱契约与状态/目标/线上状态。
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
// zod：投影状态的线上校验 schema。
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
// 由持久收件箱 splice 重建的挂起输入的线上校验 schema。
export const inboxProjectionSchema = z.object({
  // next-turn 队列（只读）。
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  // next-step 队列（只读）。
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
// 标准折叠：从 splice 事件重建挂起输入，拒绝非法的持久历史。
export const inboxProjectionDefinition = {
  // 投影键。
  key: 'inbox',
  // 状态 schema。
  stateSchema: inboxProjectionSchema,
  // 初始状态：两个空队列。
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    // 只处理收件箱 splice 事件。
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      // 取目标队列。
      const inbox = state[splice.target]
      // 移除计数缺省为 0。
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        // splice 区间越界：拒绝。
        throw new Error('invalid inbox splice')
      }
      // 不可变地应用 splice。
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      // 全局消息 id 查重（挂起集合内不允许重复）。
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      // 返回更新后的状态。
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      // 折叠失败：fail-closed 并标注会话序号。
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    // 线上值就是折叠状态本身：每条挂起消息都已按无损 JSON 往返过会话日志；
    // 只有静态类型收窄到 JSON 安全的投影表条目。
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  // 状态版本。
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param readState - reader for the live Inbox projection state.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  // 构造：活投影读取器、会话（落盘）、智能体事件分发器。
  constructor(
    private readonly readState: () => InboxState,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    // 读 next-turn 队列。
    return this.readState()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    // 读 next-step 队列。
    return this.readState()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.readState()
    // 任一队列非空即有挂起工作。
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    // 持久取消全部挂起输入：先清 next-step，再清 next-turn。
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    // 先取走整批 next-step 输入。
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    // 逐条发出认领事件（携带将拥有这批输入的轮号）。
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    // 追加到队尾。
    this.splice(target, this.readState()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    // 插到队首。
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    // 先定位。
    const location = this.locate(messageId)
    if (location === undefined) return false
    // 原位替换（删 1 插 1）。
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    // 先定位。
    const location = this.locate(messageId)
    if (location === undefined) return false
    // 删除 1 条。
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    // 标准 splice：保留被移除的消息并持久记录。
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.readState()
    // 在两个队列中按 id 查找。
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  // 提交一次规范化变更并发布对应的活事件。
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.readState()
    // 目标队列。
    const inbox = state[target]
    // 起点规范化：NaN 归零，负数从尾部起算，超出截到队尾。
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    // 删除计数规范化：非负且不超过队列剩余长度。
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    // 空操作：直接返回。
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    // 候选状态（不可变 splice）。
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    // 全局 id 查重：挂起集合内不允许同一消息出现两次。
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    // 丢弃被移除消息时标记 canceled 结局。
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    // 组装持久 splice 事件载荷。
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    // 计算被移除的消息。
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    // 先落盘（持久优先），再发活事件。
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      // 被丢弃的消息逐条广播。
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    // 新插入的消息逐条广播。
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
