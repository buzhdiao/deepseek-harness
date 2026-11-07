// 网关(Gateway)自有 Remote 流与事件结果 RPC 所用的线上(wire)消息协议。
/** Wire messages for Gateway-owned Remote streams and event-result RPCs. */

// 引入品牌(Branded)工具类型，为各类 id 提供名义类型。
import type { Branded } from '@deepseek-ai/dsh-brand'
// 引入 JSON 值判别器：校验线上数据可无损序列化。
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'

/** Exact WebSocket route carrying every Typert Remote stream. */
// 承载全部 Typert Remote 流的固定 WebSocket 路由。
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** Gateway-internal logical stream carrying application-selected Cordis events. */
// 网关内部的逻辑流(logical stream)端点：承载应用选定的 Cordis 事件。
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Gateway-internal unary endpoint returning one Client Remote Event outcome. */
// 网关内部的一元(unary)端点：回传单个 Client Remote 事件的处理结果。
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Empty standard Remote payload used to open the forwarded-event stream. */
// 打开转发事件流所用的空标准 Remote 载荷(payload)。
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** Discriminator for the first item proving the Host event source is ready. */
// 首条条目的判别字段：证明 Host 事件源已就绪。
export const REMOTE_EVENT_STREAM_READY = { type: 'ready' } as const

/** Opaque identity for one active Client Remote Event generation. */
// 单个活跃 Client Remote 事件代(generation)的不透明身份。
export type RemoteEventClientId = Branded<'RemoteEventClientId'>

/** Opaque correlation id for one pending Host-to-Client Remote Event. */
// 单个待决的 Host→Client Remote 事件的不透明关联 id。
export type RemoteEventId = Branded<'RemoteEventId'>

/** Stable Host facts published with every established Client event generation. */
// 随每个已建立的 Client 事件代一起发布的 Host 静态事实。
export interface RemoteEventHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  // Host 账户主目录，仅用于缩略展示的文件系统路径。
  readonly home: string
}

/** Opening item that binds later HTTP results to this active event stream. */
// 开场条目：把后续的 HTTP 结果绑定到这条活跃事件流。
export interface RemoteEventReadyFrame {
  // 判别字段：就绪帧。
  readonly type: 'ready'
  // 本事件代的客户端标识。
  readonly clientId: RemoteEventClientId
  /** Stable Host facts attached to this connection generation. */
  // 附加到本连接代的 Host 静态事实。
  readonly host: RemoteEventHostInfo
}

/** Opaque Agent identity carried by one scoped Remote Event. */
// 单个作用域 Remote 事件所携带的不透明 Agent 身份。
export type RemoteEventAgentId = Branded<'RemoteEventAgentId'>

/** One Host notification delivered to a Client generation. */
// 投递给某个 Client 代的一个 Host 通知。
export interface RemoteEventEmitFrame {
  // 判别字段：通知帧。
  readonly type: 'emit'
  // 原始事件名。
  readonly event: string
  // 原始事件参数列表。
  readonly args: readonly unknown[]
}

