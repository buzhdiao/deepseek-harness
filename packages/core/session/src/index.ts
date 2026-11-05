/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 *
 * @module @deepseek-ai/dsh-session
 */

// 【中文逐行注释 · DSH 核心包 4：core/session/index.ts —— Session 事件溯源服务】
// 这是整个 DSH 最核心的服务之一（ctx.sessions）。三层结构：
// 1) Session——单个事件溯源会话：只追加日志 + 表面（surface）+ 派生消息缓存；
// 2) SessionStore——内存会话商店（Cordis Service）：创建/进入/公告/卸下会话，
//    并把四个事件（session/created、disposed、event、flush）作为插件扩展点广播；
// 3) 持久化不属于本包——持久化插件订阅 session/event、在 session/flush 排水。
// 「一切皆插件」落地：会话数据本身是可扩展事件联合（SessionEventMap 声明合并），
// 消息投影（message projection）也由插件注册，核心不感知具体内容。
import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from './types.ts'
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateSessionOptions, EpochHeader, PluginRecord, PluginRecordMap, PluginRecordType, PrepareSessionOptions, RequestContext, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SessionId, SessionSeedEventState, SurfaceIntent, SurfaceEventType } from './types.ts'
import { SurfaceManager, validateSessionEventData, validateSurfaceMetadata } from './surface.ts'
import type { SessionSurface, SessionMessageProjection } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'
import { ToolHistoryProjection } from './tool-history.ts'
import type { ToolHistory } from '@deepseek-ai/dsh-llm'

import { buildForkSeed } from './fork.ts'

// 公共出口：fork 种子构造器、全部类型、会话准备器、修复工具、表面折叠、
// 请求头折叠、已知事件类型表等（供其他插件按需使用）。
export { buildForkSeed } from './fork.ts'
export * from './types.ts'
export { SessionPreparation } from './preparation.ts'
export type { SessionPreparationOptions } from './preparation.ts'
export type { AssistantMessage, DeveloperMessage, SystemMessage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
export { interruptedTurnClosers, ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'
export type { SessionSurface, SurfaceFoldReplacement, SurfaceFoldResult, SessionMessageProjection, SessionMessageProjectionContext } from './surface.ts'
export { deriveEventMessage, foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEvent, isSurfaceEligibleType } from './surface.ts'
export { canonicalHeader, foldRequestHeader, headerEquals } from './request-header.ts'
export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

// 声明合并 1：把 sessions 服务挂上 Context（ctx.sessions）。
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore
  }

  // 声明合并 2：定义四个会话事件——这是「durable facts（session/event）」与
  // 「live 通知」的扩展点边界。每个事件都声明 @mode（派发模式）与载荷 @param。
  interface Events {
    /**
     * Read-only creation announcement after store entry.
     * New events reject until every synchronous listener has returned successfully.
     * A synchronous throw vetoes creation and rolls back with a paired disposal;
     * detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @mode emit
     */
    // session/created：进入商店后的只读创建公告（emit）。同步监听器全部成功
    // 返回前禁止追加；同步抛错否决创建并回滚；作用域过滤——agent 作用域的
    // 监听器只收到经该 agent 上下文进入的会话。
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @mode emit
     */
    // session/disposed：已公告会话离开商店时发一次（含发布回滚）。
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @mode emit
     */
    // session/event：提交后即发即忘的追加流——持久化插件靠它把事件写入磁盘；
    // 观察者失败被记录且被隔离，不影响已提交的追加。
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @mode parallel
     */
    // session/flush：被 await 的并行持久化检查点（parallel）——调用方等待全部
    // 监听器完成；无 waterfall 否决。
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
  }
}

// 声明合并 3：向 Typert 注册 session 查找（远程 API 用 id 解析活会话对象）。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>
  }
}

