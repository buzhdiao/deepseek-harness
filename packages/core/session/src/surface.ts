// 模块说明：会话事件日志之上的 surface（表面）层——"会产生 LLM 消息的事件"
// 的有序视图。追加式日志始终是事实源；surface 只是它到模型输入的投影。
// 关键设计：
// 1. 折叠（fold）：把日志事件回放成节点序列（nodes），替换操作（compaction）
//    以"影子区间"方式记录，重放即可重建同样的模型可见历史；
// 2. 消息投影（message projection）：插件可用纯函数改写已存在消息的内容
//    （如脱敏），原始身份（事件序号）保留，输出为不可变副本；
// 3. 浏览器安全：web 客户端消费此子路径导出，禁止任何 node: 导入。
/**
 * Surface layer on top of the session event log: an ordered view of events
 * that produce LLM messages. The append-only log remains the source of truth.
 *
 * Browser-safe: web clients consume this subpath export, so it must stay free
 * of `node:` imports (they break the vite bundle).
 *
 * @module @deepseek-ai/dsh-session/surface
 */

// LLM 消息与工具 schema 类型。
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
// 会话序号品牌与日志偏移品牌。
import { SessionLogOffset, SessionSeq } from './types.ts'
// 已知事件类型集合与"必须有消息投影"的事件类型集合。
import { KNOWN_SESSION_EVENT_TYPES, MESSAGE_PROJECTION_EVENT_TYPES } from './known-event-types.ts'
// 会话事件核心类型：事件、事件类型、序号游标、surface 事件、surface 操作。
import type {
  SessionEvent,
  SessionEventType,
  SessionSeqCursor,
  SurfaceEvent,
  SurfaceOp,
} from './types.ts'

/** Readonly history immediately before a message-projection event. */
// 消息投影事件之前的只读历史快照。
export interface SessionMessageProjectionContext {
  /** Current message-producing event sequences in model-visible order. */
  // 当前按模型可见顺序排列的消息事件序号。
  nodes: readonly SessionSeq[]
  /** Contiguous event window; entries at or beyond the candidate seq are not committed inputs. */
  // 连续事件窗口；候选序号及之后的事件尚未成为已提交输入。
  events: readonly SessionEvent[]
  /** Absolute sequence of the window's first event. */
  // 窗口首事件的绝对序号。
  baseSeq: SessionLogOffset
  /** Previously projected messages keyed by their original event sequences. */
  // 之前投影出的消息，按原始事件序号键存。
  messages: ReadonlyMap<SessionSeq, Message>
}

/** Pure interpretation of one plugin-owned event that changes existing message content. */
// 插件所有的"改写既有消息内容"事件的纯解释器定义。
export interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  /** Event interpreted by this definition; declare it with `@messageProjection` in SessionEventMap. */
  // 本定义解释的事件类型（在 SessionEventMap 中用 @messageProjection 声明）。
  type: T
  /**
   * Validate the complete durable decision before returning any updates. Preserve
   * message identities and publish immutable copies without mutating the input.
   * @param event - candidate event, not yet applied to the supplied history.
   * @param context - history preceding this decision.
   * @returns changed current messages keyed by their original sequences.
   * @throws when the durable decision cannot be applied to this history.
   */
  project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>
}