/** One pending Agent-scoped waterfall delivered to a Client generation. */
// 投递给某个 Client 代的一个待决 Agent 作用域瀑布(waterfall)调用。
export interface RemoteEventInvocationFrame {
  // 判别字段：瀑布帧。
  readonly type: 'waterfall'
  // 原始事件名。
  readonly event: string
  // 关联 id，用于回传结果与取消。
  readonly eventId: RemoteEventId
  // 事件所属的 Agent 身份。
  readonly agentId: RemoteEventAgentId
  // 投影后的 JSON 安全请求字段。
  readonly request: Readonly<Record<string, unknown>>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
// 取消此前按同一 id 投递过的待决瀑布。
export interface RemoteEventCancellationFrame {
  // 判别字段：取消帧。
  readonly type: 'cancel'
  // 被取消事件的关联 id。
  readonly eventId: RemoteEventId
}

/** Every item carried by the Gateway-internal forwarded-event stream. */
// 网关内部转发事件流可承载的全部条目类型。
export type RemoteEventDownlinkFrame =
  // 就绪帧。
  | RemoteEventReadyFrame
  // 通知帧。
  | RemoteEventEmitFrame
  // 瀑布帧。
  | RemoteEventInvocationFrame
  // 取消帧。
  | RemoteEventCancellationFrame

/** JSON request fields plus the Host cancellation lifetime removed for transport. */
// JSON 请求字段，外加为传输而剥离出的 Host 取消生命周期信号。
export interface ProjectedRemoteEventRequest {
  // 去掉 Agent 与 signal 后的请求字段。
  readonly request: Readonly<Record<string, unknown>>
  // Host 侧的取消信号（可选）。
  readonly signal?: AbortSignal
}

/** Error fields retained when a Client listener rejects a Host waterfall. */
// Client 监听器拒绝 Host 瀑布时保留下来的错误字段。
export interface RemoteEventRejection {
  // 错误名。
  readonly name: string
  // 错误消息。
  readonly message: string
  // 可选的稳定错误码。
  readonly code?: string
  // 可选的 JSON 安全明细。
  readonly details?: unknown
}

/** Client response to one scoped Remote Event delivery. */
// Client 对单次作用域 Remote 事件投递的应答。
export interface RemoteEventResult {
  // 应答来自哪个事件代。
  readonly clientId: RemoteEventClientId
  // 应答针对哪个待决事件。
  readonly eventId: RemoteEventId
  // 三选一的处理结果。
  readonly outcome:
    // 放行：不处理，交还 Host 事件链继续。
    | { readonly kind: 'next' }
    // 结果：携带可选的返回值。
    | { readonly kind: 'result'; readonly value?: unknown }
    // 拒绝：携带可序列化的错误字段。
    | { readonly kind: 'rejected'; readonly error: RemoteEventRejection }
}

/**
 * Parse one result sent through the Client's `$events/result` HTTP RPC.
 * @param value - untrusted result payload.
 * @returns validated event correlation and outcome fields.
 */
export function parseRemoteEventResult(value: unknown): RemoteEventResult {
  // 顶层校验：必须是普通记录、键恰好为三个，且两个 id 与 outcome 都形状合法；否则统一报错。
  if (!isRecord(value)
    || !exactKeys(value, ['clientId', 'eventId', 'outcome'])
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventId(value.eventId)
    || !isRecord(value.outcome)) {
    throw new Error('api gateway: invalid Remote event result')
  }
  // 取出待判别的结果对象。
  const outcome = value.outcome
  // 放行分支：只允许携带 kind 一个键。
  if (outcome.kind === 'next' && exactKeys(outcome, ['kind'])) {
    // 原样回传放行结果。
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'next' },
    }
  }
  // 结果分支：value 键可缺席；存在时必须是合法 JSON 值。
  if (outcome.kind === 'result'
    && (exactKeys(outcome, ['kind']) || exactKeys(outcome, ['kind', 'value']))
    && (!Object.hasOwn(outcome, 'value') || isRemoteJsonValue(outcome.value))) {
    // 按是否携带 value 归一化返回。
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: Object.hasOwn(outcome, 'value')
        ? { kind: 'result', value: outcome.value }
        : { kind: 'result' },
    }
  }
  // 拒绝分支：error 字段递归校验。
  if (outcome.kind === 'rejected'
    && exactKeys(outcome, ['kind', 'error'])) {
    // 校验并回传拒绝结果。
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'rejected', error: parseRemoteEventRejection(outcome.error) },
    }
  }
  // 三种合法结果之外的一律拒绝。
  throw new Error('api gateway: invalid Remote event result')
}

/**
 * Remove the direct Agent and cancellation fields from one waterfall request.
 * @param value - request object before the waterfall's `next` callback.
 * @param subject - Agent used by the Cordis scope carrier.
 * @returns JSON-safe request fields and the optional Host cancellation signal.
 */
