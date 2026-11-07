// 供领域装配器（assembler）消费的可观察、连续的 Session 事件窗口。
/** Observable contiguous Session event window consumed by domain assemblers. */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LlmAttemptId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

// 仅客户端可见的实时分块（live chunk）呈现；seq 让这行临时内容在持久 Session seq 之间保持有序。
/** Client-only live chunk presentation; `seq` orders the transient row between durable Session seqs. */
export interface AssistantLiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: LlmAttemptId
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

// 当前持久 Session 事件，或一条仅客户端的实时分块呈现。
/** Current durable Session event or one client-only live chunk presentation. */
export type SessionEventLike = SessionEvent | AssistantLiveChunkEvent

// 保留粗粒度传输判别字段（discriminator）的客户端历史条目。
/** Client history entry retaining its coarse transport discriminator. */
export type SessionEventLikeEntry =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'transient'; readonly event: AssistantLiveChunkEvent }

// 追加式（append-only）Client 路径接受的标量实时条目。
/** Scalar live entry accepted by append-only Client paths. */
export type SessionLiveEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }>
// 以原子方式取代某次尝试（attempt）全部临时行的持久 Assistant 事件。
/** Durable Assistant event that atomically supersedes one attempt's transient rows. */
export interface SessionAssistantSettlementEntry {
  readonly type: 'event'
  readonly event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
}
// 在持久游标代数（cursor algebra）之外准入的仅客户端 Assistant 帧。
/** Client-only Assistant frame admitted outside durable cursor algebra. */
export type SessionTransientEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'transient' }>

// 事件窗口 rope 树的叶子节点：一段不可再分的连续条目及其长度。
interface EventWindowLeaf {
  readonly kind: 'leaf'
  readonly entries: readonly SessionEventLikeEntry[]
  readonly length: number
}

// 事件窗口 rope 树的拼接（concat）节点：左右子树组合及其总长度。
interface EventWindowConcat {
  readonly kind: 'concat'
  readonly left: EventWindowNode
  readonly right: EventWindowNode
  readonly length: number
}

// 窗口节点类型：叶子或拼接（rope 结构让追加/前置保持 O(1)，不必复制既有条目）。
type EventWindowNode = EventWindowLeaf | EventWindowConcat

// 构造叶子节点，长度即条目数。
function leaf(entries: readonly SessionEventLikeEntry[]): EventWindowLeaf {
  return { kind: 'leaf', entries, length: entries.length }
}

// 构造拼接节点：只记录子树引用与总长度，不复制条目。
function concat(left: EventWindowNode, right: EventWindowNode): EventWindowConcat {
  return { kind: 'concat', left, right, length: left.length + right.length }
}

// 把窗口 rope 树按顺序展开为扁平条目数组（物化，materialize）。
function materialize(node: EventWindowNode): readonly SessionEventLikeEntry[] {
  // 叶子节点直接返回其条目，无需复制。
  if (node.kind === 'leaf') return node.entries
  // 按总长度预分配结果数组，避免逐次扩容。
  const entries = new Array<SessionEventLikeEntry>(node.length)
  // 用显式栈做迭代展开，避免深层递归。
  const pending: EventWindowNode[] = [node]
  // 下一个待写入位置。
  let index = 0
  while (pending.length > 0) {
    // 逐个弹出待处理节点（后进先出）。
    const current = pending.pop() as EventWindowNode
    if (current.kind === 'concat') {
      // 先压右子树再压左子树，弹出时便先处理左子树，保证最终顺序正确。
      pending.push(current.right, current.left)
      continue
    }
    // 叶子节点：把条目按序写入结果数组。
    for (const entry of current.entries) {
      entries[index] = entry
      index += 1
    }
  }
  return entries
}

// 构造惰性求值（lazy）的事件窗口快照。
function windowSnapshot(
  node: EventWindowNode,
  hasMore: boolean,
  revision: number,
  change: SessionEventChange,
): SessionEventWindow {
  // 缓存槽：尚未物化的条目数组。
  let entries: readonly SessionEventLikeEntry[] | undefined
  return {
    // 首次读取 entries 时才展开窗口树并缓存结果。
    get entries() {
      entries ??= materialize(node)
      return entries
    },
    hasMore,
    revision,
    change,
  }
}