/** Runtime counterpart of the message-producing event union. */
// 消息产出事件并集的运行期对应集合（五类消息事件）。
const SURFACE_EVENT_TYPES = new Set<string>([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether an event type can join the model-visible surface.
 * @param type - event type to test.
 * @returns true for one of the message-producing event types.
 */
export function isSurfaceEligibleType(type: string): boolean {
  // 命中五类消息事件之一即可进入 surface。
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Narrow an event to a surface-eligible event carrying its required marker.
 * @param event - event to test.
 * @returns true when both the type and marker identify a surface event.
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  // 类型必须可进 surface。
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  // 且必须携带必需的 surfaceOp 标记。
  const candidate: { surfaceOp?: unknown } = event
  return candidate.surfaceOp !== undefined
}

/**
 * Narrow an event to an append-origin surface event: one that entered the
 * surface at its own log position and was never itself a replacement copy.
 *
 * The model-visible surface deliberately shadows replaced ranges, so it is the
 * wrong source for a human transcript — a landed replacement would erase
 * conversation the user already saw. Append-origin events are that transcript's
 * durable source material; replacement copies stay model-only.
 * @param event - event to test.
 * @returns true when the event appended to the surface tail.
 */
export function isAppendSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: 'append' } {
  // surface 事件且操作为 append。
  return isSurfaceEvent(event) && event.surfaceOp === 'append'
}

/**
 * Narrow an event to a surface replacement: a node that shadowed an existing
 * surface range instead of appending to the tail. The counterpart of
 * {@link isAppendSurfaceEvent} over the two {@link SurfaceOp} variants.
 * @param event - event to test.
 * @returns true when the event replaced a surface range.
 */
export function isReplacementSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: Extract<SurfaceOp, { op: 'replace' }> } {
  // surface 事件且操作非 append（即替换）。
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/**
 * Project a single event into the LLM message it derives to, or null when it
 * produces none — a non-surface event (attempt, boundary, log-only record) or an
 * empty-content system, developer, or assistant message. A caller
 * reconstructing model input supplies the same prefix's `projectedMessages`
 * from {@link foldSurface}; without that map this function reads original
 * event content. Session instance methods apply the live projection. Messages
 * are immutable and unchanged content retains its durable identity.
 * @param event - the event to project.
 * @param projectedMessages - message projections from the same log prefix's surface fold.
 * @returns the derived message, or null when the event produces none.
 */
export function deriveEventMessage(
  event: SessionEvent,
  projectedMessages?: ReadonlyMap<SessionSeq, Message>,
): Message | null {
  // 优先取已提交的投影消息（插件改写后的版本）。
  const projected = projectedMessages?.get(event.seq)
  if (projected !== undefined) return projected
  // Intentionally non-exhaustive: only message-producing events derive
  // history; turn/step boundaries, failed attempts, and errors are trace/replay
  // data.
  // 刻意不穷举：只有消息产出事件派生历史；
  // 轮/步边界、失败尝试与错误属于追踪/重放数据。
  switch (event.type) {
    // Ordinary prompts and injected context retain producer-owned framing.
    // See Derived history in packages/core/session/README.md.
    // 普通提示与注入上下文保留生产方自带的外形。
    case 'user/message': {
      return event.data
    }
    // Empty system and developer nodes retain their surface positions without
    // adding wire messages. An empty assistant event hosts a max-tokens step's
    // usage and must not inject a content-less turn into the provider transcript.
    // 空内容的 system/developer 节点保留 surface 位置但不产生线上消息；
    // 空 assistant 事件承载 max-tokens 步的用量，
    // 绝不能给提供方转录注入一轮无内容消息。
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    // 工具结果直接取其消息。
    case 'tool/result': {
      return event.data.message
    }
    default:
      // A non-surface event (boundary, attempt, log-only record) projects to
      // no message. Merge-extensible union: no assertNever here.
      // 非 surface 事件（边界、尝试、纯日志记录）不投影出消息。
      // 并集可被合并扩展：这里不放 assertNever。
      return null
  }
}

/** Whether a payload field is a JSON object rather than an array or scalar. */
// 判断载荷字段是 JSON 对象（而非数组或标量）。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject noncanonical request-header fields, developer roles/content, and contradictory tool failure metadata.
 * This does not validate complete event payloads or embedded provider streams.
 * @param event - event whose locally related payload fields are inspected.
 * @param subject - event location to include in validation errors.
 * @throws when request-header fields, developer roles/content, or tool failure metadata are invalid.
 */
export function validateSessionEventData(
  event: Pick<SessionEvent, 'type' | 'data'>,
  subject: string,
): void {
  // 取事件载荷。
  const data: unknown = event.data
  // 消息事件的本地结构校验。
  if (SURFACE_EVENT_TYPES.has(event.type) && isRecord(data)) {
    // user/message 的载荷本身就是消息；其余取 message 字段。
    const message = event.type === 'user/message' ? data : data['message']
    if (isRecord(message)) {
      // developer 角色与 developer/message 事件必须成对出现。
      if ((event.type === 'developer/message') !== (message['role'] === 'developer')) {
        throw new Error(`${subject} developer/message and developer role must occur together`)
      }
      // 工具增删块只允许出现在 developer 角色消息里。
      if (message['role'] !== 'developer' && Array.isArray(message['content'])
        && message['content'].some((block: unknown) => isRecord(block)
          && (block['type'] === 'tool-addition' || block['type'] === 'tool-removal'))) {
        throw new Error(`${subject} tool-change blocks require developer role`)
      }
      if (event.type === 'developer/message' && Array.isArray(message['content'])) {
        // developer 消息内容块的逐块校验。
        let hasAdditions = false
        for (const block of message['content']) {
          // 非工具变更块跳过。
          if (!isRecord(block) || (block['type'] !== 'tool-addition' && block['type'] !== 'tool-removal')) continue
          // toolName 必须是非空字符串。
          if (typeof block['toolName'] !== 'string' || block['toolName'].length === 0) {
            throw new Error(`${subject} ${block['type']} requires a nonempty toolName`)
          }
          if (block['type'] === 'tool-addition') {
            hasAdditions = true
            // 新增声明不允许内联完整工具定义（定义必须已在头部里）。
            if (Object.hasOwn(block, 'tool')) throw new Error(`${subject} tool-addition must omit inline tool definitions`)
          }
        }
        // headerSeq 的存在性与"是否有新增"必须严格对应。
        if (hasAdditions ? !isEventSeq(data['headerSeq']) : Object.hasOwn(data, 'headerSeq')) {
          throw new Error(`${subject} requires headerSeq exactly when tool additions are present`)
        }
      }
    }
  }
  if (event.type === 'request/header') {
    // 请求头事件的本地校验。
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    const header = data['header']
    if (!isRecord(header)) throw new Error(`${subject} header must be an object`)
    // 系统提示词必须走 system/message，不允许在头部携带。
    if (Object.hasOwn(header, 'system')) throw new Error(`${subject} must omit header.system; use system/message`)
    // 空工具列表必须省略。
    if (Array.isArray(header['tools']) && header['tools'].length === 0) {
      throw new Error(`${subject} must omit empty tools`)
    }
    // 空的适配器默认标记必须省略。
    const defaults = header['adapterDefaults']
    if (isRecord(defaults) && Object.keys(defaults).length === 0) {
      throw new Error(`${subject} must omit empty adapterDefaults`)
    }
  } else if (event.type === 'tool/result') {
    // 工具结果事件：携带 error 字段时 message.isError 必须为 true（矛盾元数据拒绝）。
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    if (data['error'] === undefined) return
    const message = data['message']
    if (!isRecord(message) || message['isError'] !== true) {
      throw new Error(`${subject} error requires message.isError === true`)
    }
  }
}

/** One replacement operation observed while folding a session surface. */
// 折叠会话 surface 时观察到的一次替换操作。
export interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  // 执行替换的事件序号。
  seq: SessionSeq
  /** Declared inclusive start seq of the replaced surface range. */
  // 声明的被替换区间起始序号（含端点）。
  start: SessionSeq
  /** Declared inclusive end seq of the replaced surface range. */
  // 声明的被替换区间结束序号（含端点）。
  end: SessionSeq
  /** Actual surface entries removed by the operation, in surface order. */
  // 该操作实际移除的 surface 条目（按 surface 顺序）。
  shadowedSeqs: SessionSeq[]
}