/** Validate and freeze one detached creation header in place. */
// validateSessionHeader：校验并就地深冻结一个创建头——逐字段校验
//（版本必须等于当前常量、id 必须匹配、createdAt 非负安全整数、cwd 绝对路径、
// isSeeded 必填布尔等），并拒绝历史遗留的 seedLength 字段。
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  // 必须是普通 JSON 记录（非 null/非数组/对象）。
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  // 退役字段 seedLength 不允许出现。
  if (Object.hasOwn(record, 'seedLength')) {
    throw new Error('session header has invalid field "seedLength"')
  }
  // 版本必须与当前逻辑格式版本一致（历史头由迁移层翻译后再进来）。
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(record.version)}`)
  }
  // 头里的 id 必须与会话 id 一致。
  if (record.id !== id) {
    throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  }
  // createdAt：非负安全整数。
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  // cwd（可选）：字符串且为绝对路径（存储后端按它定位目录）。
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
    }
  }
  // parentSession（可选）：字符串。
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  // isSeeded：必填布尔。
  if (typeof record.isSeeded !== 'boolean') {
    throw new Error('session header isSeeded must be a boolean')
  }
  // origin（可选）：只能是 'subagent'。
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  // delegationDepth（可选）：非负安全整数。
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  // agentPreset（可选）：字符串。
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  // 全部通过：深冻结后返回（元数据从此不可变）。
  return deepFreeze(record as unknown as SessionHeader)
}

/** Validate and freeze one exclusively owned persistence header in place. */
// validateRestoredSessionHeader：恢复场景的加强版——额外要求原型是
// Object.prototype 或 null（防原型污染 / 反序列化边界）。
function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}

/** Detach, validate, and freeze the creation metadata published by a session. */
// snapshotSessionHeader：无头时合成最小头（盖当前版本戳），有头时快照
//（脱离调用方引用）→ 校验 → 冻结。
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
    : source
  // snapshotJsonValue：无损 JSON 快照——不可序列化的值直接返回 undefined（拒绝）。
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/**
 * Validate an exclusively owned event and deeply freeze its identified message
 * without copying the event. The caller transfers an object graph that no
 * producer retains and that shares no mutable children with another event.
 * Use {@link snapshotSessionEvent} when exclusive ownership is not guaranteed.
 * @param event - exclusively owned event imported across a trusted boundary.
 * @returns the same event object with a validated, deeply frozen message.
 * @throws when event-local surface metadata, request-header fields, or message invariants are invalid; history relations are not checked.
 */
// adoptSessionEvent：接管一个独占所有权的事件（不拷贝）——校验数据/表面元数据/
// 消息形状后，按类型深冻结其中的「已识别消息」。跨可信边界导入用；
// 不保证独占时用 snapshotSessionEvent（先 structuredClone）。
export function adoptSessionEvent<T extends SessionEvent>(event: T): T {
  validateSessionEventData(event, `session event at seq ${event.seq}`)
  validateSurfaceMetadata(event)
  assertMessageEventShape(
    event,
    `session event at seq ${event.seq}`,
  )
  // 按类型冻结消息：user/message 的 data 本身就是消息；其余四类冻结 data.message；
  // 插件自有事件（可合并扩展）没有核心消息，默认分支跳过。
  switch (event.type) {
    case 'user/message':
      deepFreeze(event.data)
      break
    case 'developer/message':
    case 'system/message':
    case 'assistant/message':
    case 'tool/result':
      deepFreeze(event.data.message)
      break
    default:
      // SessionEventMap is merge-extensible; plugin-owned events carry no core message.
      // 上游注释：可合并扩展联合——插件事件没有核心消息。
      break
  }
  return event
}

/**
 * Detach one event while preserving deep immutability for its identified message.
 * @param event - event imported across a query or persistence boundary.
 * @returns a detached event snapshot with a validated, deeply frozen message.
 */
// snapshotSessionEvent：先 structuredClone 脱离引用，再走 adopt 校验冻结。
export function snapshotSessionEvent<T extends SessionEvent>(event: T): T {
  return adoptSessionEvent(structuredClone(event))
}

/** Validate the fixed event envelope after one-pass JSON materialization. */
// assertSessionEventEnvelope：对 JSON 物化后的种子事件做信封校验——
// 只允许固定键集合；type/seq/time/data 类型与取值范围校验；
// 再做数据级校验与 LLM 形状校验。
function assertSessionEventEnvelope(value: unknown, index: number): asserts value is SessionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  const event = value as Record<string, unknown>
  // 信封键白名单：type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable。
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
      case 'ignorable':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  // seq：非负安全整数且非 -0；time：安全整数；data 必须存在；ignorable 只能是 true。
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || event['data'] === undefined
    || (event['ignorable'] !== undefined && event['ignorable'] !== true)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  // 数据级校验（每类事件的具体载荷规则）。
  validateSessionEventData(event as SessionEvent, `seed ${type} at index ${index}`)
  // LLM 消息形状校验（恢复边界拒绝过时头与畸形消息）。
  switch (type) {
    case 'request/header':
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'assistant/attempt':
    case 'assistant/message':
    case 'tool/result':
      assertCurrentLlmShape(event, index)
      break
  }
}

/** Reject obsolete request headers and malformed messages at the seed/load boundary. */
// assertCurrentLlmShape：种子/加载边界上的「当前形状」校验——
// request/header 必须带 provider/model、合法 reason、合法 adapterDefaults；
// 消息型事件做消息形状校验；assistant 系事件做 settlement 字段校验。
function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void {
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  if (event['type'] === 'request/header') {
    const headerRecord = record?.['header'] as Record<string, unknown>
    const config = headerRecord['config']
    // 调用配置必须携带 provider/model 对。
    if (!hasProviderModel(config)) throw new Error(`seed request/header at index ${index} lacks provider/model`)
    const configRecord = config as Record<string, unknown>
    // reasoningEffort（可选）：非空字符串。
    const reasoningEffort = configRecord['reasoningEffort']
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    assertAdapterDefaults(headerRecord['adapterDefaults'], configRecord, index)
    // reason：四值闭联合法。
    const reason = record?.['reason']
    if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') {
      throw new Error(`seed request/header at index ${index} has an invalid reason`)
    }
    // startsSeries（可选）：只能是 true。
    if (record?.['startsSeries'] !== undefined && record['startsSeries'] !== true) {
      throw new Error(`seed request/header at index ${index} has an invalid startsSeries marker`)
    }
  }
  const type = event['type']
  if (type === 'assistant/attempt') {
    assertAssistantSettlementShape(record, type, index)
    return
  }
  if (!isMessageEventType(type)) return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
  if (type === 'assistant/message') {
    assertAssistantSettlementShape(record, type, index)
  }
}

/** Validate fields used directly by restored Session lifecycle logic without replaying the embedded stream. */
// assertAssistantSettlementShape：只校验恢复生命周期直接用到的字段
//（turn/step 非负安全整数、stream 是数组），不重放内嵌流。
function assertAssistantSettlementShape(
  data: Record<string, unknown> | undefined,
  type: 'assistant/attempt' | 'assistant/message',
  index: number,
): void {
  const turn = data?.['turn']
  const step = data?.['step']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0)
    || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || Object.is(step, -0)
    || !Array.isArray(data?.['stream'])) {
    throw new Error(`seed ${type} at index ${index} has invalid settlement fields`)
  }
}

// adapterDefaults 允许的字段集合。
const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** Validate adapter-default markers imported from a durable request header. */
// assertAdapterDefaults：适配器默认值标记校验——键在白名单内、值全为 true、
// 且标记为 true 的字段必须真的在 config 中缺席（标记的意义是「该字段来自适配器默认」）。
function assertAdapterDefaults(
  value: unknown,
  config: Record<string, unknown>,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const defaults = value as Record<string, unknown>
  if (Object.keys(defaults).some(key => !allowedAdapterKeys.has(key))
    || Object.values(defaults).some(marker => marker !== true)
    || defaults['reasoningEffort'] === true && config['reasoningEffort'] === undefined
    || defaults['maxTokens'] === true && config['maxTokens'] === undefined) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}

/** The surface event types whose payload carries an identified message. */
// isMessageEventType：载荷携带「已识别消息」的表面事件类型集合。
function isMessageEventType(type: unknown): type is SurfaceEventType {
  return type === 'developer/message' || type === 'system/message' || type === 'user/message'
    || type === 'assistant/message' || type === 'tool/result'
}

// 事件类型 → 消息角色 的固定映射。
const MESSAGE_ROLE_BY_TYPE: Record<SurfaceEventType, Message['role']> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** Validate only the event-specific invariants needed to safely replay a message. */
// assertMessageEventShape：只校验「安全重放消息」所需的事件特有不变量——
// 消息必须带非空 id、角色与类型匹配、source 形状合法、content 是数组；
// system 必须来自 system-prompt、assistant 必须来自 model（带 provider/model）、
// tool 必须来自 tool 且 toolCallId 与 source.callId 一致。
function assertMessageEventShape(event: Record<string, unknown>, subject: string): void {
  const type = event['type']
  if (!isMessageEventType(type)) return
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  // user/message 的 data 就是消息本体；其余类型取 data.message。
  const message = type === 'user/message' ? record : record?.['message']
  if (typeof message !== 'object' || message === null
    || typeof (message as Record<string, unknown>)['id'] !== 'string'
    || (message as Record<string, unknown>)['id'] === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const messageRecord = message as Record<string, unknown>
  // 角色必须与事件类型匹配。
  const expectedRole = MESSAGE_ROLE_BY_TYPE[type]
  if (messageRecord['role'] !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  // source：非空对象且带非空 kind。
  const source = messageRecord['source']
  if (typeof source !== 'object' || source === null
    || typeof (source as Record<string, unknown>)['kind'] !== 'string'
    || (source as Record<string, unknown>)['kind'] === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  // content：数组。
  if (!Array.isArray(messageRecord['content'])) {
    throw new Error(`${subject} message has invalid content`)
  }
  const sourceRecord = source as Record<string, unknown>
  if (type === 'system/message') {
    // 系统消息只能来自 system-prompt。
    if (sourceRecord['kind'] !== 'system-prompt') {
      throw new Error(`${subject} message must have system-prompt source`)
    }
    return
  }
  if (type === 'assistant/message') {
    // 助手消息必须来自 model 且带 provider/model。
    if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  // 工具结果必须来自 tool，callId 非空，且与消息上的 toolCallId 一致。
  if (sourceRecord['kind'] !== 'tool'
    || typeof sourceRecord['callId'] !== 'string'
    || sourceRecord['callId'] === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  if (messageRecord['toolCallId'] !== sourceRecord['callId']) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** Whether an unknown value carries the current provider/model pair. */
// hasProviderModel：未知值是否携带非空 provider/model 对。
function hasProviderModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

// 会话事件监听器的通用签名。
type SessionCallback = (...args: unknown[]) => unknown

/** Resolve one listener snapshot, including Cordis's internal dispatch checks. */
// collectSessionCallbacks：解析监听器快照（走 Cordis dispatch，
// 含内部过滤与作用域过滤）——先快照后执行，保证追加不受监听器重入影响。
function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  return [...ctx.events.dispatch('emit', args)] as SessionCallback[]
}

/** Invoke one resolved observe-only listener snapshot with per-listener containment. */
// invokeContainedSessionObservers：逐个调用观察型监听器并隔离错误——
// 单个监听器同步抛错或异步 reject 都只记 warn 日志，不影响同伴与调用方。
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}

/** All mutable lifecycle state for one exact store entry. */
// SessionEntry：商店里一个精确条目的全部可变生命周期状态。
interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  // carrier：作用域路由载体（session/disposed 等事件用它过滤监听器）。
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  // announcement：公告阶段（pending → dispatching → complete/failed）。
  announcement: 'pending' | 'dispatching' | 'complete' | 'failed'
  // appending：一次追加是否正在发布（防重入）。
  appending: boolean
  // detachRequested：发布期间收到过 detach 请求（发布结束再执行）。
  detachRequested: boolean
  detach(): void
}

/** Store-owned Sessions retain a null entry while unentered; absent keys are independent. */
// attachments：Session → 条目的弱映射。值可以是 null（已交商店但未进入）——
// 「键存在值 null」与「键不存在（独立会话）」语义不同。
const attachments = new WeakMap<Session, SessionEntry | null>()

/**
 * Grammar of a {@link PluginRecordType}: `plugin:` followed by
 * slash-separated segments of lowercase letters, digits, `.`, `_`, and `-`,
 * each segment starting with a letter or digit.
 */
// PLUGIN_RECORD_TYPE：插件记录类型的文法正则（上游注释）。
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u

/**
 * Whether one event type name follows the plugin record grammar.
 * @param type - an event type name.
 * @returns whether the name is a {@link PluginRecordType}.
 */
// isPluginRecordType：类型名是否符合插件记录文法。
function isPluginRecordType(type: string): type is PluginRecordType {
  return PLUGIN_RECORD_TYPE.test(type)
}

/**
 * Type one constructed plugin record as a log event after checking its type
 * against the plugin record grammar. A restored Session already holds events
 * whose types are outside `SessionEventMap` when they are marked ignorable;
 * a plugin record is such an event.
 * @param value - the frozen record envelope built by {@link Session}.
 * @throws when the record type is outside the plugin record grammar.
 */
// assertPluginRecordEvent：把构造好的插件记录断言为日志事件——
// ignorable 事件的类型可以超出 SessionEventMap，插件记录正是这种事件。
function assertPluginRecordEvent(value: unknown): asserts value is SessionEvent {
  const { type } = value as { readonly type: string }
  if (!isPluginRecordType(type)) {
    throw new Error(`plugin record type "${type}" must be "plugin:" followed by lowercase slash-separated segments`)
  }
}

/** Module-private access to {@link Session}'s record commit, assigned once by its static block. */
// commitPluginRecord：模块私有桥——静态块里赋值，把 Session 的私有提交方法
// 交给模块级 appendPluginRecord 使用（class 私有方法无法从类外直接调用）。
let commitPluginRecord: (session: Session, type: PluginRecordType, data: unknown) => SessionSeq

/**
 * Append one experimental plugin record: an event marked `ignorable` whose
 * type is declared in {@link PluginRecordMap}, outside {@link SessionEventMap}.
 * The plugin record catalog lists it separately from released event schemas.
 * A reader that does not recognize the type retains and skips the record, which never
 * enters the model-visible surface, and fork and resume carry it with the rest
 * of the log. A Session format migration retains records on a best-effort
 * basis, so a record holds plugin-owned state that its owner can lose without
 * changing how the rest of the log is interpreted.
 *
 * Only production source under `packages/experimental/` may call this
 * function; the `verify-plugin-record-callers` gate rejects any other
 * production caller in this repository. Read records back with
 * {@link pluginRecordOf}.
 * @param session - the Session whose log receives the record.
 * @param type - declared record name: `plugin:` followed by slash-separated
 *   segments of lowercase letters, digits, `.`, `_`, and `-`, each starting
 *   with a letter or digit.
 * @param data - JSON payload, snapshotted before it enters the log.
 * @returns the sequence number of the committed record.
 * @throws when a store-owned Session is unentered or its creation announcement
 *   has not completed, when `type` is outside
 *   that grammar, when `data` is not losslessly
 *   JSON-serializable, or when the call reenters another append's publication;
 *   a rejected record does not change the log.
 */
// appendPluginRecord（上游注释详尽）：追加实验性插件记录——ignorable 事件，
// 不进模型可见表面；未知类型读取者保留并跳过；迁移尽力保留。
// 只有 packages/experimental/ 下的生产源码可以调用（verify-plugin-record-callers 门禁）。
export function appendPluginRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): SessionSeq {
  return commitPluginRecord(session, type, data)
}

/**
 * Read one committed event as a plugin record. The V3-to-V4 format edge also
 * renames each unknown ignorable V3 event into the `plugin:` namespace, so an
 * owner names its records under its own package name and validates `data`.
 * @param event - any committed Session event, live or restored.
 * @returns the record, or undefined when the event is not an ignorable event
 *   whose type follows the plugin record grammar.
 */
// pluginRecordOf：把已提交事件读回插件记录（ignorable + 文法匹配才成立）。
export function pluginRecordOf(event: SessionEvent): PluginRecord | undefined {
  const type: string = event.type
  if (event.ignorable !== true || !isPluginRecordType(type)) return undefined
  return { type, seq: event.seq, time: event.time, data: event.data }
}

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
// Session：事件溯源会话本体（上游注释：普通类而非 Service——
// 经 ctx.sessions.create() 创建活实例，Session.create() 创建脱管实例）。
export class Session {
  // 私有日志：只追加的事件数组；seq === 数组下标（连续性契约）。
  private log: SessionEvent[] = []
  /** Single incremental owner of surface acceptance and projection state. */
  // 表面管理器：表面接纳与投影状态的唯一增量所有者。
  private readonly surfaceManager: SurfaceManager

  /** The ordered surface over this session's event log. */
  // surface：日志之上的有序表面（决定派生消息历史）。
  get surface(): SessionSurface {
    return this.surfaceManager
  }

  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  // header（上游注释）：脱管深冻结的创建元数据——存储关注点而非可重放对话状态，
  // 因此不进事件日志。
  readonly header: SessionHeader

  /** Number of leading events inherited from this Session's fork parent. */
  // inheritedEventCount：从 fork 父代继承的前缀事件数。
  readonly inheritedEventCount: SessionLogOffset

  /** The session identity, derived from its durable header's single copy. */
  // id：会话身份——从持久头的唯一副本推导。
  get id(): SessionId {
    return this.header.id
  }

  /**
   * The constructor seed length (0 without one), before any marker appended
   * during construction. Seed events never publish on `session/event`. A
   * marker appended before the store attaches occupies this seq without
   * publishing either; otherwise this seq is available for the next append.
   *
   * This in-process offset is not persisted. A fork seed can already contain
   * the child's inherited marker and synthetic closers, so its child-owned
   * history starts at {@link inheritedEventCount}, before this offset. A
   * resumed Session's seed contains its full stored log, while its inherited
   * count keeps the durable fork cut. Consumers needing complete canonical
   * history start at seq 0.
   */
  // firstLiveSeq（上游注释）：构造时种子长度——进程内偏移不持久化；
  // 需要完整正典历史的消费者从 seq 0 开始。
  readonly firstLiveSeq: SessionLogOffset

  /**
   * First event produced for this object lifecycle. A new fork includes its
   * child-owned seed marker and closers; a restored Session starts after its
   * complete stored prefix. This in-process capture offset is not persisted.
   */
  // firstLifecycleSeq：本对象生命周期产出的第一个事件位置（不持久化）。
  readonly firstLifecycleSeq: SessionLogOffset

  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length for a seeded header.
   * @param projections - pure interpreters for plugin-owned message changes.
   * @returns a detached session.
   * @throws when a seed event requires a missing message interpreter or fails validation.
   */
  // create：静态工厂——借用的种子与元数据先快照再校验（脱离引用）。
  static create(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    inheritedEventCount?: SessionLogOffset,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(id, seed, header, 'snapshot', inheritedEventCount, projections)
  }

  /**
   * Restore a detached session by adopting an independently owned or deeply frozen seed.
   * Runtime-required event fields, event envelopes, sequence continuity, surface
   * transitions, and header fields are validated without copying or freezing events.
   * Embedded Assistant streams remain opaque until a stream consumer or storage
   * verifier reads them.
   * @param id - restored session identity.
   * @param seed - independently owned or deeply frozen events.
   * @param header - independently owned storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length decoded from storage.
   * @param eventState - aliasing state carried from the operation that produced the seed.
   * @param projections - pure interpreters for plugin-owned message changes.
   * @returns a restored detached session.
   * @throws when a seed event requires a missing message interpreter or fails validation.
   */
  // fromRestore：恢复工厂——接管独立持有或深冻结的值（免拷贝免再冻结）；
  // 内嵌助手流在被消费前保持不透明。
  static fromRestore(
    id: SessionId,
    seed: readonly SessionEvent[],
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    eventState: SessionSeedEventState,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(
      id,
      seed,
      header,
      eventState,
      inheritedEventCount,
      projections,
    )
  }

  // 私有构造器：两种模式（snapshot 快照接管 / restored 接管独立值）。
  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | SessionSeedEventState = 'snapshot',
    suppliedInheritedEventCount?: SessionLogOffset,
    projections: readonly SessionMessageProjection[] = [],
  ) {
    // 表面管理器从空日志起步。
    this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections)
    // 恢复模式：加强校验头（普通记录 + 原型检查）。
    const restoredHeader = mode === 'snapshot' ? undefined : validateRestoredSessionHeader(id, header)
    if (seed !== undefined) {
      // Validate the seed to the SAME invariants `append` enforces, so a
      // replay/fork (`ctx.sessions.create(id, { seed })`) cannot construct a
      // live log that no persistence backend could store: each event's `data`
      // must be JSON-serializable, and `seq` must be contiguous from 0 (the
      // `seq = log.length` contract the whole system relies on). Without this,
      // a bad seed would surface only later as a backend rejection or a silent
      // divergence between the live log and disk.
      // 上游注释：种子必须满足与 append 相同的不变量——否则坏种子只会在
      // 后端拒绝或静默分叉时才暴露。
      for (const [index, source] of seed.entries()) {
        // The seed is a persistence/replay boundary: validate and detach the
        // complete event in one lossless-JSON pass.
        // 上游注释：种子是持久化/重放边界——一次无损 JSON 遍历完成校验与脱离。
        const snapshot = mode === 'snapshot' ? snapshotJsonValue(source) : source
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        // 信封校验（固定键集合 + 基本类型 + 数据级 + LLM 形状）。
        assertSessionEventEnvelope(snapshot, index)
        // seq 连续性：第 index 个事件的 seq 必须就是 index。
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // A seed is accepted incrementally through the same transition as a
        // live append and a full-log fold. The candidate is planned before it
        // enters `log`, so a failure cannot partially mutate the surface.
        // 上游注释：种子经与活追加相同的表面转换逐步接纳；候选先校验后入日志，
        // 失败不会半改表面。
        try {
          this.surfaceManager.validateNext(snapshot)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        // 入日志：快照模式深冻结；接管模式原样（已是冻结/独占）。
        this.log.push(mode === 'snapshot' ? deepFreeze(snapshot) : snapshot)
      }
    }
    // 记录种子长度（firstLiveSeq）。
    this.firstLiveSeq = SessionLogOffset(this.log.length)
    // 头：恢复头或合成/快照头。
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)
    // 一致性检查组：
    // isSeeded 会话必须有显式种子。
    if (this.header.isSeeded && seed === undefined) {
      throw new Error('seeded session requires an explicit constructor seed')
    }
    // isSeeded 会话必须提供继承长度。
    if (this.header.isSeeded && suppliedInheritedEventCount === undefined) {
      throw new Error('seeded session requires an inherited event count')
    }
    const inheritedEventCount = SessionLogOffset(suppliedInheritedEventCount ?? 0)
    // 未 seed 的会话继承长度必须为 0。
    if (!this.header.isSeeded && inheritedEventCount !== 0) {
      throw new Error('unseeded session inherited event count must be 0')
    }
    // 继承长度不能超过日志长度。
    if (inheritedEventCount > this.log.length) {
      throw new Error('session inherited event count exceeds its event log')
    }
    // 继承切点上的标记检查：{ inherited: true } 的 session/end-seed。
    const seedMarker = this.log[inheritedEventCount]
    const markedSeed = seedMarker?.type === 'session/end-seed' && seedMarker.data.inherited === true
    if (mode === 'snapshot' && this.header.isSeeded && inheritedEventCount !== this.log.length && !markedSeed) {
      throw new Error('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
    }
    // 继承标记之后不允许再有 inherited 标记（必须是最后一个）。
    if (markedSeed && this.log.slice(inheritedEventCount + 1).some(event => event.type === 'session/end-seed' && event.data.inherited === true)) {
      throw new Error('session inherited event count must identify the final inherited marker')
    }
    this.inheritedEventCount = inheritedEventCount
    // 生命周期起点：新 fork 的种子会话从继承切点起；其余从种子长度起。
    this.firstLifecycleSeq = mode === 'snapshot' && this.header.isSeeded ? inheritedEventCount : this.firstLiveSeq
    // A fresh seeded child always owns one tagged marker at its inherited cut,
    // even when the copied prefix already ends in an ancestor marker. Restore
    // retains that durable marker and appends only the ordinary resume marker.
    // 上游注释：新 fork 子代总在继承切点拥有一个带标记的 session/end-seed；
    // 恢复保留持久标记，只追加普通恢复标记。
    if (seed !== undefined && mode === 'snapshot' && this.header.isSeeded && !markedSeed) {
      this.append('session/end-seed', { inherited: true })
    } else if (seed !== undefined && !(mode === 'snapshot' && this.header.isSeeded) && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})
    }
  }

  /** Cached immutable full snapshot of the private append-only log. */
  // 全量快照缓存（下次追加失效）。
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * Return the immutable event stored at one exact sequence number.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @param seq - event sequence number.
   * @returns the accepted event, or undefined when the log does not contain it.
   */
  // eventAt：按序号取单个事件（已废弃——新代码禁止同步事件读，见 Agent Note）。
  eventAt(seq: SessionSeq): SessionEvent | undefined {
    return this.log[seq]
  }

  /**
   * Materialize an immutable snapshot of a half-open event sequence range.
   * A full current snapshot is reused until the next append; every previously
   * returned snapshot remains stable after later appends.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @param fromSeq - non-negative inclusive sequence number; defaults to the log start.
   * @param toSeqExclusive - non-negative exclusive sequence number; defaults to the current end.
   * @returns a frozen array of the selected deeply frozen events.
   */
  // snapshotEvents：半开区间快照——全量快照缓存复用，历史快照在后续追加后仍稳定。
  snapshotEvents(
    fromSeq: SessionLogOffset = SessionLogOffset(0),
    toSeqExclusive: SessionLogOffset = this.seq,
  ): readonly SessionEvent[] {
    if (fromSeq === 0 && toSeqExclusive === this.log.length) {
      // 全量：缓存复用。
      this.eventsSnapshot ??= Object.freeze([...this.log])
      return this.eventsSnapshot
    }
    // 区间：每次新冻结。
    return Object.freeze(this.log.slice(fromSeq, toSeqExclusive))
  }

  /**
   * Return this Session's events after its fork-inherited prefix.
   * @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
   * See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).
   * @returns a fresh array containing child-owned events in log order.
   */
  // ownEvents：继承前缀之后的「子代自有」事件。
  ownEvents(): readonly SessionEvent[] {
    // oxlint-disable-next-line typescript/no-deprecated -- Deprecated reader delegates to the deprecated range read.
    // 上游注释：废弃读取者委托给废弃的区间读取。
    return this.snapshotEvents(this.inheritedEventCount)
  }

  /**
   * Whether one existing event position is outside the fork-inherited prefix.
   * @param seq - event position in this Session.
   * @returns true when the event belongs to this Session rather than its parent.
   */
  // isOwnSeq：该位置是否属于子代自有（在继承前缀之外且在日志之内）。
  isOwnSeq(seq: SessionSeq): boolean {
    return seq >= this.inheritedEventCount && seq < this.seq
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  // seq：下一个事件的序号——恒等于日志长度（seq = log.length 连续性契约）。
  get seq(): SessionLogOffset {
    return SessionLogOffset(this.log.length)
  }

  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   * Independent Sessions append without notifying store observers. Once a store
   * prepares or enters the instance, writes require a completed creation
   * announcement and remain disabled after removal.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` lists the seq numbers of earlier
   *   events this one derives from. REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived model
   *   history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/attempt`. Assistant messages embed their exact provider
   *   stream and cannot cite top-level source events.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if a store-owned Session is unentered or its creation announcement
   *   has not completed, or if `data` or surface
   *   metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   request-header empty-field or tool-error consistency rules, or the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One iterative pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  // append（上游注释极详尽）：向日志追加一个类型化事件——
  // 热路径不做 I/O（持久化插件异步缓冲）；一旦入日志即已提交（观察者失败被隔离）；
  // 独立会话静默追加；商店拥有的会话必须先完成创建公告；
  // 表面元数据是消息型事件的必填参数（编译器对非表面类型直接报错）；
  // 返回的 event.data 是入日志的快照而非调用方仍可变的输入。
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    // 条件参数：表面型事件必填 SurfaceIntent；日志型事件无此参数。
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
  ): SessionEvent<T> {
    // 发布入口检查：商店归属/公告完成/防重入。
    this.publicationEntry()
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    // 组装表面元数据（缺省字段不设键）。
    const surfaceMetadata = {
      ...surfaceOpts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
      ...surfaceOpts?.surfaceOp === undefined ? {} : { surfaceOp: surfaceOpts.surfaceOp },
    }
    // 数据快照：一次迭代式遍历完成读、校验、拷贝——有状态 getter 无法
    // 给校验和存储提供不同的值。
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }
    // Payload getters can detach the Session while the snapshots are read.
    // 上游注释：载荷 getter 可能在快照读取期间把会话从商店脱离——再查一次入口。
    const entry = this.publicationEntry()
    // 构造冻结事件信封：分配 seq（=当前日志长度）与 time。
    const event = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      ...(surfaceMetadataSnapshot as { surfaceOp?: unknown; sourceEventSeqs?: unknown }),
    } as unknown as SessionEvent<T>)
    // 数据级校验（每类事件的载荷规则）。
    validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`)
    // 提交：入日志 + 通知观察者。
    this.commit(event as SessionEvent, entry)
    return event
  }

  // 静态块：把私有提交方法挂到模块级桥上（appendPluginRecord 的唯一路径）。
  static {
    commitPluginRecord = (session, type, data) => session.#appendRecord(type, data)
  }

  /**
   * Commit one plugin record; {@link appendPluginRecord} is the only caller.
   * @param type - record type, checked against the plugin record grammar.
   * @param data - JSON payload, snapshotted before it enters the log.
   * @returns the record's sequence number.
   */
  // #appendRecord：私有方法——提交一条插件记录（ignorable: true 的冻结信封）。
  #appendRecord(type: PluginRecordType, data: unknown): SessionSeq {
    this.publicationEntry()
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`plugin record "${type}" carries non-JSON-serializable data`)
    }
    const entry = this.publicationEntry()
    const record: unknown = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      // ignorable 标记：未知类型的读取者安全跳过。
      ignorable: true,
    })
    // 文法检查后再提交。
    assertPluginRecordEvent(record)
    this.commit(record, entry)
    return record.seq
  }

  /**
   * Require announced membership for store-owned Sessions and refuse reentrant publication.
   * @returns the current store attachment, or undefined for an independent Session.
   */
  // publicationEntry：追加前的守卫——未进入商店（null）拒绝；公告未完成拒绝；
  // 发布中重入拒绝。独立会话返回 undefined（静默追加）。
  private publicationEntry(): SessionEntry | undefined {
    const entry = attachments.get(this)
    if (entry === null) {
      throw new Error(`session "${this.id}" cannot append outside a SessionStore`)
    }
    if (entry !== undefined && entry.announcement !== 'complete') {
      throw new Error(`session "${this.id}" cannot append before session/created completes`)
    }
    if (entry?.appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    return entry
  }

  /**
   * Accept one frozen candidate at the next sequence number, enter it into the
   * log, and notify `session/event` observers with per-listener containment.
   * @param event - the candidate built at the current log length.
   * @param entry - the attachment read before the candidate was built.
   */
  // commit：接受冻结候选——表面先校验（失败不动日志）→ 监听器快照先解析 →
  // 入日志（seq=log.length）→ 失效快照缓存 → 逐个通知（错误隔离）→
  // finally 里清 appending 标记并处理延迟 detach。
  private commit(event: SessionEvent, entry: SessionEntry | undefined): void {
    this.surfaceManager.validateNext(event)

    if (entry !== undefined) entry.appending = true
    try {
      const callbackArgs: unknown[] = [this, event]
      // 监听器快照在入日志前解析（回调却在入日志后执行）。
      const callbacks = entry === undefined
        ? undefined
        : collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
      this.log.push(event)
      // 快照缓存失效。
      this.eventsSnapshot = undefined
      if (entry !== undefined && callbacks !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
    } finally {
      if (entry !== undefined) {
        entry.appending = false
        // 发布期间收到过 detach 请求：现在执行（公告派发中的除外）。
        if (entry.detachRequested && entry.announcement !== 'dispatching') entry.detach()
      }
    }
  }

  /** Cached fold of the request-header events — see {@link requestHeader}. */
  // 请求头折叠缓存与已消费位置。
  private headerFold: EpochHeader | undefined
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq = 0

  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.snapshotEvents())`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  // requestHeader：增量维护的请求头折叠——每个头事件只折叠一次，
  // 每步读取成本 O(新事件数)；返回值冻结（防止消费者原地改坏后续比较）。
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      // Frozen on update: the fold is session state exposed by reference — a
      // consumer mutating it in place (instead of building a replacement)
      // would desync every later comparison against the log, so mutation
      // throws instead.
      // 上游注释：折叠结果是按引用暴露的会话状态——冻结它防止原地突变。
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /** Cached fold of `request/context` events. */
  // request/context 折叠缓存。
  private contextFold: RequestContext | undefined
  private contextFoldSeq = 0

  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  // requestContext：最近一次路由元数据（增量折叠，冻结快照）。
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context') this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  /** Cached historical tool definitions and updates for request projection. */
  // 工具历史投影：能力无关的工具定义与更新。
  private readonly toolHistoryProjection = new ToolHistoryProjection()
  /** Index of the next committed event not yet consumed by the tool-history fold. */
  private toolHistorySeq = 0

  /**
   * Fold unseen committed events into capability-independent tool history.
   * Initial access reconstructs inherited history; later reads consume only new events.
   * @returns an immutable snapshot for LLM request projection, including historical addition definitions.
   */
  // toolHistory：把未见事件折叠进工具历史（初始访问重建继承历史；
  // 后续只消费新事件）——供 LLM 请求投影使用。
  toolHistory(): ToolHistory {
    for (const event of this.log.slice(this.toolHistorySeq)) this.toolHistoryProjection.apply(event)
    this.toolHistorySeq = this.log.length
    return this.toolHistoryProjection.snapshot()
  }

  /** The derived-message cache: frozen projections, extended per unseen node. */
  // 派生消息缓存与表面位置/代次。
  private derived: Message[] = []
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes = 0
  /** {@link SurfaceManager.contentGeneration} the cache was built under. */
  private derivedGeneration = 0

  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, with logged message projections applied
   * without changing node membership or message identity.
   *
   * CACHED: pure tail growth costs O(new nodes); a replacement or message projection
   * ({@link SessionSurface.contentGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Unchanged content reuses frozen event data; projected blocks are frozen
   * derived copies. Consumers cannot mutate the log through either form.
   * @returns a fresh array of the shared, frozen derived history.
   */
  // deriveMessages（上游注释详尽）：从表面（surfaceOp 标记维护的有序序列）
  // 推导 LLM 消息历史——表面是派生历史的唯一来源。
  // 缓存策略：纯尾部增长 O(新节点)；替换/投影换代（contentGeneration）重建。
  // 返回新数组（快照），内部 Message 对象共享且深冻结——消费者无法经此改动日志。
  deriveMessages(): Message[] {
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.contentGeneration
    // 代次变化（发生过替换/投影）：整表重建。
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      // Surface sequences are built from this.log — seq is always a valid
      // index by construction. The non-null assertion expresses that invariant.
      // 上游注释：表面序列由日志构建，seq 按构造必为合法下标。
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const msg = this.deriveEventMessage(this.log[seq]!)
      // A surface node is one of the five message-producing types, but an
      // empty-content assistant/message (a max-tokens step that hosts only
      // usage) derives to null and must not enter the transcript.
      // 上游注释：空内容的 assistant/message 推导为 null，不得进入转录。
      if (msg) this.derived.push(msg)
    }
    this.derivedNodes = nodes.length
    // 每次调用返回新数组——调用方持有的旧数组不会被后续追加撑大。
    return [...this.derived]
  }

  /**
   * Project one event with all committed message projections applied.
   * The original durable event remains unchanged.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  // deriveEventMessage：单事件投影（应用全部已注册的消息投影；原始事件不变）。
  deriveEventMessage(event: SessionEvent): Message | null {
    return this.surfaceManager.deriveEventMessage(event)
  }
}

/** A fork source: either the live session object or its live store id. */
// SessionForkSource：fork 来源——活会话对象或其在商店中的 id。
export type SessionForkSource = Session | SessionId

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); or the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`).
 */