export function projectRemoteEventRequest(
  value: unknown,
  subject: object,
): ProjectedRemoteEventRequest {
  // 请求必须是普通对象，且直接携带与主体一致的作用域 Agent，否则拒绝。
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'agent') || value.agent !== subject) {
    throw new TypeError('api gateway: Remote event request must carry its scoped Agent directly')
  }
  // 取出可选的取消信号。
  const signal = value.signal
  // signal 若存在必须是 AbortSignal 实例。
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('api gateway: Remote event request signal must be an AbortSignal')
  }
  // 以无原型对象收集投影后的请求字段，避免原型链污染。
  const request: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  // 遍历自有键，剔除 agent 与 signal 两个非传输字段。
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'agent' || key === 'signal') continue
    // 非 string 键没有属性描述符，直接按不合规处理。
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
    // 只接受可枚举的 string 键：符号键或不可枚举属性都无法走 JSON 传输。
    if (typeof key !== 'string' || descriptor?.enumerable !== true) {
      throw new TypeError('api gateway: Remote event request has a non-JSON property')
    }
    // 逐键拷贝取值。
    request[key] = Reflect.get(value, key)
  }
  // 最终校验投影结果可无损 JSON 序列化。
  if (!isRemoteJsonValue(request)) {
    throw new TypeError('api gateway: Remote event request is not lossless JSON data')
  }
  // signal 缺省时不输出该键，保持载荷形状稳定。
  return {
    request,
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * Project an arbitrary rejection to stable, JSON-safe error fields.
 * @param reason - value thrown or rejected by a Client listener.
 * @returns wire-safe rejection fields.
 */
export function projectRemoteEventRejection(reason: unknown): RemoteEventRejection {
  // 只把普通对象当作错误载体，其他类型直接按字符串处理。
  const record = typeof reason === 'object' && reason !== null ? reason : undefined
  // 提取错误名，缺失时回退为 'Error'。
  const name = stringProperty(record, 'name') ?? 'Error'
  // 提取错误消息，缺失时把整个拒绝值字符串化。
  const message = stringProperty(record, 'message') ?? String(reason)
  // 提取可选错误码。
  const code = stringProperty(record, 'code')
  // 提取可选明细。
  const details = record === undefined ? undefined : Reflect.get(record, 'details') as unknown
  // code/details 只在存在且 JSON 安全时输出，缺省键不占位。
  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined || !isRemoteJsonValue(details) ? {} : { details }),
  }
}

/**
 * Recreate a Client rejection for the Host continuation.
 * @param rejection - validated wire-safe error fields.
 * @returns an Error preserving the remote name, code, and JSON-safe details.
 */
export function restoreRemoteEventRejection(rejection: RemoteEventRejection): Error {
  // 以消息重建 Error，并扩展可选的 code 与 details 槽位。
  const error = new Error(rejection.message) as Error & { code?: string; details?: unknown }
  // 还原远端错误名。
  error.name = rejection.name
  // 有码则还原码。
  if (rejection.code !== undefined) error.code = rejection.code
  // 有明细则还原明细。
  if (rejection.details !== undefined) error.details = rejection.details
  return error
}

/**
 * Recognize a non-empty Remote Event correlation id at a wire boundary.
 * @param value - untrusted wire value.
 * @returns whether the value is a valid Remote Event id.
 */
export function isRemoteEventId(value: unknown): value is RemoteEventId {
  // 事件关联 id：非空字符串即可。
  return typeof value === 'string' && value.length > 0
}

/**
 * Recognize a non-empty Remote Event Client id at a wire boundary.
 * @param value - untrusted wire value.
 * @returns whether the value identifies one event-stream generation.
 */
export function isRemoteEventClientId(value: unknown): value is RemoteEventClientId {
  // 事件代标识：非空字符串即可。
  return typeof value === 'string' && value.length > 0
}

/**
 * Recognize the direct Agent identity used by a scoped Remote Event.
 * @param value - untrusted wire value.
 * @returns whether the value is a non-empty Agent identity.
 */
export function isRemoteEventAgentId(value: unknown): value is RemoteEventAgentId {
  // Agent 身份：非空字符串即可。
  return typeof value === 'string' && value.length > 0
}

/** One logical stream request sent from the browser: open, one uplink item, uplink half-close, or cancel. */
// 浏览器发出的单个逻辑流请求：打开、一个上行条目、上行半关闭或取消。
export type RemoteStreamClientMessage =
  // 打开流：声明流 id、端点与载荷。
  | {
    readonly type: 'open'
    readonly streamId: string
    readonly endpoint: string
    readonly payload: unknown
  }
  // 上行条目：value 可缺席，表示顶层的 undefined。
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  // 上行半关闭：Client 不再发送条目。
  | { readonly type: 'end'; readonly streamId: string }
  // 取消整个逻辑流。
  | { readonly type: 'cancel'; readonly streamId: string }

/** Carrier-safe failure delivered by the Host. */
// Host 下发的载体安全失败信息。
export interface RemoteStreamFailure {
  // 稳定故障码。
  readonly code: string
  // 面向修正的诊断消息。
  readonly message: string
  // 结构化明细。
  readonly details: object
}

/** One logical stream frame sent from the Host. */
// Host 发出的单个逻辑流帧。
export type RemoteStreamServerMessage =
  // 下行条目。
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  // 终态失败帧。
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  // 正常结束帧。
  | { readonly type: 'end'; readonly streamId: string }

/**
 * Parse and validate one browser-to-Host text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream request.
 */