/** Complete result of replaying the surface operations in a session log. */
// 完整回放日志中 surface 操作的结果。
export interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  // 当前按模型可见顺序排列的 surface 事件序号。
  nodes: SessionSeq[]
  /** Replacement operations in event order. */
  // 按事件顺序排列的替换操作。
  replacements: SurfaceFoldReplacement[]
  /** Immutable projected messages, keyed by their original event sequences. */
  // 不可变的投影消息，按原始事件序号键存。
  projectedMessages: ReadonlyMap<SessionSeq, Message>
}

/** Readonly live projection of the message-producing session events. */
// 消息产出事件的只读活投影接口。
export interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  // 当前按模型可见顺序排列的 surface 事件序号。
  readonly nodes: readonly SessionSeq[]
  /** Monotonic count of committed positional replacements. */
  // 已提交的位置替换的单调计数。
  readonly replaceGeneration: number
  /** Monotonic count of committed replacements and plugin-owned message changes. */
  // 已提交的替换与插件消息改动的单调计数。
  readonly contentGeneration: number
}

/** Mutable state shared by complete and incremental folds. */
// 完整折叠与增量折叠共享的可变状态。
interface SurfaceFoldState {
  // surface 节点序列。
  nodes: SessionSeq[]
  // 位置替换计数。
  replaceGeneration: number
  // 内容变更计数（替换 + 插件消息改动）。
  contentGeneration: number
  // 投影消息表。
  projectedMessages: Map<SessionSeq, Message>
  // 已生效的投影定义集合。
  projections: Set<SessionMessageProjection>
}