// SessionForkErrorCode：fork 拒绝码（上游注释四类）。
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'

/** Typed error for session fork rejections. */
// SessionForkError：fork 拒绝的类型化错误。
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — the agent lifecycle
 * attaches a session-log writer to each published session's write handle;
 * a session published outside that lifecycle persists nothing.
 */
// SessionStore（上游注释）：内存会话商店——持久化刻意不在这里实现
//（代理生命周期把日志写入器挂到每个已发布会话上；脱离该生命周期发布的会话不持久化）。
export class SessionStore extends Service {
  // id → 条目。
  private store = new Map<SessionId, SessionEntry>()
  // 自动 id 计数器。
  private counter = 0
  // 插件注册的消息投影定义（借用）。
  private readonly projections: SessionMessageProjection[] = []

  /** Borrowed definitions for detached replay; contributions live until their registering fibers unload. */
  // messageProjections：脱管重放用的借用定义集合（注册插件卸载即消失）。
  get messageProjections(): readonly SessionMessageProjection[] {
    return this.projections
  }

  /**
   * Register one event interpreter for live creation, restore, and fork.
   * Disposing the contribution makes sessions that used it refuse further derivation.
   * @param projection - pure definition owned by the event's plugin.
   * @returns the fiber-owned disposer.
   * @throws when another definition already owns this event type.
   */
  // registerMessageProjection：注册事件解释器（插件自有事件的纯投影定义）——
  // 这是「插件为模型可见消息变更登记纯消息投影」约定的入口；重复注册同类抛错。
  registerMessageProjection(projection: SessionMessageProjection): () => Promise<void> {
    if (this.projections.some(item => item.type === projection.type)) {
      throw new Error(`session message projection "${projection.type}" is already registered`)
    }
    // 注册本身是 fiber effect：插件卸载自动撤销；之后用它的会话拒绝继续派生。
    return this.ctx.effect(() => {
      this.projections.push(projection)
      return () => { this.projections.splice(this.projections.indexOf(projection), 1) }
    }, 'sessions.registerMessageProjection()')
  }

