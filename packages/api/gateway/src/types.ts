// 与载体(carrier)无关的 Typert 网关(Gateway)请求、服务与错误契约。
/**
 * Carrier-independent Typert Gateway request, service, and error contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */

// 引入 Cordis 的 Context 类型：Host 侧服务与作用域的基础容器。
import type { Context } from '@deepseek-ai/cordis'
// 引入协议层类型：对等端(Peer)作用域、上行(uplink)窗口、资源读取器。
import type { PeerScope, RemoteUplinkWindow, TypertResourceReader } from '@deepseek-ai/dsh-typert-protocol'
// 引入流协议中事件客户端标识与 Host 静态信息的类型。
import type { RemoteEventAgentId, RemoteEventHostInfo } from './stream-protocol.ts'

/** One Remote method request after a carrier has decoded its envelope. */
// 载体解码信封(envelope)之后的单个 Remote 方法请求。
export interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  // 由生成描述符(descriptor)选定的 Remote 命名空间。
  readonly namespace: string
  /** Exported Service method name. */
  // 导出的服务方法名。
  readonly method: string
  /** Named wire values; fields must exactly match the descriptor. */
  // 具名线上取值；字段必须与描述符完全一致。
  readonly args: Readonly<Record<string, unknown>>
  /**
   * Client uplink items of this logical stream, delivered to the method through
   * `invocation.uplink()`; absent means an immediately ended iterable.
   */
  // 本逻辑流(logical stream)的客户端上行(uplink)条目，经 `invocation.uplink()` 交给方法；缺省表示立即结束的可迭代对象。
  readonly uplink?: AsyncIterable<unknown>
  /** Carrier-provided frame capacity; absent for carriers without an encoded-frame inbox limit. */
  // 载体提供的帧容量上限；没有编码帧收件箱(inbox)限制的载体则缺省。
  readonly uplinkWindow?: RemoteUplinkWindow | undefined
  /** Peer the call speaks for; every carrier and in-process caller names it explicitly. */
  // 本次调用所代表的对等端(Peer)；每种载体与进程内调用方都必须显式指明。
  readonly peer: PeerScope
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  // 载体或直接调用方的取消信号，只注入声明了可取消的方法。
  readonly signal?: AbortSignal
}