/** A validated replacement transition that has not mutated fold state yet. */
// 已校验、尚未落到折叠状态的替换转移（含索引与实际影子区间）。
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  // 起始下标。
  startIdx: number
  // 结束下标。
  endIdx: number
}

/** One validated surface transition that has not mutated fold state yet. */
// 已校验、尚未落地的 surface 转移：追加 / 替换 / 投影。
type SurfacePlan =
  | { kind: 'append'; seq: SessionSeq }
  | SurfaceReplacePlan
  | { kind: 'project'; projection: SessionMessageProjection; messages: ReadonlyMap<SessionSeq, Message> }

/** Create an empty surface fold state. */
// 创建空的折叠状态。
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0, contentGeneration: 0, projectedMessages: new Map(), projections: new Set() }
}

/** Whether a runtime value is a non-negative safe event sequence. */
// 判断运行期值是否为非负安全整数的事件序号（显式排除 -0）。
function isEventSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

/** Whether a runtime value is the exact positional-replacement shape. */
// 判断运行期值是否为精确的"位置替换"形状（恰好三个键且全部合法）。
function isReplaceOp(value: object): value is Extract<SurfaceOp, { op: 'replace' }> {
  const op = value as Record<string, unknown>
  return Object.keys(op).length === 3
    && Object.hasOwn(op, 'op')
    && Object.hasOwn(op, 'startSeq')
    && Object.hasOwn(op, 'endSeq')
    && op['op'] === 'replace'
    && isEventSeq(op['startSeq'])
    && isEventSeq(op['endSeq'])
}