  constructor(ctx: Context) {
    // 注册为 ctx.sessions 服务。
    super(ctx, 'sessions')
    // 等 typert 服务就绪后注册 session 查找器（远程调用按 id 解析活会话）。
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('session', {
        parameter: 'session',
        wire: 'sessionId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
    })
  }

  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  // create（上游注释）：创建调用方 fiber 拥有的会话——
  // 注意：需要会话与循环按序一起拆除的 agent 不该用它，
  // 应走 prepare + enter + announce 组合（见 agent-loop 的创建事务）。
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // Single effect owned by the calling fiber. Yield the detach BEFORE
    // announcing so a throwing `session/created` listener rolls the attach back
    // (the generator effect disposes already-yielded disposers on a throw)
    // instead of leaking the store entry and its publication hooks.
    // 上游注释：单个生成器 effect——先 yield detach（进入），再公告；
    // 监听器抛错时已 yield 的 disposer 会被回滚（不泄漏商店条目）。
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `eventState`, every seed event is either independently owned or any
   *   shared value is deeply frozen; {@link Session.fromRestore} validates and
   *   adopts those values without copying or freezing them.
   * @returns the store-owned session, not yet entered and read-only until announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  // prepare（上游注释）：构建但不进入商店——与 enter/announce 配对，
  // 让 agent 工厂把会话生命周期折叠进自己的复合 effect（有序拆除）。
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session {
    let sessionId: SessionId
    if (id === undefined) {
      // 未给 id：铸造 session-<n>，撞车则继续递增。
      do sessionId = brandString<SessionId>(`session-${++this.counter}`)
      while (this.store.has(sessionId))
    } else {
      // 给了 id：品牌化后使用。
      sessionId = brandString<SessionId>(id)
    }
    // id 唯一性检查。
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    if (options !== undefined) {
      const { eventState } = options
      // 恢复模式分支：detached / shared-frozen 两种别名状态。
      switch (eventState) {
        case 'detached':
        case 'shared-frozen': {
          const session = Session.fromRestore(
            sessionId,
            options.seed,
            options.meta,
            options.inheritedEventCount,
            eventState,
            this.projections,
          )
          // 先标记为「已交商店但未进入」（null 条目）。
          attachments.set(session, null)
          return session
        }
        case undefined:
          break
        /* v8 ignore next -- closed-union exhaustiveness guard */
        // 封闭联合的穷尽守卫（assertNever）。
        default:
          assertNever(eventState, 'SessionStore.prepare event state')
      }
    }
    // 新建路径：读出种子与元数据。
    const seed = options?.seed
    const meta = options?.meta
    // 组装头：store 填 version/id/createdAt；可选字段缺席时不设键。
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta?.createdAt ?? Date.now(),
      ...meta?.cwd === undefined ? {} : { cwd: meta.cwd },
      ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      isSeeded: meta?.isSeeded ?? false,
      ...meta?.origin === undefined ? {} : { origin: meta.origin },
      ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
      ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    }
    // 创建（快照模式）并标记为未进入。
    const session = Session.create(sessionId, seed, header, options?.inheritedEventCount, this.projections)
    attachments.set(session, null)
    return session
  }

  /**
   * Enter a session into the store: install the module-private
   * append publication hooks and add it to the store. Writes remain disabled
   * until {@link announce} completes successfully. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   * 【中文】enter 会复查 id 是否重复：prepare 与 enter 是公开的跨包原语，
   * 调用者可能在中间插入任意工作（或另一次 create），所以过期的 prepared 会话
   * 不能覆盖同 id 的活商店条目——它的 detach disposer 之后删除的会是「真」会话。
   * {@link create} 便捷方法与 agent 工厂总是背靠背调用两者，永远不会触发此问题，
   * 但公共 API 不能假设这一点。
   *
   * @param session - an unentered session; independent instances become store-owned.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  // enter：进入商店——安装发布钩子；公告完成前写仍禁用；返回 detach disposer；
  // 不发 session/created（调用方先 yield detach 再 announce，保证回滚安全）。
  enter(session: Session): () => void {
    const id = session.id
    // 构造作用域路由载体（继承商店上下文的作用域）。
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    // This is the authoritative collision boundary after arbitrary unpublished
    // preparation. Only one exact same-id transaction can publish.
    // 上游注释：这是任意未发布准备后的权威冲突边界。
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    // 已attached 到别的商店（或已进入）拒绝。
    if (attachments.get(session) != null) throw new Error(`session "${id}" is already attached to a store`)
    // 建条目：公告 pending、无进行中追加。
    const entry: SessionEntry = {
      id,
      session,
      carrier,
      emitCtx: this.ctx,
      announcement: 'pending',
      appending: false,
      detachRequested: false,
      detach: () => { this.detachEntered(entry) },
    }
    this.store.set(id, entry)
    attachments.set(session, entry)
    let entered = true
    // detach disposer：幂等；公告派发或追加发布中则延迟执行。
    const detach = (): void => {
      if (!entered) return
      entered = false
      // A lifecycle listener may own the advanced detach capability. Keep the
      // entry and its publication hooks live until synchronous creation or append
      // publication unwinds, then publish the paired disposal edge.
      // 上游注释：保留条目与发布钩子直到发布结束，再发配对的销毁边。
      if (entry.announcement === 'dispatching' || entry.appending) {
        entry.detachRequested = true
        return
      }
      entry.detach()
    }
    return detach
  }

  /** Remove one exact entered session and emit its paired disposal when announced. */
  // detachEntered：移除一个精确的已进入会话；过期句柄（条目已被替换）无效。
  private detachEntered(entry: SessionEntry): void {
    entry.detachRequested = false
    // A stale capability cannot remove observers or storage belonging to a
    // later same-id lifecycle.
    // 上游注释：过期能力不能动后来同 id 生命周期的东西。
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    // 交还 null 条目（商店-owned 但已移除——禁止再追加）。
    attachments.set(entry.session, null)
    // 已公告过的：发配对销毁通知。
    if (entry.announcement !== 'pending') this.emitDisposed(entry)
  }

  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}). The Session remains read-only throughout synchronous
   * dispatch; successful completion enables appends. A failed announcement
   * leaves it read-only and cannot be retried.
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  // announce（上游注释）：对已进入会话精确发一次 session/created——
  // 与 enter 分离使调用方能先 yield detach（回滚安全）；
  // 同步派发期间会话只读；成功后开放追加；失败不可重试。
  announce(session: Session): void {
    const entry = this.liveEntryFor(session)
    if (entry.announcement !== 'pending') {
      throw new Error(`session "${entry.id}" was already announced`)
    }
    // Partial creation dispatch still requires disposal on rollback; listeners
    // cannot recursively begin another announcement.
    // 上游注释：部分派发也要支持回滚；监听器不能递归再公告。
    const callbackArgs: unknown[] = [session]
    entry.announcement = 'dispatching'
    try {
      // 解析监听器快照后逐个同步调用。
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])
      for (const callback of callbacks) {
        // Synchronous throws intentionally propagate and veto publication; the
        // yielded detach then emits the paired disposal edge. An async function
        // is nevertheless assignable to a void listener, so observe its returned
        // promise: rejection is too late to roll back and must be logged instead
        // of becoming unhandled.
        // 上游注释：同步抛错传播并否决发布（回滚）；异步 reject 已无法回滚，
        // 记日志避免 unhandled rejection。
        const returned: unknown = callback(...callbackArgs)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`session "${entry.id}": session/created listener rejected: ${String(error)}`)
        })
      }
      // 成功：开放追加。
      entry.announcement = 'complete'
    } catch (error: unknown) {
      // 失败：标记 failed（只读永久）并重抛。
      entry.announcement = 'failed'
      throw error
    } finally {
      // 发布期间请求过的 detach 现在执行。
      if (entry.detachRequested) entry.detach()
    }
  }

  /** Emit the paired teardown notification with per-listener containment. */
  // emitDisposed：发配对销毁通知（错误逐个隔离）。
  private emitDisposed(entry: SessionEntry): void {
    const callbackArgs: unknown[] = [entry.session]
    try {
      const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/disposed', entry.session])
      invokeContainedSessionObservers(this.ctx, 'session/disposed', entry.id, callbackArgs, callbacks)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session "${entry.id}": session/disposed dispatch threw: ${String(error)}`)
    }
  }

  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner
   * and one spelling.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  // flush（上游注释）：THE flush 入口——所有持久化排水都必须走这里
  //（一个所有者、一种写法）；等待全部监听器完成；任一失败则在全部完成后重抛第一个。
  async flush(session: Session): Promise<boolean> {
    const { carrier } = this.liveEntryFor(session)
    const callbackArgs: unknown[] = [session]
    const callbacks = collectSessionCallbacks(this.ctx, [carrier, 'session/flush', session])
    const results = await Promise.allSettled(callbacks.map((callback) => {
      try {
        return callback(...callbackArgs)
      } catch (error: unknown) {
        // Preserve the listener's exact rejection value; flush is a caller-owned
        // failure boundary, and Cordis listeners may throw arbitrary values.
        // 上游注释：保留监听器的原始 rejection 值（监听器可抛任意值）。
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        return Promise.reject(error)
      }
    }))
    // 全部完成后抛出第一个失败。
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
    // 返回是否有持久化监听器参与。
    return callbacks.length > 0
  }

  /** Return the exact live entry; detached/prepared objects reject. */
  // liveEntryFor：取精确活条目——脱管/未进入对象拒绝。
  private liveEntryFor(session: Session): SessionEntry {
    const entry = attachments.get(session)
    if (entry == null || this.store.get(entry.id) !== entry) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    return entry
  }

  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  // get：按 id 查活会话。
  get(id: SessionId): Session | undefined {
    return this.store.get(id)?.session
  }

  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  // list：全部活会话（创建序；返回新数组，改动不影响商店）。
  list(): Session[] {
    return [...this.store.values()].map(entry => entry.session)
  }

  /**
   * Create an independent live session from an exact prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. An open tail receives synthetic tool results and
   * step/turn closers with the forked cause. Closed steps and turns remain
   * unchanged, including any failed tool calls already missing results.
   * `inheritedEventCount` counts only copied source events, excluding these closers.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  // fork（上游注释）：从活来源的精确前缀创建独立活会话——
  // 开着的尾部补合成工具结果与 step/turn 收尾（forked 原因）；
  // 已关闭的步/回合原样保留；inheritedEventCount 只计拷贝的源事件。
  fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session {
    // 子 id 已占用：拒绝。
    if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
      throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    // 解析并校验来源（必须是本商店的活实例）。
    const liveSource = this._resolveForkSource(source)
    // oxlint-disable-next-line typescript/no-deprecated -- Existing fork snapshot read; migration deferred.
    // 上游注释：现有 fork 快照读法；迁移暂缓。
    const events = liveSource.snapshotEvents()
    // 解析边界（含校验）。
    const resolved = this._forkBoundary(liveSource.id, events, boundary)
    // 构造种子（含合成收尾）。
    const seed = resolved === undefined ? [] : buildForkSeed(events, resolved)
    // 创建子会话：继承长度 = 拷贝的源事件数；继承来源的 cwd。
    return this.create(childSessionId, {
      seed,
      inheritedEventCount: SessionLogOffset(resolved === undefined ? 0 : resolved + 1),
      meta: {
        ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
        isSeeded: true,
      },
    })
  }

  // _forkBoundary：解析并校验 fork 边界——非负安全整数、必须存在、必须与
  // 事件 seq 精确匹配（连续性）。
  private _forkBoundary(
    sessionId: SessionId, events: readonly SessionEvent[], requestedBoundary: SessionSeq | undefined,
  ): SessionSeq | undefined {
    const lastEvent = events.at(-1)
    let boundary: SessionSeq
    if (requestedBoundary !== undefined) {
      boundary = requestedBoundary
    } else {
      // 未给边界：空源 fork 空子代；否则取最后一个事件。
      if (lastEvent === undefined) return undefined
      boundary = lastEvent.seq
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new SessionForkError(
        `fork boundary for session "${sessionId}" must be a non-negative safe integer, got ${String(boundary)}`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundary >= events.length) {
      const lastSeq = lastEvent?.seq
      throw new SessionForkError(
        `fork boundary ${boundary} does not exist in session "${sessionId}" (last seq: ${lastSeq ?? 'none'})`,
        'INVALID_BOUNDARY',
      )
    }

    const boundaryEvent = events[boundary]
    if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new SessionForkError(
        `fork boundary ${boundary} does not match a contiguous event seq in session "${sessionId}"`,
        'INVALID_BOUNDARY',
      )
    }
    return boundary
  }

  // _resolveForkSource：解析 fork 来源——id 必须在商店里；对象必须是商店的
  // 活实例（防拿过期对象 fork）。
  private _resolveForkSource(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

}

// 其他出口：序号区间的紧凑编码/解码（导出与查询用）。
export { decodeSeqRanges, encodeSeqRanges } from './seq-ranges.ts'
export default SessionStore