/** One Host Cordis notification forwarded unchanged to Client Remote subscribers. */
// 原样转发给 Client Remote 订阅者的单个 Host Cordis 通知。
export interface TypertRemoteEventFrame {
  /** Original Host Cordis event name. */
  // 原始的 Host Cordis 事件名。
  readonly event: string
  /** Original event argument list after the owner validates it for JSON transport. */
  // 原始事件参数列表，已由所有者(owner)验证可安全走 JSON 传输。
  readonly args: readonly unknown[]
  /**
   * Readers of the resources the arguments carry, keyed by resource kind and
   * called with the arguments as positional parameters. Absent or empty for
   * a notification that touches the global resource.
   */
  // 参数所携资源的读取器，按资源种类为键，并以参数作为位置参数调用；涉及全局资源的通知则缺省或为空。
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/** Live Host values used to project one scoped Remote Event. */
// 投影单个作用域 Remote 事件所需的 Host 活值。
export interface TypertRemoteEventContext {
  /** Live Agent Context that owns cancellation of the forwarded waterfall. */
  // 存活的 Agent Context，持有这次转发瀑布(waterfall)调用的取消权。
  readonly value: Context
  /** Agent object carried directly by the waterfall request. */
  // 瀑布请求直接携带的 Agent 对象。
  readonly subject: object
  /** Agent identity read directly from the scoped event subject. */
  // 直接从作用域事件主体上读取的 Agent 身份标识。
  readonly agentId: string
}

/** Result returned from a Client waterfall, or delegation back to the Host chain. */
// Client 瀑布调用的返回结果，或交还 Host 事件链的委托。
export type TypertRemoteEventOutcome =
  // 结果分支：把 Client 的处理结果交给源头的 Cordis 监听器。
  | { readonly kind: 'result'; readonly value: unknown }
  // 放行分支：Client 不处理，由 Host 事件链继续分发。
  | { readonly kind: 'next' }

/**
 * One scoped waterfall invocation yielded by the application event source.
 * The Gateway alone assigns transport ids and resolves the continuation after
 * a Client result or explicit delegation.
 */
// 应用事件源产出的单个作用域瀑布调用。只有网关负责分配传输 id，并在 Client 给出结果或显式委托后续接(continuation)。
export interface TypertRemoteEventInvocation {
  /** Original Host Cordis event name. */
  // 原始的 Host Cordis 事件名。
  readonly event: string
  /** Sole request argument before the waterfall's `next()` callback. */
  // 瀑布 `next()` 回调之前的唯一请求参数。
  readonly request: object
  // 投影该事件所需的 Host 活值（上下文、Agent 对象与身份）。
  readonly context: TypertRemoteEventContext
  /** Resume the source's Cordis listener with a Client result or `next()`. */
  // 用 Client 的结果或 `next()` 恢复苏方的 Cordis 监听器。
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  /** Reject the source's Cordis listener after cancellation, transport failure, or Client rejection. */
  // 在取消、传输失败或 Client 拒绝后，让源头的 Cordis 监听器以失败告终。
  readonly reject: (reason: unknown) => void
}

/** Notification or scoped waterfall accepted from the sole Remote Event source. */
// 从唯一的 Remote 事件源受理的通知或作用域瀑布。
export type TypertRemoteEventDispatch = TypertRemoteEventFrame | TypertRemoteEventInvocation

/**
 * Open the application-selected event stream for one Client carrier. The
 * factory must attach all incremental Host listeners before it returns; the
 * Gateway publishes its readiness item immediately afterward.
 * @param signal - cancellation shared with the Client stream and registration.
 * @returns the long-lived stream of notifications and scoped waterfall invocations.
 */
// 为单个 Client 载体打开应用选定的事件流。工厂必须在返回前挂好所有增量 Host 监听器；
// 网关随后立即发布其“就绪”条目。
export type TypertRemoteEventSource = (
  signal: AbortSignal,
) => AsyncIterable<TypertRemoteEventDispatch>

/** Carrier-facing access to decoded Remote streams and their stable failures. */
// 面向载体的入口：打开已解码的 Remote 流，并把失败转成稳定形式。
export interface TypertGatewayWireStream {
  /**
   * Open one logical stream from its wire endpoint and payload.
   * @param endpoint - canonical Remote endpoint or Gateway-owned stream name.
   * @param payload - decoded carrier payload.
   * @param uplink - Client-to-Host items of the logical stream; a Gateway-owned endpoint returns its iterator
   * as soon as it opens, so the carrier drops those items instead of buffering them.
   * @param peer - Peer the stream speaks for; required, never defaulted.
   * @param signal - logical-stream cancellation.
   * @returns validated stream values.
   */
  // 按线上端点与载荷打开一个逻辑流；网关自有端点会在打开瞬间返回迭代器，让载体直接丢弃上行条目而非缓存。
  readonly open: (
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerScope,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>

  /**
   * Convert a stream failure to the carrier-safe Remote failure fields.
   * @param error - failure raised while opening or consuming a stream.
   * @returns stable code, message, and details for the Client.
   */
  // 把流的失败转换为可安全回传载体的 Remote 失败字段（稳定的 code、message 与 details）。
  readonly failure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** Stable infrastructure and boundary failures emitted before or after business execution. */
// 业务执行前后发出的稳定基础设施与边界故障码。
export type TypertGatewayErrorCode =
  // 故障码清单，与 remote-error-codes.ts 中登记进共享映射的键一一对应（纯字面量登记项）。
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/input-invalid'
  | 'gateway/interactions-forbidden'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/peer-disposed'
  | 'gateway/protocol'
  | 'gateway/provider-mismatch'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'
  | 'gateway/uplink-overflow'

/** Public metadata of one unsettled forwarded Remote event. */
// 单个未决(forwarded)转发 Remote 事件的公开元数据。
export interface PendingRemoteEventInfo {
  // 事件名。
  readonly event: string
  // 事件所属的 Agent 身份。
  readonly agentId: RemoteEventAgentId
}

/** Host dispatcher consumed by Connection adapters. */
// 由 Connection 适配器消费的 Host 分发器。
export interface TypertGateway {
  /** Carrier adapter shared by WebSocket and in-process transports. */
  // WebSocket 与进程内传输共用的载体适配器。
  readonly wireStream: TypertGatewayWireStream

  /**
   * Check for an active owner Client event stream, the only kind that can answer forwarded waterfalls.
   * @returns whether an owner stream is open and has not been cancelled.
   */
  // 检查是否存在活跃的所有者(owner) Client 事件流——只有它能应答转发的瀑布。
  hasLiveClient(): boolean

  /** @returns detached metadata for all unsettled forwarded events in arrival order. */
  // 按到达顺序返回所有未决转发事件的脱钩元数据（修改不影响内部状态）。
  getPendingRemoteEvents(): readonly PendingRemoteEventInfo[]

  /**
   * Register the application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this exact source and cancelling its active streams.
   */
  // 注册应用选定的转发事件源；返回的释放器会移除该源并取消其活跃流。
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>

  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  // 调用一个存活的 Remote 方法，不假设载体与响应信封；返回未经输出解码的业务结果。
  invoke(request: InvokeRemoteRequest): Promise<unknown>

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
   * @returns a cancellation-aware iterable over the business results.
   */
  // 打开一个存活的流式 Remote 方法，不假设物理载体；返回可感知取消的业务结果迭代器。
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

// Context 类型扩充：在 Host 上下文上声明 `typertGateway` 服务访问点。
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host dispatcher for Typert Remote calls. */
    // Typert Remote 调用的 Host 分发器。
    typertGateway: TypertGateway
  }
}