/** Validate event-local surface eligibility and return its operation. */
// 校验事件本地的 surface 资格并返回其操作。
function surfaceOpOf(event: SessionEvent): SurfaceOp | undefined {
  const raw: { surfaceOp?: unknown; sourceEventSeqs?: unknown } = event
  if (!isSurfaceEligibleType(event.type)) {
    // Unknown ignorable records retain opaque metadata without affecting history.
    // 未知可忽略记录保留不透明元数据，不影响历史。
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return
    // 非 surface 事件不允许携带 surfaceOp。
    if (raw.surfaceOp !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    }
    // 非 surface 事件不允许携带 sourceEventSeqs。
    if (raw.sourceEventSeqs !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    }
    return
  }
  const op = raw.surfaceOp
  if (op === undefined) {
    // surface 事件必须携带操作标记。
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  // append 操作：直接返回。
  if (op === 'append') return op
  // 其余必须是合法的替换对象。
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
  }
  if (!isReplaceOp(op)) {
    throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  return op
}

/** Validate cited source-event seqs against prior log entries and the replacement range. */
// 校验事件引用的源事件序号：必须指向更早的日志条目，且覆盖全部被影子化的节点。
function assertSourceEventReferences(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
): void {
  const raw: unknown = event.sourceEventSeqs
  if (event.type === 'assistant/message' && raw !== undefined) {
    // assistant/message 内嵌自己的源流，不允许再携带引用。
    throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
  }
  const sources = new Set<SessionSeq>()
  if (raw !== undefined) {
    // 存在时必须是数组。
    if (!Array.isArray(raw)) {
      throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    }
    // 不允许空数组。
    if (raw.length === 0) {
      throw new Error('sourceEventSeqs must not be empty')
    }
    // 记录第一个"不早于当前事件"的引用。
    let nonEarlierSource: SessionSeq | undefined
    for (const source of raw) {
      // 每个引用都必须是合法事件序号。
      if (!isEventSeq(source)) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    // 不允许重复。
    if (sources.size !== raw.length) {
      throw new Error('sourceEventSeqs must not contain duplicates')
    }
    if (nonEarlierSource !== undefined) {
      // 只允许引用更早的事件。
      throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`)
    }
  }
  // 替换场景：所有被影子化的节点必须被引用。
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
}

/** Resolve tool additions against their immutable historical request header. */
// 用不可变的历史请求头解析工具新增声明的合法性。
function assertDeveloperHeader(
  event: SessionEvent,
  read: (seq: number) => SessionEvent | undefined,
): void {
  // 只针对 developer/message。
  if (event.type !== 'developer/message') return
  // 先做本地载荷校验。
  validateSessionEventData(event, `developer/message at seq ${event.seq}`)
  // 未引用头部：无需进一步校验。
  if (event.data.headerSeq === undefined) return
  const headerSeq = event.data.headerSeq
  const headerEvent = read(headerSeq)
  if (headerSeq >= event.seq || headerEvent?.type !== 'request/header') {
    // 必须引用更早的 request/header。
    throw new Error('developer/message headerSeq must reference an earlier request/header')
  }
  for (const block of event.data.message.content) {
    // 只处理工具新增块。
    if (block.type !== 'tool-addition') continue
    // 在头部里查找同名工具。
    const definitions = headerEvent.data.header.tools?.filter(tool => tool.name === block.toolName) ?? []
    if (definitions.length !== 1) {
      // 必须恰好命中一个。
      throw new Error(`developer/message tool-addition "${block.toolName}" must name exactly one tool in headerSeq ${headerSeq}`)
    }
    const definition = definitions[0] as ToolSchema
    // 引用的工具定义必须完整（描述 + 参数 schema）。
    if (typeof definition.description !== 'string' || !isRecord(definition.parameters)) {
      throw new Error(`developer/message tool-addition "${block.toolName}" requires a complete tool definition in headerSeq ${headerSeq}`)
    }
    // deferLoading 若存在必须为 true（延迟加载的工具才允许事后新增）。
    if (Object.hasOwn(definition, 'deferLoading') && definition.deferLoading !== true) {
      throw new Error('developer/message referenced tool deferLoading must be true when present')
    }
  }
}

/**
 * Validate one event's surface metadata without checking membership in a log or surface.
 * @param event - event whose marker and source sequence values are inspected.
 * Unknown ignorable records retain opaque metadata and never change the surface.
 * @returns the validated operation, or undefined for a log-only or unknown ignorable event.
 * @throws when metadata violates event-local eligibility, marker, or source-sequence rules.
 */
export function validateSurfaceMetadata(event: SessionEvent): SurfaceOp | undefined {
  // 先做事件本地的资格与标记校验。
  const op = surfaceOpOf(event)
  if (op !== undefined && op !== 'append'
    && (op.startSeq >= event.seq || op.endSeq >= event.seq)) {
    // 替换区间必须指向更早的事件。
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }
  // 无影子区间上下文时校验源引用的通用规则。
  if (op !== undefined) assertSourceEventReferences(event, [])
  return op
}

/** Locate one replacement range without mutating the current fold state. */
// 在不改动折叠状态的前提下定位替换区间。
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
  // 起始序号必须在 surface 上。
  const startIdx = state.nodes.indexOf(op.startSeq)
  if (startIdx === -1) {
    throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`)
  }
  // 结束序号也必须在 surface 上。
  const endIdx = state.nodes.indexOf(op.endSeq)
  if (endIdx === -1) {
    throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`)
  }
  if (startIdx > endIdx) {
    // 起点在终点之后：非法区间。
    throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`)
  }
  return {
    startIdx,
    endIdx,
    // 实际被影子化的节点（切片）。
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * Deep structural equality over the session-event JSON value domain
 * (null/boolean/number/string, arrays, plain objects). Replaces
 * `node:util`'s isDeepStrictEqual to keep this module browser-safe.
 */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  // 全等：直接通过。
  if (a === b) return true
  // 数组：长度一致且逐项深等。
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  // 非对象：深等不成立。
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // 对象：键数一致且每个键都存在并值深等。
  const aKeys = Object.keys(a)
  const bRecord = b as Record<string, unknown>
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson((a as Record<string, unknown>)[key], bRecord[key]))
}

/** Restrict a tool-result replacement to one current result's content. */
// 工具结果替换的限制：只允许改写一个现有结果的内容字段。
function assertToolResultRewrite(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
  read: (seq: number) => SessionEvent | undefined,
): void {
  // 只针对 tool/result。
  if (event.type !== 'tool/result') return
  if (shadowedSeqs.length !== 1) {
    // 必须恰好改写一个现有节点。
    throw new Error('tool/result surface replacement must rewrite exactly one current node')
  }
  for (const originalSeq of shadowedSeqs) {
    const original = read(originalSeq)
    if (original?.type !== 'tool/result') {
      throw new Error('tool/result surface replacement must target a current tool/result')
    }
    // 双方都把 message.content 置空后做深比较：只有 content 允许不同。
    const originalRest = { ...original.data } as Record<string, unknown>
    const replacementRest = { ...event.data } as Record<string, unknown>
    originalRest['message'] = {
      ...original.data.message,
      content: null,
    }
    replacementRest['message'] = {
      ...event.data.message,
      content: null,
    }
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      throw new Error('tool/result surface replacement may change only content')
    }
  }
}