// 产生最新事件窗口版本（revision）的确切增量（delta）。
/** Exact delta that produced the latest event-window revision. */
export type SessionEventChange =
  | { readonly kind: 'replace'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly SessionEventLikeEntry[] }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: LlmAttemptId
    readonly entry?: SessionAssistantSettlementEntry
  }

// 当前连续事件窗口及其最近一次同步增量。
/** Current contiguous event window and its latest synchronous delta. */
export interface SessionEventWindow {
  readonly entries: readonly SessionEventLikeEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: SessionEventChange
}

// 由单个 Session 绑定暴露给会话界面的事件源（source）。
/** Conversation-facing event source exposed by one Session binding. */
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

// Session 持有的事件流（feed）；每次被接受的窗口变更都会同步发布。
/** Session-owned event feed; every accepted window mutation publishes synchronously. */
export class MutableSessionEventSource implements SessionEventSource {
  // 订阅者失效回调集合。
  private readonly listeners = new Set<() => void>()
  // 窗口内容以 rope 树保存，初始为空叶子。
  private window: EventWindowNode = leaf([])
  // 初始快照：空窗口、版本 0、replace 空增量。
  private snapshot: SessionEventWindow = windowSnapshot(
    this.window,
    false,
    0,
    { kind: 'replace', entries: [] },
  )

  // 返回缓存的事件窗口快照。
  /** @returns the cached event-window snapshot. */
  getSnapshot(): SessionEventWindow { return this.snapshot }

  // 订阅同步窗口发布。
  /**
   * Subscribe to synchronous window publication.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // 用完整内容替换整个连续窗口。
  /**
   * Replace the complete contiguous window.
   * @param entries - complete window.
   * @param hasMore - whether older history remains.
   */
  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = leaf(entries)
    this.publish(hasMore, { kind: 'replace', entries })
  }

  // 在窗口头部前置一页更早的连续历史。
  /**
   * Prepend one older contiguous page.
   * @param entries - newly loaded older entries.
   * @param hasMore - whether still older history remains.
   */
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = concat(leaf(entries), this.window)
    this.publish(hasMore, { kind: 'prepend', entries })
  }

  // 在窗口尾部追加一条实时条目。
  /**
   * Append one contiguous live entry.
   * @param entry - live tail entry.
   */
  append(entry: SessionEventLikeEntry): void {
    // 单元素数组，供增量记录复用。
    const entries = [entry]
    // O(1) 拼接新叶子，不复制既有条目。
    this.window = concat(this.window, leaf(entries))
    // 发布 append 增量；hasMore 沿用当前快照的取值。
    this.publish(this.snapshot.hasMore, {
      kind: 'append',
      entries,
    })
  }

  // 用某次尝试已提交的持久结算（settlement）替换其全部临时行。
  /**
   * Replace one attempt's transient rows with its committed durable settlement.
   * @param attemptId - process-local attempt whose live rows are now redundant.
   * @param entry - durable settlement committed for that attempt.
   */
  settleAssistant(attemptId: LlmAttemptId, entry?: SessionAssistantSettlementEntry): void {
    // 物化后过滤掉该尝试的所有临时条目。
    const entries = materialize(this.window).filter(candidate => (
      candidate.type !== 'transient' || candidate.event.data.attemptId !== attemptId
    ))
    // 若携带持久结算条目，则把它插入正确位置。
    if (entry !== undefined) {
      // 找到第一条 seq 更大的条目作为插入点。
      const index = entries.findIndex(candidate => candidate.event.seq > entry.event.seq)
      // 没有更大的 seq：追加到末尾。
      if (index < 0) entries.push(entry)
      // 否则插到该位置之前，保持按 seq 有序。
      else entries.splice(index, 0, entry)
    }
    // 结算重排了数组，窗口回到单个叶子节点。
    this.window = leaf(entries)
    // 发布 settle-assistant 增量；entry 缺省时用条件展开省略该键。
    this.publish(this.snapshot.hasMore, {
      kind: 'settle-assistant',
      attemptId,
      ...(entry === undefined ? {} : { entry }),
    })
  }

  // 发布管线：推进版本号、重建快照并同步唤醒全部订阅者。
  private publish(
    hasMore: boolean,
    change: SessionEventChange,
  ): void {
    // 基于新窗口构造快照，版本号自增。
    this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change)
    // 同步通知所有订阅者（字符串标签用于调试定位）。
    notifySubscribers(this.listeners, '[session-controller] event feed')
  }
}