export function parseRemoteStreamClientMessage(text: string): RemoteStreamClientMessage {
  // 先做公共 JSON/对象解析，再按四种帧型逐一校验键与取值。
  return parseMessage(text, (value) => {
    // cancel 与 end：只允许 type + streamId 两个键。
    if ((value.type === 'cancel' || value.type === 'end')
      && exactKeys(value, ['type', 'streamId'])
      && validId(value.streamId)) {
      return value as RemoteStreamClientMessage
    }
    // item：value 键可缺席（顶层 undefined），存在时必须是合法 JSON 值。
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)
      && (!Object.hasOwn(value, 'value') || isRemoteJsonValue(value.value))) {
      return value as RemoteStreamClientMessage
    }
    // open：四个键齐全，流 id 与端点都非空。
    if (value.type === 'open'
      && exactKeys(value, ['type', 'streamId', 'endpoint', 'payload'])
      && validId(value.streamId)
      && typeof value.endpoint === 'string'
      && value.endpoint.length > 0) {
      return value as RemoteStreamClientMessage
    }
    // 四种帧型之外一律拒绝。
    throw new Error('api gateway: invalid Remote stream client message')
  })
}

/**
 * Parse and validate one Host-to-browser text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream frame.
 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  // 同样先公共解析，再按三种帧型校验（浏览器侧消费 Host 帧时使用）。
  return parseMessage(text, (value) => {
    // item：value 键可缺席，流 id 非空。
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    // end：只允许 type + streamId 两个键。
    if (value.type === 'end' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    // error：错误对象必须恰好是 code/message/details 三键且类型正确。
    if (value.type === 'error'
      && exactKeys(value, ['type', 'streamId', 'error'])
      && validId(value.streamId)
      && isRecord(value.error)
      && exactKeys(value.error, ['code', 'message', 'details'])
      && typeof value.error.code === 'string'
      && typeof value.error.message === 'string'
      && isRecord(value.error.details)) {
      return value as RemoteStreamServerMessage
    }
    // 三种帧型之外一律拒绝。
    throw new Error('api gateway: invalid Remote stream server message')
  })
}

function parseMessage<T>(text: string, validate: (value: Record<string, unknown>) => T): T {
  // 解码结果先放在 unknown 槽位，校验前不做任何假设。
  let decoded: unknown
  try {
    // 尝试 JSON 解码。
    decoded = JSON.parse(text) as unknown
  } catch (cause) {
    // 非法 JSON：带原因抛出，便于诊断。
    throw new Error('api gateway: Remote stream message is not JSON', { cause })
  }
  // 顶层必须是普通记录。
  if (!isRecord(decoded)) throw new Error('api gateway: Remote stream message must be an object')
  // 交给调用方的帧型校验器。
  return validate(decoded)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 记录：对象且非 null 且不是数组。
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // 先满足“记录”的底线。
  if (!isRecord(value)) return false
  // 再要求原型是 Object.prototype 或 null，排除自定义类实例与代理过的形状。
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  // 自有键（含符号键）数量必须一致，且每个期望键都真实存在。
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  // 流 id：非空字符串。
  return typeof value === 'string' && value.length > 0
}

function parseRemoteEventRejection(value: unknown): RemoteEventRejection {
  // 校验拒绝载荷：键白名单、name/message 必填非空、code 必须是字符串、details 必须是 JSON 值。
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['name', 'message'], ['code', 'details'])
    || typeof value.name !== 'string'
    || value.name.length === 0
    || typeof value.message !== 'string'
    || (Object.hasOwn(value, 'code') && typeof value.code !== 'string')
    || (Object.hasOwn(value, 'details') && !isRemoteJsonValue(value.details))) {
    throw new Error('api gateway: invalid Remote event rejection')
  }
  // 按存在性重建对象，缺省键不占位。
  return {
    name: value.name,
    message: value.message,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(Object.hasOwn(value, 'details') ? { details: value.details } : {}),
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  // 取全部自有键（含符号键）。
  const keys = Reflect.ownKeys(value)
  // 必填键都要在，且每个键都是 string 并落在必填或可选白名单内。
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
}

function stringProperty(value: object | undefined, key: string): string | undefined {
  // 载体缺席则无属性可取。
  if (value === undefined) return undefined
  // 以 unknown 取值避免类型系统放行非字符串。
  const candidate: unknown = Reflect.get(value, key)
  // 只有字符串才返回，否则视为缺失。
  return typeof candidate === 'string' ? candidate : undefined
}