/**
 * Protect the system prompt at surface node 0. A replacement covering node 0
 * while that node is a `system/message` must itself be a `system/message` over
 * exactly that node; later system nodes carry no protection and a compaction
 * range may shadow them.
 */
function assertSystemHeadRewrite(
  event: SessionEvent,
  state: SurfaceFoldState,
  startIdx: number,
  shadowedSeqs: readonly SessionSeq[],
  read: (seq: number) => SessionEvent | undefined,
): void {
  // 只关心覆盖 node 0 的替换。
  if (startIdx !== 0) return
  const head = read(state.nodes[0] as number)
  if (head?.type !== 'system/message') return
  if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
    // 系统提示词保护：只允许同类型的 system/message 恰好替换该节点。
    throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
  }
}

/** Validate one event at its replay boundary and prepare its atomic fold transition. */
function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
  candidates?: readonly SessionEvent[],
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    // 序号必须连续（fail-closed 的日志完整性检查）。
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
  }
  // 校验 surface 元数据与开发者头部引用。
  const surfaceOp = validateSurfaceMetadata(event)
  const read = (seq: number): SessionEvent | undefined => {
    const index = seq - baseSeq
    return index < events.length ? events[index] : candidates?.[index - events.length]
  }
  assertDeveloperHeader(event, read)
  const projection = projections.find(item => item.type === event.type)
  if (projection !== undefined) {
    let projectionEvents: readonly SessionEvent[] | undefined
    return { kind: 'project', projection, messages: projection.project(event, {
      nodes: state.nodes,
      get events() { return candidates === undefined ? events : (projectionEvents ??= [...events, ...candidates]) },
      baseSeq,
      messages: state.projectedMessages,
    }) }
  }
  if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) {
    // 必须有投影却没有定义：fail-closed。
    throw new Error(`session event "${event.type}" requires a message projection; load its owning plugin or supply its projection definition`)
  }
  // 纯日志事件（无 surface 操作）：无转移。
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    // 追加转移。
    return { kind: 'append', seq: event.seq }
  }
  // 替换转移：定位区间并依次跑三组约束校验。
  const range = replacementRange(state, surfaceOp)
  assertSourceEventReferences(event, range.shadowedSeqs)
  assertToolResultRewrite(event, range.shadowedSeqs, read)
  assertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, read)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.startSeq,
    end: surfaceOp.endSeq,
    ...range,
  }
}

/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections)
  // 委托给统一的落地函数。
  return applySurfacePlan(state, plan)
}

/** Commit one previously validated surface transition. */
// 提交一次先前已校验的 surface 转移。
function applySurfacePlan(
  state: SurfaceFoldState,
  plan: SurfacePlan | undefined,
): SurfaceFoldReplacement | undefined {
  if (plan?.kind === 'append') {
    // 追加：节点入队尾。
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    // 替换：原区间裁掉、替换事件顶上；两个世代计数都 +1。
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
    state.contentGeneration += 1
  } else if (plan?.kind === 'project') {
    // 投影：合并改写消息、登记定义、内容世代 +1。
    for (const [seq, message] of plan.messages) state.projectedMessages.set(seq, message)
    state.projections.add(plan.projection)
    state.contentGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  // 只有替换产生替换元数据。
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * Replay a complete session log through the canonical surface fold.
 * @param events - session events in contiguous seq order.
 * @param projections - pure interpreters for plugin-owned message changes; required definitions must be supplied.
 * @returns detached current sequences and replacement history.
 * @throws when an interpreter is missing or an event violates its projection, surface metadata, source attribution, or replacement rules.
 */
export function foldSurface(events: readonly SessionEvent[], projections: readonly SessionMessageProjection[] = []): SurfaceFoldResult {
  // 新建折叠状态。
  const state = createFoldState()
  // 替换历史收集器。
  const replacements: SurfaceFoldReplacement[] = []
  // 从 0 起逐事件回放。
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(
      state,
      event,
      SessionSeq(index),
      events,
      SessionLogOffset(0),
      projections,
    )
    if (replacement !== undefined) replacements.push(replacement)
  }
  // 返回分离的节点副本、替换历史与投影消息副本。
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) }
}

/** Incremental ordered surface view and append-boundary validator. */
// 增量的有序 surface 视图兼追加边界校验器（活会话的投影管理器）。
export class SurfaceManager implements SessionSurface {
  /** Shared transition state; replacement history is not retained. */
  // 共享转移状态；不保留替换历史。
  private _state = createFoldState()
  /** Last processed absolute seq. */
  // 最后处理的绝对序号。
  private _lastProcessedSeq: SessionSeqCursor
  /** Candidate already validated by `validateNext`, pending exact log admission. */
  // validateNext 已校验的候选，等待日志确切接纳。
  private _pendingPlan: { event: SessionEvent; expectedSeq: SessionSeq; plan: SurfacePlan | undefined } | undefined

  /**
   * @param log - Contiguous complete log or loaded event window.
   * @param baseSeq - Absolute sequence of the window's first event.
   * @param projections - live borrowed definitions; removing a used definition invalidates further reads.
   */
  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq: SessionLogOffset = SessionLogOffset(0),
    private readonly projections: readonly SessionMessageProjection[] = [],
  ) {
    // 初始化游标：空窗口为 -1，否则指向窗口首事件前一位。
    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)
  }

  /**
   * Validate the next candidate without mutating the committed surface.
   * @param event - candidate event that has not entered the log yet.
   */
  validateNext(event: SessionEvent): void {
    // 投影定义必须仍然在场。
    this._assertProjections()
    // 先把日志新增的增量折叠进来。
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    // 期望序号 = 日志尾部之后。
    const expectedSeq = SessionSeq(this.baseSeq + this.log.length)
    // 预校验候选并暂存计划（不落地）。
    this._pendingPlan = {
      event,
      expectedSeq,
      plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq, this.projections),
    }
  }

  /**
   * Validate consecutive candidates against an isolated surface fold.
   * @param events - candidates immediately following the committed log.
   * @returns a callback adopting the validated fold after all candidates enter the log.
   */
  prepareBatch(events: readonly SessionEvent[]): () => void {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    const lastProcessedSeq = SessionSeq(this.baseSeq + this.log.length + events.length - 1)
    if (events.every(event => (event.surfaceOp === undefined || event.surfaceOp === 'append')
      && !this.projections.some(projection => projection.type === event.type))) {
      const plans = events.map((event, index) => planSurfaceEvent(
        this._state, event, SessionSeq(this.baseSeq + this.log.length + index), this.log, this.baseSeq, this.projections, events,
      ))
      return () => {
        for (const plan of plans) applySurfacePlan(this._state, plan)
        this._lastProcessedSeq = lastProcessedSeq
        this._pendingPlan = undefined
      }
    }
    const state: SurfaceFoldState = {
      ...this._state,
      nodes: [...this._state.nodes],
      projectedMessages: new Map(this._state.projectedMessages),
      projections: new Set(this._state.projections),
    }
    const plans = events.map((event, index) => {
      const plan = planSurfaceEvent(
        state, event, SessionSeq(this.baseSeq + this.log.length + index), this.log, this.baseSeq, this.projections, events,
      )
      applySurfacePlan(state, plan)
      return plan
    })
    return () => {
      for (const plan of plans) applySurfacePlan(this._state, plan)
      this._lastProcessedSeq = lastProcessedSeq
      this._pendingPlan = undefined
    }
  }

  /** Monotonic count of folded positional replacements. */
  get replaceGeneration(): number {
    // 读取前先校验投影并吸收增量。
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** Monotonic count of committed changes to existing model-visible content. */
  get contentGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.contentGeneration
  }

  /**
   * Project one message with every committed message projection applied.
   * @param event - message-producing or log-only event.
   * @returns its immutable projected message, or null when it produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    // 基于已提交投影表派生消息。
    return deriveEventMessage(event, this._state.projectedMessages)
  }

  /** Surface event sequences in model-visible order. */
  get nodes(): readonly SessionSeq[] {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** Fold events appended since the previous access. */
  private _processDelta(): void {
    // 增量区间的尾部序号。
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      // 按绝对序号换算日志下标。
      const index = seq - this.baseSeq
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const event = this.log[index]!
      const pending = this._pendingPlan
      if (pending?.event === event && pending.expectedSeq === seq) {
        // 候选被日志接纳：直接复用预校验的计划。
        applySurfacePlan(this._state, pending.plan)
      } else {
        // 计划不匹配（如日志分支变化）：重新校验并落地。
        applySurfaceEvent(this._state, event, SessionSeq(seq), this.log, this.baseSeq, this.projections)
      }
      // 过期的候选计划清除。
      if (pending !== undefined && pending.expectedSeq <= seq) this._pendingPlan = undefined
      // 推进游标。
      this._lastProcessedSeq = SessionSeq(seq)
    }
  }

  /** Cached messages cannot outlive the definitions that interpreted their log. */
  // 缓存的消息不能活得比解释其日志的定义更久：定义被移除即失效。
  private _assertProjections(): void {
    const candidate = this._pendingPlan
    // 若候选已被日志接纳，其计划中的投影也纳入"必需"集合。
    const pending = candidate !== undefined && this.log[candidate.expectedSeq - this.baseSeq] === candidate.event
      ? candidate.plan : undefined
    const required = pending?.kind === 'project'
      ? [...this._state.projections, pending.projection]
      : this._state.projections
    for (const projection of required) {
      if (!this.projections.includes(projection)) {
        // 定义被移除或替换：fail-closed，要求带原插件恢复会话。
        throw new Error(`session message projection "${projection.type}" was removed or replaced; restore the session with its owning plugin`)
      }
    }
  }
}
