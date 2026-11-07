// 基于 Cordis 服务与注册提供者的 Typert Remote 实时分发。
// 一元(unary)传输与响应信封(envelope)属于 Connection；实时 Remote 流使用网关(Gateway)自有的 WebSocket 多路复用器(mux)。
/**
 * Live Typert Remote dispatch over Cordis Services and registered providers.
 * Unary transport and response envelopes belong to Connection; live Remote
 * streams use the Gateway-owned WebSocket mux.
 * @module @deepseek-ai/dsh-api-gateway
 */

// 引入 UUID 生成器：事件流与待决事件的传输 id。
import { randomUUID } from 'node:crypto'
// 引入 Cordis 的 Context、Service 基类与内部符号。
import { Context, Service, symbols } from '@deepseek-ai/cordis'
// 引入 Connection 的 RPC 附加数据与处理器类型。
import type {
  ConnectionRpcAttachment,
  ConnectionRpcHandler,
} from '@deepseek-ai/dsh-client-connection'
// 引入远程访问决策类型。
import type { RemoteAccessDecision } from '@deepseek-ai/dsh-api-remote-access'
// 引入调用资源与事件资源的读取逻辑。
import { callResources, eventResources } from './access.ts'
// 引入双端队列：事件队列底层缓冲。
import { Deque } from '@deepseek-ai/dsh-deque'
// 引入 Web 服务器升级路由类型。
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
// 引入定时器上限常量：校验心跳间隔配置。
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
// 仅类型的副作用导入：并入命令行配置的类型声明。
import type {} from '@deepseek-ai/dsh-cmdline'
// 引入 schemastery：声明服务的配置模式。
import z from '@deepseek-ai/schemastery'
// 透出网关故障明细类型，供两侧共用。
export type { TypertGatewayFaultDetails } from './remote-error-codes.ts'
// 引入协议层核心：Remote 错误、JSON 值判别、方法标记与各类描述符类型。
import {
  RemoteError,
  isRemoteJsonValue,
  remoteErrorOf,
  remoteMethods,
  type InvocationDescriptor,
  type InvocationParameterDescriptor,
  type PeerScope,
  type Principal,
  type RemoteAccessResource,
  type RemoteInvocation,
  type RemoteMethodMarker,
  type TypertCodec,
  type TypertGatewayBinding,
} from '@deepseek-ai/dsh-typert-protocol'
// 引入本包的请求/事件/分发器契约类型。
import type {
  InvokeRemoteRequest,
  PendingRemoteEventInfo,
  TypertGateway,
  TypertGatewayErrorCode,
  TypertGatewayWireStream,
  TypertRemoteEventDispatch,
  TypertRemoteEventFrame,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from './types.ts'
// 引入 WebSocket 多路复用服务器与升级拒绝工具。
import {
  RemoteStreamMuxServer,
  rejectRemoteStreamUpgrade,
} from './stream-server.ts'
// 引入事件流协议：常量、id 判别与结果解析/投影工具。
import {
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_READY,
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_STREAM_MUX_PATH,
  isRemoteEventAgentId,
  parseRemoteEventResult,
  projectRemoteEventRequest,
  restoreRemoteEventRejection,
  type RemoteEventCancellationFrame,
  type RemoteEventClientId,
  type RemoteEventEmitFrame,
  type RemoteEventHostInfo,
  type RemoteEventId,
  type RemoteEventInvocationFrame,
  type RemoteEventReadyFrame,
  type RemoteStreamFailure,
} from './stream-protocol.ts'

// 包级透出 types.ts 的全部公共契约。
export type {
  InvokeRemoteRequest,
  PendingRemoteEventInfo,
  TypertGateway,
  TypertGatewayErrorCode,
  TypertGatewayWireStream,
  TypertRemoteEventContext,
  TypertRemoteEventDispatch,
  TypertRemoteEventFrame,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from './types.ts'
// 透出事件流的 Host 静态信息类型。
export type { RemoteEventHostInfo } from './stream-protocol.ts'

// 网关错误的构造选项。
interface GatewayErrorOptions {
  // 被包含的原始原因。
  readonly cause?: unknown
  // 故障针对的具体线上字段。
  readonly field?: string
}

// 解析后的 Remote 绑定。
interface ResolvedBinding {
  // 网关绑定描述。
  readonly binding: TypertGatewayBinding
  // 服务接收者的未代理原始对象。
  readonly original: object
}

// 完成校验与解析、可直接调用的 invocation 准备产物。
interface PreparedInvocation {
  // 规范端点 `<namespace>/<method>`。
  readonly endpoint: string
  // 解析出的调用描述符(descriptor)。
  readonly descriptor: InvocationDescriptor
  /** Service view bound to a Context carrying `invocation`, so the method reads it as `this.ctx.invocation`. */
  // 绑定到携带 `invocation` 的 Context 的服务视图，方法以 `this.ctx.invocation` 读取本次调用。
  readonly receiver: object
  // 解析完成的实参列表。
  readonly args: readonly unknown[]
  // 待调用的方法函数。
  readonly method: (...args: never[]) => unknown
  // 本次调用的 invocation 上下文对象。
  readonly invocation: GatewayInvocation
}

/** Carrier inputs `GatewayInvocation.uplink()` decodes on first use. */
// `GatewayInvocation.uplink()` 首次使用时才解码的载体(carrier)输入。
interface UplinkSource {
  // 上行(uplink)窗口容量（可缺省）。
  readonly window: RemoteInvocation['uplinkWindow']
  /** Carrier items; an immediately ended iterable when the carrier has none. */
  // 载体条目流；载体没有条目时是立即结束的迭代器。
  readonly source: AsyncIterable<unknown>
  /** Descriptor codec, or the JSON-safety codec when the descriptor declares no uplink. */
  // 描述符的编解码器(codec)；描述符未声明上行时退化为 JSON 安全检查。
  readonly codec: TypertCodec
  // 所属规范端点，用于报错。
  readonly endpoint: string
  // 以 Remote 失败为原因让整条逻辑流失败。
  /** Fail the logical stream with a Remote failure as the reason. */
  readonly abort: (reason: unknown) => void
}

// 已注册的转发事件源登记项。
interface RegisteredRemoteEventSource {
  // 该源的生命周期取消控制器。
  readonly lifetime: AbortController
  // 源消费完成（或失败）的 Promise。
  readonly done: Promise<void>
  // 随每代开场帧发布的 Host 静态信息。
  readonly host: RemoteEventHostInfo
}

// 一个接入的 Client 事件流代(generation)。
interface RemoteEventClient {
  // 该流代表的对等端(Peer)。
  readonly peer: PeerScope
  // 事件代的不透明 id。
  readonly id: RemoteEventClientId
  // 该代的下行帧队列。
  readonly queue: RemoteEventQueue
  // 该代生命周期信号。
  readonly signal: AbortSignal
  // 已投递到该代的待决事件表。
  readonly deliveries: Map<RemoteEventId, PendingRemoteEvent>
  /** The stream's Peer principal: only the owner answers scoped waterfalls and receives every broadcast. */
  // 该流 Peer 的主体(principal)：只有所有者(owner)应答作用域瀑布并接收全部广播。
  readonly principal: Principal
  /** Only owner streams receive scoped waterfalls they could answer; other Peers receive admitted broadcasts only. */
  // 只有所有者流接收其可应答的作用域瀑布；其他 Peer 只接收通过访问判定的广播。
  readonly answers: boolean
}

// 一个待决的转发 Remote 事件（作用域瀑布）。
interface PendingRemoteEvent {
  // 关联 id。
  readonly id: RemoteEventId
  // 原始事件源 invocation。
  readonly source: TypertRemoteEventInvocation
  // 投递给 Client 的线上帧。
  readonly frame: RemoteEventInvocationFrame
  // 已收到该事件投递的 Client 集合。
  readonly deliveries: Set<RemoteEventClient>
  // 释放 Agent Context 副作用的闭包。
  releaseContext: () => void
  // 注销取消信号监听的闭包。
  releaseSignal: () => void
}

// Connection RPC 的结果与错误形状。
type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>
type ConnectionRpcError = Extract<ConnectionRpcResult, { readonly ok: false }>['error']
// 永不中止的哨兵信号：给不需要取消的方法兜底。
const NEVER_ABORTED_SIGNAL = new AbortController().signal
// 心跳间隔默认值：2 秒。
const DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2_000
// 上行收件箱字节预算默认值：256 KiB。
const DEFAULT_STREAM_INBOX_BYTES = 262_144
// 空上行：载体没有条目时的立即结束迭代器。
const EMPTY_ASYNC_ITERABLE: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
}
// 复用的“迭代结束”结果对象。
const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }
// SRC 弱描述符专用的 JSON 安全编解码器。
const SRC_JSON_CODEC: TypertCodec = { mode: 'src-json' }

/** Gateway transport configuration. */
// 网关传输配置。
export interface Config {
  /** WebSocket Ping interval from 1 through 2,147,483,647 milliseconds. @default 2000 */
  // WebSocket Ping 间隔，1 到 2,147,483,647 毫秒，默认 2000。
  readonly websocketHeartbeatIntervalMs?: number
  /** Buffered uplink frame bytes one logical stream may hold before it fails with `gateway/uplink-overflow`. @default 262144 */
  // 单个逻辑流失败（`gateway/uplink-overflow`）前允许缓冲的上行帧字节，默认 262144。
  readonly streamInboxBytes?: number
  /** Per-message compression for the Remote stream WebSocket; `'none'` disables the extension. @default 'deflate' */
  // Remote 流 WebSocket 的逐消息压缩；`'none'` 禁用该扩展，默认 'deflate'。
  readonly websocketCompression?: 'none' | 'deflate'
}

// 校验补全后的配置（三项均必有值）。
interface ResolvedConfig extends Config {
  readonly websocketHeartbeatIntervalMs: number
  readonly streamInboxBytes: number
  readonly websocketCompression: 'none' | 'deflate'
}

/**
 * Dispatch failure produced outside the invoked business method. Rides the
 * shared Remote failure vocabulary, so its code crosses the wire instead of
 * folding to `internal`.
 */
// 业务方法之外产生的分发失败。搭乘共享 Remote 失败词汇表，因此其 code 能跨线传输，而不会折叠成 `internal`。
export class TypertGatewayError extends RemoteError<TypertGatewayErrorCode> {
  /** Canonical `<namespace>/<method>` endpoint. */
  // 规范的 `<namespace>/<method>` 端点。
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  // 故障针对具体字段时受影响的线上字段名。
  readonly field: string | undefined

  /**
   * Construct a Gateway failure without embedding boundary values in its message.
   * @param code - stable failure category.
   * @param endpoint - canonical Remote endpoint.
   * @param message - correction-oriented diagnostic without sensitive values.
   * @param options - optional field and contained cause.
   */
  constructor(
    code: TypertGatewayErrorCode,
    endpoint: string,
    message: string,
    options: GatewayErrorOptions = {},
  ) {
    // 交给 RemoteError 基类：message 前缀端点，details 携带端点与可选字段，cause 可选包含。
    super(
      code,
      `typert gateway: ${endpoint}: ${message}`,
      { endpoint, ...options.field === undefined ? {} : { field: options.field } },
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    // 命名错误类型，便于跨边界识别。
    this.name = 'TypertGatewayError'
    this.endpoint = endpoint
    this.field = options.field
  }
}

/**
 * Resolve strict generated definitions or conservative SRC markers against
 * current Cordis Services and Typert providers.
 * @typert service typertGateway
 */
// 针对当前 Cordis 服务与 Typert 提供者，解析严格生成定义或保守的 SRC 标记。
export class TypertGatewayService extends Service implements TypertGateway {
  // 依赖注入：Typert 注册表与远程访问服务。
  static inject = ['typert', 'remoteAccess']
  // 配置模式：三个传输参数及其默认值。
  static Config: z<Config> = z.object({
    // 心跳间隔：正整数且不超过定时器上限，默认 2000ms。
    websocketHeartbeatIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS),
    // 上行收件箱字节：正整数，默认 256KiB。
    streamInboxBytes: z.number().step(1).min(1).default(DEFAULT_STREAM_INBOX_BYTES),
    // 压缩开关：枚举 'none' | 'deflate'，默认压缩。
    websocketCompression: z.union([z.const('none'), z.const('deflate')]).default('deflate'),
  })

  /** Carrier adapter shared by the WebSocket mux and local Host transports. */
  // WebSocket 多路复用器与本地 Host 传输共用的载体适配器。
  readonly wireStream: TypertGatewayWireStream = {
    // 打开流：为本流新建取消控制器后转交内部实现。
    open: (endpoint, payload, uplink, peer, signal) =>
      this.openWireStream(endpoint, payload, uplink, peer, signal, new AbortController()),
    // 失败映射：复用 RPC 的错误转线上值逻辑。
    failure: error => rpcError(error),
  }

  // SRC 弱声明的端点声明缓存（服务结构变化时失效）。
  private srcClaims: ReadonlySet<string> | undefined
  // 唯一的转发事件源登记。
  private remoteEvents: RegisteredRemoteEventSource | undefined
  // 活跃的 Client 事件流代表。
  private readonly remoteEventClients = new Map<RemoteEventClientId, RemoteEventClient>()
  // 待决的转发事件代表。
  private readonly pendingRemoteEvents = new Map<RemoteEventId, PendingRemoteEvent>()

  /**
   * Register the Gateway against the active Typert registry.
   * WebSocket admission waits for launcher-owned application readiness when supplied;
   * direct invocation and in-process streams remain available independently.
   * @param ctx - owning Host Context with Typert registry access.
   * @param config - validated Gateway transport configuration.
   */
  constructor(ctx: Context, config: Config) {
    // 以 'typertGateway' 为键注册到宿主 Context。
    super(ctx, 'typertGateway')
    // 配置已经 schemastery 校验补全，这里直接断言形状。
    const resolved = config as ResolvedConfig
    // 服务结构任何变化都使 SRC 端点声明缓存失效。
    ctx.on('internal/service', () => {
      this.srcClaims = undefined
    })
    // 有 Connection 时：拦截 /api 前缀的 RPC，由本网关分发。
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        // 声明判定：本端点是否由网关受理。
        endpoint => this.claimsEndpoint(endpoint),
        // 分发函数：转发端点、载荷、取消信号与 Peer。
        (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer),
      )
    })
    // 同时有 Connection 与 Web 服务器时：装配 WebSocket 多路复用升级路由。
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      const listen = (): void => {
        // 建立多路复用服务器：开启器补充取消信号与控制器参数。
        const mux = new RemoteStreamMuxServer(
          (endpoint, payload, uplink, peer, control, window) =>
            this.openWireStream(endpoint, payload, uplink, peer, control.signal, control, window),
          // 复用统一的失败映射。
          this.wireStream.failure,
          {
            // 三项传输配置透传。
            heartbeatIntervalMs: resolved.websocketHeartbeatIntervalMs,
            streamInboxBytes: resolved.streamInboxBytes,
            compression: resolved.websocketCompression === 'deflate',
          },
        )
        // 各连接 Peer 释放的完成 Promise 集合。
        const releases = new Set<Promise<void>>()
        // 注册副作用：挂载升级路由，并在作用域释放时关闭 mux 并等待全部释放。
        webCtx.effect(function* () {
          yield async () => {
            await mux.close()
            await Promise.all(releases)
          }
          // 定义多路复用路径的升级路由。
          const route: WebUpgradeRoute = {
            path: REMOTE_STREAM_MUX_PATH,
            handler: (req, socket, head) => {
              // 先做连接受理（鉴权等），被拒则手写 HTTP 拒绝。
              const admission = webCtx.connection.admitConnection(req)
              if ('rejection' in admission) {
                rejectRemoteStreamUpgrade(socket, admission.rejection)
                return
              }
              const release = (): void => {
                // release removes the API Peer synchronously, before awaiting
                // scope cleanup or any logical-stream iterator's return.
                // release 同步移除 API Peer，先于作用域清理与任何逻辑流迭代器的返回。
                const done = admission.release().catch((error: unknown) => {
                  console.error('[api-gateway] Peer release failed:', error)
                })
                releases.add(done)
                void done.then(() => { releases.delete(done) })
              }
              const closed = (): void => {
                // 关闭时先摘掉 error 监听再释放，避免重复释放。
                socket.removeListener('error', release)
                release()
              }
              // 套接字出错或关闭都要释放 Peer。
              socket.on('error', release)
              socket.once('close', closed)
              if (socket.destroyed) {
                // 已销毁的套接字直接走关闭路径。
                closed()
                return
              }
              try {
                // 把升级交给多路复用服务器。
                mux.handleUpgrade(req, socket, head, admission.peer)
              } catch (error) {
                // 升级失败：释放 Peer、销毁套接字并记日志。
                release()
                socket.destroy()
                console.error('[api-gateway] Remote stream upgrade failed:', error)
              }
            },
          }
          // 交由 Web 服务器登记该升级路由。
          yield webCtx.webServer.registerUpgrade(route)
        }, `api-gateway: ${REMOTE_STREAM_MUX_PATH} WebSocket`)
      }
      // Existing pages reconnect before the new Host prints its URL. No stream
      // may enter until the launcher has activated and audited its controllers.
      // 旧页面会在新 Host 打印 URL 之前重连。启动器激活并审计完控制器之前，任何流都不得进入。
      const ready = webCtx.get('appReady')
      if (ready === undefined) listen()
      // 有就绪门卫时：等 onReady 再开始监听，卸载时注销回调。
      else webCtx.effect(() => {
        let closed = false
        const cancel = ready.onReady(() => { if (!closed) listen() })
        return () => {
          closed = true
          cancel()
        }
      }, 'api-gateway: application readiness')
    })
  }

  /**
   * Check for an active owner Client event stream, the only kind that can answer forwarded waterfalls.
   * @returns whether an owner stream is open and has not been cancelled.
   */
  hasLiveClient(): boolean {
    // 遍历所有事件流代，找仍可应答且未被取消的所有者。
    for (const client of this.remoteEventClients.values()) {
      if (client.answers && !client.signal.aborted) return true
    }
    // 没有则返回否。
    return false
  }

  /**
   * Inspect unsettled forwarded events without changing their lifetime.
   * @returns detached event names and Agent identities.
   */
  getPendingRemoteEvents(): readonly PendingRemoteEventInfo[] {
    // 快照所有待决事件，只投影事件名与 Agent 身份两个公开字段。
    return [...this.pendingRemoteEvents.values()].map(({ frame }) => ({ event: frame.event, agentId: frame.agentId }))
  }

  /**
   * Register the sole application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void> {
    // 事件源唯一：重复注册直接报错。
    if (this.remoteEvents !== undefined) {
      throw new Error('typert gateway: forwarded Remote event source is already registered')
    }
    // 该源的生命周期控制器。
    const lifetime = new AbortController()
    // 以生命周期信号打开应用事件流。
    const stream = source(lifetime.signal)
    // 消费事件流；非预期失败时关闭全部事件并中止生命周期。
    const done = this.consumeRemoteEvents(stream, lifetime.signal).catch((error: unknown) => {
      // 已被移除或已中止的登记不再二次处理。
      if (this.remoteEvents?.lifetime !== lifetime || lifetime.signal.aborted) return
      // 以失败关闭全部事件、摘除登记并中止生命周期。
      this.closeRemoteEvents(error)
      this.remoteEvents = undefined
      lifetime.abort(error)
    })
    // 登记该源（home 只保留字符串事实）。
    const registration: RegisteredRemoteEventSource = { lifetime, done, host: { home: host.home } }
    // 写入当前事件源槽位。
    this.remoteEvents = registration
    // 返回移除该源的释放器。
    return async () => {
      if (this.remoteEvents === registration) {
        // 摘除登记并以“已移除”为原因取消源与全部待决事件。
        this.remoteEvents = undefined
        // 构造移除错误作为取消原因。
        const error = new Error('typert gateway: forwarded Remote event source was removed')
        registration.lifetime.abort(error)
        this.closeRemoteEvents(error)
      }
      // 等消费循环结束。
      await registration.done
    }
  }

  private claimsEndpoint(endpoint: string): boolean {
    // 网关自有的事件结果端点始终由本网关受理。
    if (endpoint === REMOTE_EVENT_RESULT_ENDPOINT) return true
    // 端点必须形如 `<namespace>/<method>` 两段。
    const segments = endpoint.split('/')
    if (segments.length !== 2 || segments[0] === '' || segments[1] === '') return false
    // 严格注册表中有定义（或见过）即受理。
    if (this.ctx.typert.local.get(endpoint) !== undefined || this.ctx.typert.local.hasSeen(endpoint)) return true
    // 否则退回 SRC 弱声明的端点集合（惰性收集并缓存）。
    this.srcClaims ??= this.collectSrcClaims()
    return this.srcClaims.has(endpoint)
  }

  /**
   * The `resources` readers of a method, read from the root Service's class
   * metadata so a Context method's receiver is not resolved before access is
   * decided; `undefined` when the Service is absent or the method declares none.
   */
  private resourceReaders(descriptor: InvocationDescriptor): RemoteMethodMarker['resources'] {
    // 从根 Service 的类元数据读取方法的 resources 声明，
    // 这样在访问判定前不会先解析 Context 方法的接收者。
    const receiver: unknown = this.ctx.get(descriptor.service)
    if (!isObject(receiver)) return undefined
    // 实现方法可能区别于导出名。
    const member = descriptor.implementation ?? descriptor.method
    // 找到匹配标记并返回其资源读取器。
    return remoteMethods(originalOf(receiver)).find(marker => marker.method === member)?.resources
  }

  private collectSrcClaims(): ReadonlySet<string> {
    // 收集所有 SRC 弱声明暴露的端点。
    const claims = new Set<string>()
    // 遍历 Context 属性表，只看服务类型的项。
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver: unknown = this.ctx.get(serviceKey)
      if (!isObject(receiver)) continue
      // 取未代理的原始对象，读类上的 Remote 标记。
      const original = originalOf(receiver)
      const binding: unknown = Reflect.get(original, 'typertRemote')
      // 绑定缺失或命名空间不是字符串则跳过。
      if (!isObject(binding) || typeof Reflect.get(binding, 'namespace') !== 'string') continue
      const namespace = Reflect.get(binding, 'namespace') as string
      // 逐个方法登记其规范端点。
      for (const candidate of remoteMethods(original)) {
        claims.add(endpointOf(namespace, candidate.exportName ?? candidate.method))
      }
    }
    return claims
  }

  /**
   * Invoke one live Remote method through strict generated reflection or SRC markers.
   * @param request - decoded endpoint and exact named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  async invoke(request: InvokeRemoteRequest): Promise<unknown> {
    // 先准备（校验/解析/资源判定），再调用；一元调用不需要外部取消控制。
    return this.invokePrepared(await this.prepareInvocation(request, new AbortController()))
  }

  private async invokePrepared(prepared: PreparedInvocation): Promise<unknown> {
    // 流式方法不允许走一元通道。
    if (prepared.descriptor.mode !== undefined) {
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        prepared.endpoint,
        'stream Remote methods must be opened through the stream carrier',
      )
    }

    try {
      // 以准备好的接收者与实参调用业务方法。
      return await Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
    } catch (error) {
      // 调用期间被中止：以共享词汇表达取消。
      if (prepared.invocation.signal.aborted) throw remoteCancelled(prepared.endpoint, error)
      throw error
    } finally {
      // A unary call's uplink is readable only while the method runs.
      // 一元调用的上行只在方法运行期间可读。
      await prepared.invocation.close()
    }
  }

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
   * @returns a cancellation-aware iterable over the business results.
   */
  async stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> {
    // 打开流式方法：自建取消控制器。
    return this.openStream(request, new AbortController())
  }

  /**
   * `control` belongs to the logical stream: a rejected uplink item aborts it
   * with the Remote failure as the reason so the carrier delivers that failure.
   */
  // `control` 属于逻辑流本身：被拒的上行条目会以该 Remote 失败为原因中止它，让载体把失败送达客户端。
  private async openStream(request: InvokeRemoteRequest, control: AbortController): Promise<AsyncIterable<unknown>> {
    // 先准备并校验。
    const prepared = await this.prepareInvocation(request, control)
    // 一元方法不允许走流通道。
    if (prepared.descriptor.mode === undefined) {
      await prepared.invocation.close()
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        prepared.endpoint,
        'unary Remote methods cannot be opened through the stream carrier',
      )
    }
    let source: unknown
    try {
      // 调用业务方法拿到返回的（异步）可迭代对象。
      source = Reflect.apply(prepared.method, prepared.receiver, prepared.args) as unknown
    } catch (error) {
      // 失败即释放上行，再按取消或原样抛出。
      await prepared.invocation.close()
      if (prepared.invocation.signal.aborted) throw remoteCancelled(prepared.endpoint, error)
      throw error
    }
    // 返回值必须是同步或异步可迭代对象。
    if (!isIterable(source)) {
      await prepared.invocation.close()
      throw new TypertGatewayError(
        'gateway/result-invalid',
        prepared.endpoint,
        'stream Remote method did not return Iterable or AsyncIterable',
        { field: 'result' },
      )
    }
    // 包装成可取消的下行流。
    return cancellableStream(source, prepared.endpoint, prepared.invocation)
  }

  private async dispatchRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): Promise<ConnectionRpcResult> {
    // 事件结果端点：专门处理 Client 回传的事件应答。
    if (endpoint === REMOTE_EVENT_RESULT_ENDPOINT) {
      try {
        // Peer 必须存活且允许交互。
        assertPeerLive(peer, endpoint)
        requireInteractions(peer, endpoint)
        // 只有所有者 Peer 能应答转发的 Remote 事件。
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
        if (peer.principal.kind !== 'owner') {
          throw new TypertGatewayError('gateway/invocation-unavailable', endpoint, 'only owner Peers answer forwarded Remote events')
        }
        // 解析并校验结果载荷。
        const result = parseRemoteEventResultPayload(payload)
        // 找到结果所属的事件流代。
        const client = this.remoteEventClients.get(result.clientId)
        if (client === undefined) {
          throw new Error('typert gateway: Remote event result identifies no active event stream')
        }
        // 结果必须来自建立该事件流的同一 Peer。
        if (client.peer !== peer) {
          throw new TypertGatewayError(
            'gateway/interactions-forbidden', endpoint,
            'Remote event result belongs to another Peer',
          )
        }
        // 按结果落定或取消待决事件。
        this.receiveRemoteEventResult(client, result)
        // 事件结果 RPC 的应答载荷为空。
        return { ok: true, value: undefined }
      } catch (error) {
        // 一切失败都转成标准 RPC 错误。
        return rpcFailure(error)
      }
    }
    // 其余端点走普通一元调用。
    return this.invokeRpc(endpoint, payload, signal, peer)
  }

  private async openWireStream(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerScope,
    signal: AbortSignal,
    control: AbortController,
    uplinkWindow?: RemoteInvocation['uplinkWindow'],
  ): Promise<AsyncIterable<unknown>> {
    // 网关自有的事件流端点。
    if (endpoint === REMOTE_EVENT_STREAM_ENDPOINT) {
      // A Gateway-owned stream reads no uplink: releasing it now keeps its items out of the bounded inbox.
      // 网关自有流不读上行：立即释放，避免其条目挤占有界收件箱。
      releaseUplink(uplink)
      // Peer 必须存活且允许交互。
      assertPeerLive(peer, endpoint)
      requireInteractions(peer, endpoint)
      return this.openRemoteEvents(payload, signal, peer)
    }
    // 普通业务流：补齐上行与窗口后走 openStream。
    return this.openStream({ ...remoteRequest(endpoint, payload, signal, peer), uplink, uplinkWindow }, control)
  }

  private async *openRemoteEvents(
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): AsyncGenerator<
    RemoteEventEmitFrame | RemoteEventInvocationFrame | RemoteEventCancellationFrame
    | RemoteEventReadyFrame
  > {
    // 载荷必须恰好是 `{ args: {} }`：空参数对象。
    if (!isObject(payload)
      || !isPlainObject(payload)
      || Reflect.ownKeys(payload).length !== 1
      || !Object.hasOwn(payload, 'args')
      || !isObject(payload.args)
      || !isPlainObject(payload.args)
      || Reflect.ownKeys(payload.args).length !== 0) {
      throw new TypertGatewayError(
        'gateway/arguments-invalid',
        REMOTE_EVENT_STREAM_ENDPOINT,
        'forwarded Remote event stream requires an empty args object',
      )
    }
    // 读取当前登记的转发事件源。
    const registration = this.remoteEvents
    if (registration === undefined) {
      // 尚未注册：服务不可用。
      throw new TypertGatewayError(
        'gateway/service-unavailable',
        REMOTE_EVENT_STREAM_ENDPOINT,
        'forwarded Remote event source is unavailable',
      )
    }
    // 本代生命周期：请求取消、源取消或 Peer 取消任一触发。
    const lifetime = AbortSignal.any([signal, registration.lifetime.signal, peer.signal])
    // 生成本代唯一 id（撞车则重试）。
    let clientId = randomUUID() as RemoteEventClientId
    while (this.remoteEventClients.has(clientId)) clientId = randomUUID() as RemoteEventClientId
    // 登记新的 Client 事件代。
    const client: RemoteEventClient = {
      peer,
      id: clientId,
      queue: new RemoteEventQueue(),
      signal: lifetime,
      deliveries: new Map(),
      principal: peer.principal,
      // 只有所有者主体能应答作用域瀑布。
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
      answers: peer.principal.kind === 'owner',
    }
    // 将新代加入活跃代表表。
    this.remoteEventClients.set(clientId, client)
    if (client.answers) {
      // 所有者接入即补投当前全部待决事件（按到达顺序）。
      for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)
    }
    try {
      // 先发就绪帧，再持续吐出队列帧。
      yield { ...REMOTE_EVENT_STREAM_READY, clientId, host: registration.host }
      yield* client.queue.iterate(lifetime)
    } finally {
      // 代结束（正常、取消或出错）都做清理。
      this.removeRemoteEventClient(client)
    }
  }

  private async consumeRemoteEvents(
    source: AsyncIterable<TypertRemoteEventDispatch>,
    signal: AbortSignal,
  ): Promise<void> {
    // 逐条消费应用事件源的产出。
    for await (const dispatch of source) {
      if (signal.aborted) {
        // 生命周期已取消：拒绝未处理的瀑布并退出。
        if ('context' in dispatch) dispatch.reject(signal.reason)
        return
      }
      // 带上下文的是作用域瀑布，否则是广播通知。
      if ('context' in dispatch) this.startRemoteEvent(dispatch)
      else this.broadcastRemoteEvent(dispatch)
    }
    if (!signal.aborted) {
      // 源未取消却结束：装配错误，必须失败。
      throw new Error('typert gateway: forwarded Remote event source ended unexpectedly')
    }
  }

  private broadcastRemoteEvent(frame: TypertRemoteEventFrame): void {
    // 先校验事件名与参数的 JSON 安全性。
    assertRemoteEventFrame(frame)
    // 构造线上通知帧。
    const wire: RemoteEventEmitFrame = {
      type: 'emit',
      event: frame.event,
      args: frame.args,
    }
    // 资源读取结果懒解析：只有遇到非所有者才计算一次。
    let resolved = false
    let resources: readonly RemoteAccessResource[] | undefined
    // 广播给每个接入的事件代。
    for (const client of this.remoteEventClients.values()) {
      if (!client.answers) {
        // A non-owner receives the whole notification or nothing: its resources decide, payloads are never trimmed,
        // and a notification with invalid resources reaches no non-owner.
        // 非所有者要么收到完整通知要么收不到：由资源判定决定，载荷从不裁剪，
        // 资源非法的通知不会到达任何非所有者。
        if (!resolved) {
          resources = eventResources(frame.resources, frame.args)
          resolved = true
        }
        // 资源非法：对非所有者整体跳过。
        if (resources === undefined) continue
        // 访问判定拒绝的 Peer 不投递。
        if (this.ctx.remoteAccess.decide({ principal: client.principal, action: `event:${frame.event}`, resources }).kind === 'deny') continue
      }
      // 入队投递。
      client.queue.push(wire)
    }
  }

  private startRemoteEvent(source: TypertRemoteEventInvocation): void {
    try {
      // 校验事件名非空。
      assertRemoteEventName(source)
      // 作用域事件必须带非空 Agent 身份。
      if (!isRemoteEventAgentId(source.context.agentId)) {
        throw new TypeError(
          'typert gateway: scoped Remote events require a non-empty Agent identity',
        )
      }
      // 投影请求：剥离 Agent 与 signal，得到 JSON 安全字段。
      const projected = projectRemoteEventRequest(source.request, source.context.subject)
      // 生成待决事件唯一 id（撞车则重试）。
      let id = randomUUID() as RemoteEventId
      while (this.pendingRemoteEvents.has(id)) id = randomUUID() as RemoteEventId
      let releaseContext: () => void
      try {
        // 在 Agent Context 上注册清理副作用：上下文释放即取消本事件。
        const dispose = source.context.value.effect(
          () => () => {
            this.cancelRemoteEvent(
              pending,
              new Error('typert gateway: Remote event Agent Context was released'),
            )
          },
          `api-gateway: Remote event ${JSON.stringify(source.event)}`,
        )
        // 释放闭包：事件落定时触发一次清理副作用。
        releaseContext = () => { void dispose() }
      } catch {
        // 上下文已释放，无法跟踪：放行（next）并结束。
        source.resolve({ kind: 'next' })
        return
      }
      // 收集 Host 侧的取消信号（可选）。
      const signals = new Set(projected.signal === undefined ? [] : [projected.signal])
      // 取消回调：以最先中止信号的原因为由取消本事件。
      const abort = (): void => {
        // 任一信号中止都以其中止原因为取消原因。
        const reason: unknown = [...signals].find(signal => signal.aborted)?.reason
        this.cancelRemoteEvent(pending, reason instanceof Error
          ? reason
          : new Error('typert gateway: Remote event was cancelled', { cause: reason }))
      }
      // 待决事件登记项。
      const pending: PendingRemoteEvent = {
        id,
        source,
        frame: {
          type: 'waterfall',
          event: source.event,
          eventId: id,
          agentId: source.context.agentId,
          request: projected.request,
        },
        deliveries: new Set(),
        releaseContext,
        releaseSignal: () => {
          // 落定时注销全部信号监听。
          for (const signal of signals) signal.removeEventListener('abort', abort)
        },
      }
      // 进入待决事件表。
      this.pendingRemoteEvents.set(id, pending)
      // 监听取消信号。
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
      // 注册前就已中止的信号：立即取消而不投递。
      if ([...signals].some(signal => signal.aborted)) abort()
      else {
        // 投递给每个可应答的所有者事件代。
        for (const client of this.remoteEventClients.values()) {
          if (client.answers) this.deliverRemoteEvent(pending, client)
        }
      }
    } catch (error) {
      // 准备阶段的任何失败都拒绝源头监听器。
      source.reject(error)
    }
  }

  private deliverRemoteEvent(pending: PendingRemoteEvent, client: RemoteEventClient): void {
    // 双向登记投递关系。
    pending.deliveries.add(client)
    client.deliveries.set(pending.id, pending)
    // 帧入该代队列。
    client.queue.push(pending.frame)
  }

  private receiveRemoteEventResult(
    client: RemoteEventClient,
    result: ReturnType<typeof parseRemoteEventResult>,
  ): void {
    // 按关联 id 找待决事件。
    const pending = this.pendingRemoteEvents.get(result.eventId)
    // Settlement and Client replacement may race the result request. Results
    // from a completed event or a superseded delivery are idempotent no-ops.
    // 落定与换代可能和结果请求竞速：来自已完成事件或已被取代投递的结果一律是幂等空操作。
    if (pending === undefined || !pending.deliveries.has(client)) return
    // 先摘除本次投递关系。
    this.removeRemoteEventDelivery(pending, client)
    if (result.outcome.kind === 'result') {
      // 结果分支：以结果落定事件。
      this.settleRemoteEvent(pending, {
        kind: 'result',
        value: result.outcome.value,
      })
    } else if (result.outcome.kind === 'rejected') {
      // 拒绝分支：还原远端错误并取消事件。
      this.cancelRemoteEvent(pending, restoreRemoteEventRejection(result.outcome.error))
    } else if (pending.deliveries.size === 0) {
      // 放行分支：所有投递都已应答后才真正放行。
      this.settleRemoteEvent(pending, { kind: 'next' })
    }
  }

  private removeRemoteEventDelivery(pending: PendingRemoteEvent, client: RemoteEventClient): void {
    // 双向解除投递关系。
    pending.deliveries.delete(client)
    client.deliveries.delete(pending.id)
  }

  private removeRemoteEventClient(client: RemoteEventClient): void {
    // 从代表中移除。
    this.remoteEventClients.delete(client.id)
    // 解除该代参与的所有投递。
    for (const pending of [...client.deliveries.values()]) this.removeRemoteEventDelivery(pending, client)
    // 结束其下行队列。
    client.queue.end()
  }

  private settleRemoteEvent(pending: PendingRemoteEvent, outcome: TypertRemoteEventOutcome): void {
    // 先完成清理，再以结果恢复源头监听器。
    this.finishRemoteEvent(pending)
    pending.source.resolve(outcome)
  }

  private cancelRemoteEvent(pending: PendingRemoteEvent, reason: unknown): void {
    // 登记项已被替换则不再取消。
    if (this.pendingRemoteEvents.get(pending.id) !== pending) return
    this.finishRemoteEvent(pending)
    pending.source.reject(reason)
  }

  private finishRemoteEvent(pending: PendingRemoteEvent): void {
    // 从待决表移除。
    this.pendingRemoteEvents.delete(pending.id)
    // 注销信号监听并释放 Agent Context 副作用。
    pending.releaseSignal()
    pending.releaseContext()
    // 解除全部投递关系。
    const clients = new Set(pending.deliveries)
    for (const client of clients) this.removeRemoteEventDelivery(pending, client)
    // 构造取消帧。
    const cancellation: RemoteEventCancellationFrame = {
      type: 'cancel',
      eventId: pending.id,
    }
    // 通知每个已投递的代该事件已取消。
    for (const client of clients) client.queue.push(cancellation)
  }

  private closeRemoteEvents(reason: unknown): void {
    // 以给定原因取消全部待决事件。
    for (const pending of [...this.pendingRemoteEvents.values()]) {
      this.cancelRemoteEvent(pending, reason)
    }
    // 结束所有事件代的下行队列。
    for (const client of [...this.remoteEventClients.values()]) client.queue.end()
  }

  private async invokeRpc(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): Promise<ConnectionRpcResult> {
    try {
      // 先把端点/载荷校验成 Remote 请求，再准备并调用。
      const prepared = await this.prepareInvocation(
        remoteRequest(endpoint, payload, signal, peer),
        new AbortController(),
      )
      // 执行业务调用。
      const value = await this.invokePrepared(prepared)
      // A void or explicitly absent business result carries no `value` field;
      // JSON has no `undefined`, and the envelope's optional slot is the one
      // representation of absence that both args and results already use.
      // void 或显式缺省的业务结果不携带 `value` 字段：JSON 没有 `undefined`，
      // 信封的可选槽位就是参数与结果共用的缺席表示。
      return encodeRpcResult(value, prepared.descriptor.result)
    } catch (error) {
      // 一切失败转成标准 RPC 错误。
      return rpcFailure(error)
    }
  }

  /** `control` fails the logical stream when an uplink item is rejected; unary calls hand over an inert one. */
  // `control` 在上行条目被拒时让逻辑流失败；一元调用传入的是惰性控制器。
  private async prepareInvocation(
    request: InvokeRemoteRequest,
    control: AbortController,
  ): Promise<PreparedInvocation> {
    // 拼出规范端点并确认 Peer 存活。
    const endpoint = endpointOf(request.namespace, request.method)
    assertPeerLive(request.peer, endpoint)
    // 解析方法描述符（严格定义优先，SRC 弱声明兜底）。
    const descriptor = this.resolveDescriptor(request.namespace, request.method, endpoint)
    // 先做字段级比对，再做编解码校验。
    assertExactArguments(request.args, descriptor, endpoint)
    const validated = validateArguments(descriptor, request.args, endpoint)
    // Access precedes lookup resolution, so a refused call activates nothing.
    // 访问判定先于查找解析：被拒的调用不会激活任何东西。
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
    if (request.peer.principal.kind !== 'owner') {
      // 非所有者：读取方法声明的资源并做访问决策。
      const resources = callResources(
        this.ctx.typert,
        this.resourceReaders(descriptor),
        descriptor,
        validated,
        request.signal ?? NEVER_ABORTED_SIGNAL,
      )
      const decision: RemoteAccessDecision = resources === undefined
        ? { kind: 'deny', reason: 'resource-invalid' }
        : this.ctx.remoteAccess.decide({
          principal: request.peer.principal,
          action: `${descriptor.namespace}/${descriptor.method}`,
          resources,
          args: validated,
        })
      if (decision.kind === 'deny') {
        // 拒绝：以共享远程访问错误抛出，附动作与原因。
        throw new RemoteError('remote-access/denied', `remote access: ${endpoint}: access denied (${decision.reason})`, {
          action: endpoint,
          reason: decision.reason,
        })
      }
    }
    // 解析接收者所在的 Context（可能经 Context 提供者按身份定位）。
    const receiverContext = await this.resolveReceiverContext(descriptor, validated, endpoint)
    // 从该 Context 取服务实例。
    const receiver: unknown = receiverContext.get(descriptor.service)
    if (!isObject(receiver)) {
      throw new TypertGatewayError(
        'gateway/service-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} is unavailable`,
      )
    }
    // 校验服务上的 typertRemote 绑定一致性。
    validateBinding(receiver, descriptor.service, descriptor.namespace, endpoint)
    // 并发解析全部参数（JSON 直取或查找提供者解析）。
    const args = await Promise.all(descriptor.parameters.map(parameter =>
      this.resolveParameter(parameter, validated, endpoint)))
    // 计算方法可观察的取消信号。
    const signal = methodSignal(request, control, descriptor.mode === 'stream')
    // 构造 invocation 上下文：请求、服务键、Peer、信号与上行源。
    const invocation = new GatewayInvocation(
      { namespace: request.namespace, method: request.method, args: request.args },
      descriptor.service,
      request.peer,
      signal,
      {
        source: request.uplink ?? EMPTY_ASYNC_ITERABLE,
        window: request.uplinkWindow,
        codec: descriptor.uplink?.codec ?? SRC_JSON_CODEC,
        endpoint,
        abort: (reason) => { control.abort(reason) },
      },
    )
    // 声明了取消参数的方法：把信号追加为最后一个实参。
    if (descriptor.cancellation !== undefined) args.push(signal)
    // The method runs on a Service view bound to a Context carrying this call:
    // Cordis rebinds `this.ctx` to the accessing Context, so `this.ctx.invocation`
    // is this call and nothing travels through the parameter list. The view
    // resolves the Service the plain read above already found.
    // 方法运行在绑定了本次调用的 Context 的服务视图上：Cordis 把 `this.ctx` 重绑到访问方 Context，
    // 因此 `this.ctx.invocation` 就是本次调用，且任何东西都不经过参数列表传递。该视图解析出的就是上面读到的那个服务。
    const callReceiver = receiverContext.extend({ invocation }).get(descriptor.service) as object
    // 实现方法名可能区别于导出名。
    const implementation = descriptor.implementation ?? descriptor.method
    const method: unknown = Reflect.get(callReceiver, implementation)
    if (typeof method !== 'function') {
      // 服务上没有可调用实现：报错。
      throw new TypertGatewayError(
        'gateway/method-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} has no callable method ${JSON.stringify(implementation)}`,
      )
    }
    // 返回准备产物。
    return {
      endpoint,
      descriptor,
      receiver: callReceiver,
      args,
      method: method as (...args: never[]) => unknown,
      invocation,
    }
  }

  private resolveDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
    // 优先使用严格生成的定义。
    const strict = this.ctx.typert.local.get(endpoint)
    if (strict !== undefined) return strict
    if (this.ctx.typert.local.hasSeen(endpoint)) {
      // 严格定义存在过但已被撤回：禁止退回 SRC。
      throw new TypertGatewayError(
        'gateway/definition-unavailable',
        endpoint,
        'its strict definition was withdrawn and SRC fallback is forbidden',
      )
    }
    // 回退到 SRC 弱声明解析。
    return this.resolveSrcDescriptor(namespace, method, endpoint)
  }

  private resolveSrcDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
    // 收集所有导出该端点的候选描述符。
    const candidates: InvocationDescriptor[] = []
    // 遍历全部服务属性。
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver: unknown = this.ctx.get(serviceKey)
      if (!isObject(receiver)) continue
      // 读原始对象上的 Remote 绑定。
      const original = originalOf(receiver)
      const value: unknown = Reflect.get(original, 'typertRemote')
      if (value === undefined) continue
      const binding = readBinding(value, original, serviceKey, endpoint)
      // 命名空间不匹配则跳过。
      if (binding.namespace !== namespace) continue
      // 找到导出该方法（或实现名）的标记。
      const marker = remoteMethods(original).find(candidate => (candidate.exportName ?? candidate.method) === method)
      if (marker === undefined) continue
      // 由此派生描述符。
      candidates.push(this.srcDescriptor(binding, marker, method, endpoint))
    }
    if (candidates.length === 0) {
      // 没有任何活跃方法导出该端点。
      throw new TypertGatewayError('gateway/invocation-unavailable', endpoint, 'no active Remote method exports this endpoint')
    }
    if (candidates.length > 1) {
      // 多个服务导出同一端点：歧义，必须拒绝。
      throw new TypertGatewayError(
        'gateway/ambiguous-endpoint',
        endpoint,
        `multiple active Services export this endpoint: ${candidates.map(candidate => candidate.service).sort().join(', ')}`,
      )
    }
    return candidates[0] as InvocationDescriptor
  }

  private srcDescriptor(
    binding: TypertGatewayBinding,
    marker: ReturnType<typeof remoteMethods>[number],
    method: string,
    endpoint: string,
  ): InvocationDescriptor {
    // 从 JavaScript 签名读取参数名（SRC 弱声明的依据）。
    const names = methodParameterNames(binding.service, marker.method, endpoint)
    // signal 参数若存在必须是最后一个（取消参数约定）。
    const signalIndex = names.indexOf('signal')
    if (signalIndex >= 0 && signalIndex !== names.length - 1) {
      throw new TypertGatewayError(
        'gateway/signature-invalid',
        endpoint,
        'SRC cancellation parameter signal must be the final parameter',
        { field: 'signal' },
      )
    }
    // 声明取消参数（可缺省）。
    const cancellation = signalIndex >= 0
      ? { parameter: 'signal' as const }
      : undefined
    // 业务参数名（去掉 signal）。
    const businessNames = cancellation === undefined ? names : names.slice(0, -1)
    const parameters: InvocationParameterDescriptor[] = []
    // 已占用线上字段集合，用于查重。
    const wires = new Set<string>()
    for (const name of businessNames) {
      // 查找按参数名匹配的查找(lookup)提供者定义。
      const matches = this.ctx.typert.lookups.definitions()
        .filter(definition => definition.parameter === name)
      if (matches.length > 1) {
        // 一个参数匹配多个提供者：签名非法。
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `parameter ${JSON.stringify(name)} matches multiple lookup providers`,
          { field: name },
        )
      }
      const match = matches[0]
      // 无提供者的参数走 JSON 直传；有提供者的按查找解析。
      const parameter: InvocationParameterDescriptor = match === undefined
        ? { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
        : {
          name,
          wire: match.wire,
          source: 'lookup',
          lookup: match.key,
          codec: { mode: 'src-json' },
        }
      if (wires.has(parameter.wire)) {
        // 线上字段重复：签名非法。
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `multiple parameters use wire field ${JSON.stringify(parameter.wire)}`,
          { field: parameter.wire },
        )
      }
      wires.add(parameter.wire)
      parameters.push(parameter)
    }

    // 接收者默认直取宿主 Context。
    let receiver: InvocationDescriptor['invocation'] = { kind: 'direct' }
    if (marker.invocation.kind === 'context') {
      // Context 方法：必须存在对应的宿主提供者。
      const provider = this.ctx.typert.contexts.getHost(marker.invocation.context)
      if (provider === undefined) {
        throw new TypertGatewayError(
          'gateway/context-unavailable',
          endpoint,
          `Context provider ${JSON.stringify(marker.invocation.context)} is unavailable`,
        )
      }
      if (wires.has(provider.wire)) {
        // Context 身份字段与业务线上字段冲突：签名非法。
        throw new TypertGatewayError(
          'gateway/signature-invalid',
          endpoint,
          `Context identity conflicts with wire field ${JSON.stringify(provider.wire)}`,
          { field: provider.wire },
        )
      }
      // 以 Context 提供者描述接收者定位方式。
      receiver = {
        kind: 'context',
        context: marker.invocation.context,
        wire: provider.wire,
        codec: { mode: 'src-json' },
      }
    }

    // 汇总为 SRC 描述符；可选字段按存在性输出。
    return {
      id: `src:${binding.serviceKey}#${endpoint}`,
      service: binding.serviceKey,
      namespace: binding.namespace,
      method,
      ...(marker.method === method ? {} : { implementation: marker.method }),
      ...(marker.mode === undefined ? {} : { mode: marker.mode }),
      invocation: receiver,
      parameters,
      ...(cancellation === undefined ? {} : { cancellation }),
      result: { mode: 'src-json' },
    }
  }

  private async resolveReceiverContext(
    descriptor: InvocationDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<Context> {
    // 直接调用：接收者就在宿主 Context 上。
    if (descriptor.invocation.kind === 'direct') return this.ctx
    // Context 调用：先取宿主提供者。
    const invocation = descriptor.invocation
    const provider = this.ctx.typert.contexts.getHost(invocation.context)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'gateway/context-unavailable',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} is unavailable`,
      )
    }
    // 提供者的线上字段（严格模式下还有类型符号）必须与定义一致。
    if (provider.wire !== invocation.wire
      || (invocation.codec.mode === 'strict' && provider.wireTypeSymbol !== invocation.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'gateway/provider-mismatch',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} does not match its strict definition`,
        { field: invocation.wire },
      )
    }
    // 解码身份字段。
    const identity = decode(invocation.codec, args[invocation.wire], endpoint, invocation.wire)
    let context: Context | undefined
    try {
      // 按身份解析目标 Context。
      context = await provider.resolve(identity)
    } catch (cause) {
      // 已是 Remote 失败的原样上抛，其余包装。
      if (remoteErrorOf(cause) !== undefined) throw cause
      throw new TypertGatewayError(
        'gateway/context-failed',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} failed`,
        { cause, field: invocation.wire },
      )
    }
    if (context === undefined) {
      // 身份未命中：未找到。
      throw new TypertGatewayError(
        'gateway/context-not-found',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} did not resolve the requested identity`,
        { field: invocation.wire },
      )
    }
    return context
  }

  private async resolveParameter(
    parameter: InvocationParameterDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<unknown> {
    // Lookup ids are never omissible, so an absent field belongs to a json parameter that takes undefined.
    // 查找(lookup) id 永不可省略，因此缺席字段属于接受 undefined 的 JSON 参数。
    if (!Object.hasOwn(args, parameter.wire)) return undefined
    // JSON 参数：原样取线上的值（此前已解码校验）。
    if (parameter.source === 'json') return args[parameter.wire]
    // 查找参数：先解码身份值。
    const value = decode(parameter.codec, args[parameter.wire], endpoint, parameter.wire)
    const key = parameter.lookup
    /* v8 ignore next -- registry validation rejects strict descriptors without a key, and SRC derivation always supplies one. */
    // 无提供者键不可达：注册表校验与 SRC 派生都会补键（测试覆盖豁免）。
    if (key === undefined) {
      throw new TypertGatewayError(
        'gateway/lookup-unavailable',
        endpoint,
        `lookup parameter ${JSON.stringify(parameter.name)} has no provider key`,
        { field: parameter.wire },
      )
    }
    // 取提供者。
    const provider = this.ctx.typert.lookups.get(key)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'gateway/lookup-unavailable',
        endpoint,
        `lookup provider ${JSON.stringify(key)} is unavailable`,
        { field: parameter.wire },
      )
    }
    // 提供者的线上字段（严格模式下还有类型符号）必须与定义一致。
    if (provider.wire !== parameter.wire
      || (parameter.codec.mode === 'strict' && provider.wireTypeSymbol !== parameter.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'gateway/provider-mismatch',
        endpoint,
        `lookup provider ${JSON.stringify(key)} does not match its strict definition`,
        { field: parameter.wire },
      )
    }
    let resolved: unknown
    try {
      // 按身份解析实体。
      resolved = await provider.resolve(value)
    } catch (cause) {
      // 已是 Remote 失败的原样上抛，其余包装。
      if (remoteErrorOf(cause) !== undefined) throw cause
      throw new TypertGatewayError(
        'gateway/lookup-failed',
        endpoint,
        `lookup provider ${JSON.stringify(key)} failed`,
        { cause, field: parameter.wire },
      )
    }
    if (resolved === undefined) {
      // 身份未命中：未找到。
      throw new TypertGatewayError(
        'gateway/lookup-not-found',
        endpoint,
        `lookup provider ${JSON.stringify(key)} did not resolve the requested identity`,
        { field: parameter.wire },
      )
    }
    return resolved
  }
}

function encodeRpcResult(value: unknown, codec: TypertCodec): ConnectionRpcResult {
  // 附件收集器：字节字段以路径寻址放在信封附件里。
  const attachments: ConnectionRpcAttachment[] = []
  const writeBytes = (bytes: Uint8Array, path: readonly (string | number)[]): null => {
    attachments.push({ path: [...path], bytes })
    return null
  }
  const encoded = codec.mode === 'strict'
    ? codec.encode?.(value, writeBytes) ?? value
    : encodeRuntimeResult(value, writeBytes)
  // 附件为空则不输出该键，保持信封形状。
  return { ok: true, value: encoded, ...(attachments.length === 0 ? {} : { attachments }) }
}

function encodeRuntimeResult(
  input: unknown,
  writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null,
): unknown {
  // 当前字段路径，供附件寻址。
  const path: (string | number)[] = []
  // 祖先集合：检测循环引用。
  const ancestors = new Set<object>()
  const extract = (input: unknown, key: string): unknown => {
    // Capture accessors and toJSON once, before materializing the JSON metadata.
    // 在物化 JSON 元数据前一次性捕获访问器与 toJSON。
    let value = input
    if (input !== null && typeof input === 'object' && !(input instanceof Uint8Array)) {
      const toJSON: unknown = Reflect.get(input, 'toJSON')
      if (typeof toJSON === 'function') value = Reflect.apply(toJSON, input, [key])
    }
    // 字节类型：写入附件并以 null 占位。
    if (value instanceof Uint8Array) return writeBytes(value, path)
    // 原始值直接返回。
    if (typeof value !== 'object' || value === null) return value
    // 包装类型退化为原始值。
    if (value instanceof Number || value instanceof String || value instanceof Boolean) return value.valueOf()
    // 循环引用无法 JSON 化：直接拒绝。
    if (ancestors.has(value)) throw new TypeError('gateway: circular RPC result')
    ancestors.add(value)
    // 递归拷贝容器内容。
    let copy: object
    if (Array.isArray(value)) {
      const items: unknown[] = []
      // JSON arrays include every index, even holes and non-enumerable elements.
      // JSON 数组包含每一个索引，即使是空洞与非枚举元素。
      for (let index = 0, length = value.length; index < length; index++) items.push(child(value[index], index))
      copy = items
    } else {
      const fields: Record<string, unknown> = {}
      // 对象只取可枚举自有键。
      for (const key of Object.keys(value)) {
        const item: unknown = Reflect.get(value, key)
        // A toJSON method on the projected object must not run a second time.
        // 投影对象上的 toJSON 不能再执行第二次。
        if (key === 'toJSON' && typeof item === 'function') continue
        const extracted = child(item, key)
        // __proto__ 必须以定义属性方式写入，避免设置原型。
        if (key === '__proto__') Object.defineProperty(fields, key, { value: extracted, enumerable: true })
        else fields[key] = extracted
      }
      copy = fields
    }
    // 递归完成后移出祖先集合。
    ancestors.delete(value)
    return copy
  }
  const child = (value: unknown, key: string | number): unknown => {
    // 非对象值无需递归。
    if (typeof value !== 'object' || value === null) return value
    // 压栈递归再出栈，维护字段路径。
    path.push(key)
    const extracted = extract(value, String(key))
    path.pop()
    return extracted
  }
  return extract(input, 'value')
}

// 下行队列可承载的线上帧类型。
type RemoteEventWireFrame =
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** Pull-driven queue owned by one connected Client event generation. */
// 每个接入的 Client 事件代私有的拉取驱动队列。
class RemoteEventQueue {
  // 帧缓冲。
  private readonly frames = new Deque<RemoteEventWireFrame>()
  // 唤醒挂起消费的回调。
  private waiter: (() => void) | undefined
  // 队列是否已结束。
  private closed = false

  push(frame: RemoteEventWireFrame): void {
    // 已结束的队列丢弃新帧。
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiter?.()
  }

  end(): void {
    // 结束是幂等的。
    if (this.closed) return
    this.closed = true
    // 唤醒消费者以便其看到结束。
    this.waiter?.()
  }

  /**
   * Yield buffered and later frames until the queue ends or `signal` aborts.
   * An abort discards the frames still buffered, so a revoked Peer receives none of them.
   * @param signal - Client generation lifetime.
   * @returns the queued wire frames in push order.
   */
  async *iterate(signal: AbortSignal): AsyncGenerator<RemoteEventWireFrame> {
    // 代被取消即结束队列。
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        // 先排空缓冲（中止后立即停止，剩余帧作废，被撤销的 Peer 收不到）。
        while (this.frames.size > 0 && !signal.aborted) yield this.frames.popFront() as RemoteEventWireFrame
        // 已结束或已取消：完成。
        if (this.closed || signal.aborted) return
        // 挂起等待下一次 push/end。
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      // 退出时注销监听。
      signal.removeEventListener('abort', abort)
    }
  }
}

function assertRemoteEventFrame(frame: TypertRemoteEventFrame): void {
  // 先校验事件名。
  assertRemoteEventName(frame)
  // 参数列表必须是数组且整体 JSON 安全。
  if (!Array.isArray(frame.args) || !isRemoteJsonValue(frame.args)) {
    throw new TypeError(`typert gateway: Remote event ${JSON.stringify(frame.event)} arguments are not lossless JSON data`)
  }
}

function assertRemoteEventName(frame: { readonly event: unknown }): void {
  // 事件名必须是非空字符串。
  if (typeof frame.event !== 'string' || frame.event.length === 0) {
    throw new TypeError('typert gateway: Remote event name must be a nonempty string')
  }
}

function requireInteractions(peer: PeerScope, endpoint: string): void {
  // 转发事件只对声明了 interactions=answer 的 Peer 开放。
  if (peer.interactions !== 'answer') {
    throw new TypertGatewayError(
      'gateway/interactions-forbidden', endpoint,
      'forwarded Remote events require interactions=answer',
    )
  }
}

function parseRemoteEventResultPayload(payload: unknown): ReturnType<typeof parseRemoteEventResult> {
  // 载荷必须恰好是 `{ args: <结果> }` 的普通对象。
  if (!isObject(payload)
    || !isPlainObject(payload)
    || Reflect.ownKeys(payload).length !== 1
    || !Object.hasOwn(payload, 'args')) {
    throw new Error('typert gateway: Remote event result requires exactly one plain-object args field')
  }
  // 对 args 字段做完整结果校验。
  return parseRemoteEventResult(payload.args)
}

function remoteRequest(
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
): InvokeRemoteRequest {
  // A disposed Peer is refused whatever it sent.
  // 已释放的 Peer 发来什么都会被拒绝。
  assertPeerLive(peer, endpoint)
  // 端点必须拆成两段非空字符串。
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
    throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`)
  }
  const [namespace, method] = segments as [string, string]
  // 载荷必须恰好是 `{ args: <普通对象> }`。
  if (!isObject(payload)
    || !isPlainObject(payload)
    || Reflect.ownKeys(payload).length !== 1
    || !Object.hasOwn(payload, 'args')
    || !isObject(payload.args)
    || !isPlainObject(payload.args)) {
    throw new Error('Remote payload must contain exactly one plain-object args field')
  }
  // 组装标准请求。
  return { namespace, method, args: payload.args, signal, peer }
}

/**
 * The signal a method observes. A carrier that supplies an uplink fails the
 * stream through `control` when an item is rejected, so that invocation joins
 * `control` with the carrier signal; a stream also ends with its Peer. Every
 * other invocation keeps the carrier signal's identity.
 */
function methodSignal(request: InvokeRemoteRequest, control: AbortController, stream: boolean): AbortSignal {
  // 取载体信号。
  const carrier = request.signal
  // 没有上行且非流式：直接沿用载体信号（缺省用永不中止哨兵），保持其身份。
  if (request.uplink === undefined && !stream) return carrier ?? NEVER_ABORTED_SIGNAL
  // 其余情况把载体信号与逻辑流 control 合并（去重同一信号）。
  const joined = carrier === undefined || carrier === control.signal ? [control.signal] : [carrier, control.signal]
  // `AbortSignal.any` leaves each source only a weak reference to the joined signal,
  // so per-stream joins on a Host-lifetime Peer signal accumulate nothing.
  // `AbortSignal.any` 对每个源只保留指向合并信号的弱引用，因此宿主生命周期 Peer 信号上的逐流合并不积累任何东西。
  return AbortSignal.any(stream ? [...joined, request.peer.signal] : joined)
}

/**
 * Refuse a call whose Peer has been disposed.
 * @param peer - Peer the call speaks for.
 * @param endpoint - endpoint named in the failure.
 * @throws {@link TypertGatewayError} `gateway/peer-disposed` once the Peer is disposed.
 */
function assertPeerLive(peer: PeerScope, endpoint: string): void {
  // Peer 信号已中止即视为已释放。
  if (peer.signal.aborted) {
    throw new TypertGatewayError('gateway/peer-disposed', endpoint, 'the calling Peer has been disposed')
  }
}

function isIterable(value: unknown): value is Iterable<unknown> | AsyncIterable<unknown> {
  // 对象且具备任一迭代器工厂即视为可迭代。
  return isObject(value)
    && (typeof Reflect.get(value, Symbol.iterator) === 'function'
      || typeof Reflect.get(value, Symbol.asyncIterator) === 'function')
}

async function *cancellableStream(
  source: Iterable<unknown> | AsyncIterable<unknown>,
  endpoint: string,
  invocation: GatewayInvocation,
): AsyncGenerator {
  // 消费 invocation 的合并信号。
  const { signal } = invocation
  // 优先取异步迭代器工厂，其次同步工厂。
  const asyncFactory: unknown = Reflect.get(source, Symbol.asyncIterator)
  const syncFactory: unknown = Reflect.get(source, Symbol.iterator)
  const iterator = typeof asyncFactory === 'function'
    ? Reflect.apply(asyncFactory, source, []) as AsyncIterator<unknown>
    : Reflect.apply(syncFactory as (...args: never[]) => Iterator<unknown>, source, [])
  let rejectAbort: ((error: unknown) => void) | undefined
  const onAbort = (): void => {
    // 中止时让当前竞速的取消 Promise 拒绝。
    rejectAbort?.(streamAbortFailure(endpoint, signal.reason))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      // 每轮先检查中止状态。
      if (signal.aborted) throw streamAbortFailure(endpoint, signal.reason)
      // Reusing a pending cancellation promise retains every completed race.
      // 保留挂起的取消 Promise 以承载每次竞速的结果。
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      // next() can abort and throw synchronously before the race subscribes.
      // next() 可能先于竞速订阅就中止并同步抛出，先挂上空兜底。
      void aborted.catch(() => undefined)
      // 业务下一个值与取消竞速。
      const next = await Promise.race([Promise.resolve(iterator.next()), aborted])
      rejectAbort = undefined
      if (next.done === true) return
      yield next.value
    }
  } finally {
    // 收尾：注销监听。
    rejectAbort = undefined
    signal.removeEventListener('abort', onAbort)
    // The uplink closes first so a method blocked on `uplink.next()` unwinds
    // before its iterator is asked to return.
    // 先关上行，让阻塞在 `uplink.next()` 上的方法先解栈，再请求迭代器返回。
    await invocation.close()
    await iterator.return?.()
  }
}

/**
 * The failure a stream surfaces for its abort: a Remote failure used as the
 * reason is the Gateway or carrier failing the stream itself (a rejected,
 * overflowing, or misplaced uplink item); any other abort is a cancellation.
 */
function streamAbortFailure(endpoint: string, reason: unknown): unknown {
  // 中止原因为 Remote 失败则原样（网关/载体让流失败），否则按取消处理。
  return remoteErrorOf(reason) === undefined ? remoteCancelled(endpoint, reason) : reason
}

/** Carrier-signal cancellation as the shared failure vocabulary expresses it. */
// 载体信号取消在共享失败词汇表中的表达。
function remoteCancelled(endpoint: string, cause: unknown): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', `Remote invocation "${endpoint}" was aborted`, {}, { cause })
}

/**
 * The iterable `invocation.uplink()` returns. Each uplink item passes the
 * descriptor codec, or the JSON-safety check when the descriptor declares no
 * uplink, before delivery; a rejected item fails the whole logical stream.
 * Iteration ends when the Client half-closes or the downlink finishes, and
 * fails when the stream is cancelled, so a method blocked on the uplink always
 * wakes.
 */
class UplinkDecoder implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  // 载体源迭代器。
  private readonly source: AsyncIterator<unknown>
  // 挂起中的读取集合：中止或提前结束时统一唤醒。
  private readonly interrupted = new Set<PromiseWithResolvers<IteratorResult<unknown>>>()
  private readonly onAbort = (): void => {
    // 以中止原因构造失败并拒绝所有挂起读取。
    const failure = streamAbortFailure(this.endpoint, this.signal.reason)
    for (const read of this.interrupted) read.reject(failure)
  }
  // 解码器是否已关闭。
  private closed = false

  constructor(
    uplink: AsyncIterable<unknown>,
    private readonly codec: TypertCodec,
    private readonly endpoint: string,
    private readonly signal: AbortSignal,
    private readonly abort: (reason: unknown) => void,
  ) {
    // 立即取得源迭代器。
    this.source = uplink[Symbol.asyncIterator]()
    // 订阅取消信号。
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // 自身即迭代器（单消费者）。
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    // A cancelled stream reports the cancellation on every read, closed or not.
    // 已取消的流在每次读取时都报告取消，无论是否已关闭。
    if (this.signal.aborted) throw streamAbortFailure(this.endpoint, this.signal.reason)
    if (this.closed) return UPLINK_DONE
    // Only pending reads belong to the decoder; finish() must wake all of them.
    // 只有挂起中的读取属于本解码器；finish() 必须唤醒它们全部。
    const interrupted = Promise.withResolvers<IteratorResult<unknown>>()
    this.interrupted.add(interrupted)
    // The source can abort and throw synchronously before the race subscribes.
    // 源可能先于竞速订阅就中止并同步抛出，先挂上空兜底。
    void interrupted.promise.catch(() => undefined)
    let next: IteratorResult<unknown>
    try {
      // 源下一个条目与中断竞速。
      next = await Promise.race([this.source.next(), interrupted.promise])
    } finally {
      this.interrupted.delete(interrupted)
    }
    if (next.done === true) {
      // 源结束：完成解码器并报告结束。
      this.finish()
      return UPLINK_DONE
    }
    let value: unknown
    try {
      // A top-level `undefined` is the absent `value` of its frame: without a codec it is the item itself.
      // 顶层的 `undefined` 是帧里缺席的 `value`：没有编解码器时它就是条目本身。
      value = next.value === undefined && this.codec.mode === 'src-json'
        ? undefined
        : decode(this.codec, next.value, this.endpoint, 'uplink')
    } catch (failure) {
      // The codec failure (`gateway/input-invalid`, field `uplink`) fails the whole logical stream.
      // 编解码失败（`gateway/input-invalid`，字段 `uplink`）让整条逻辑流失败。
      this.abort(failure)
      throw failure
    }
    return { value, done: false }
  }

  /** Downlink finished or the method stopped reading: unread uplink items are dropped. */
  return(): Promise<IteratorResult<unknown>> {
    if (!this.closed) {
      this.finish()
      // The carrier owns the source iterator; a generator blocked in next()
      // completes this return once it yields, so it is not awaited here.
      // 载体自有源迭代器；阻塞在 next() 的生成器要等它让出后才能完成 return，因此这里不等待。
      void Promise.resolve().then(() => this.source.return?.()).catch(() => undefined)
    }
    return Promise.resolve(UPLINK_DONE)
  }

  private finish(): void {
    // 关闭并注销监听。
    this.closed = true
    this.signal.removeEventListener('abort', this.onAbort)
    // 唤醒所有挂起读取为“结束”。
    for (const read of this.interrupted) read.resolve(UPLINK_DONE)
  }
}

/**
 * The context of one Remote call as the receiving method reads it through
 * `this.ctx.invocation`. The uplink is decoded on first use and released when
 * the call's downlink finishes.
 */
class GatewayInvocation implements RemoteInvocation {
  // 惰性创建的上行解码器。
  private decoder: UplinkDecoder | undefined
  // uplink() 是否已被取用（每次调用只允许一次）。
  private taken = false

  // 上行窗口容量透传。
  get uplinkWindow(): RemoteInvocation['uplinkWindow'] { return this.uplink_.window }

  // 构造注入：各参数含义见下。
  /**
   * @param request - decoded endpoint and wire arguments.
   * @param service - Cordis service key of the receiver.
   * @param peer - Peer the call speaks for.
   * @param signal - the signal the method observes.
   * @param uplink - carrier items and the codec that decodes them.
   */
  constructor(
    readonly request: RemoteInvocation['request'],
    readonly service: string,
    readonly peer: PeerScope,
    readonly signal: AbortSignal,
    private readonly uplink_: UplinkSource,
  ) {}

  uplink<In = unknown>(): AsyncIterable<In> {
    // 二次取用直接报错。
    if (this.taken) {
      throw new Error(`typert gateway: ${this.uplink_.endpoint}: invocation.uplink() is available once per call`)
    }
    this.taken = true
    const { source, codec, endpoint, abort } = this.uplink_
    // 首次取用时才创建解码器。
    this.decoder = new UplinkDecoder(source, codec, endpoint, this.signal, abort)
    // 到达什么由描述符的编解码器决定；`In` 是调用方的断言。
    // The descriptor codec decides what arrives; `In` is the caller's assertion.
    return this.decoder as AsyncIterable<In>
  }

  /**
   * The downlink finished: release the uplink. Unread items are dropped, and a
   * carrier iterable the method never took is returned so it stops producing;
   * a later `uplink()` throws like a second one would.
   * @returns settles once a taken uplink has closed.
   */
  async close(): Promise<void> {
    if (this.decoder !== undefined) {
      // 已取用：关闭解码器（丢弃未读条目并通知源停止）。
      await this.decoder.return()
      return
    }
    // 未取用：标记为已消费，随后再调 uplink() 会像二次取用一样报错。
    this.taken = true
    releaseUplink(this.uplink_.source)
  }
}

/**
 * Return a carrier uplink nobody will read, so it drops later items instead of
 * buffering them. The carrier owns the iterator and `return()` is not awaited:
 * a generator blocked in `next()` completes it only once it yields.
 * @param source - the carrier's uplink iterable.
 */
// 归还无人读取的载体上行，让它丢弃后续条目而不是缓冲。载体自有迭代器，`return()` 不等待：
// 阻塞在 `next()` 的生成器只有让出时才能完成它。
function releaseUplink(source: AsyncIterable<unknown>): void {
  // 微任务中触发 return 并吞掉其错误。
  void Promise.resolve().then(() => source[Symbol.asyncIterator]().return?.()).catch(() => undefined)
}

function rpcFailure(error: unknown): ConnectionRpcResult {
  // 已是 Remote 失败：code/message/details 原样跨线。
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    return { ok: false, error: { code: remote.code, message: remote.message, details: remote.details } }
  }
  // 其他错误折叠为 gateway/internal，只保留消息。
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function rpcError(error: unknown): ConnectionRpcError & RemoteStreamFailure {
  // 从失败结果中取出错误字段。
  return (rpcFailure(error) as Extract<ConnectionRpcResult, { readonly ok: false }>).error
}

function endpointOf(namespace: string, method: string): string {
  // 拼接规范端点 `<namespace>/<method>`。
  return `${namespace}/${method}`
}

function validateBinding(
  receiver: object,
  serviceKey: string,
  namespace: string,
  endpoint: string,
): ResolvedBinding {
  // 取未代理的原始对象再读绑定。
  const original = originalOf(receiver)
  const value: unknown = Reflect.get(original, 'typertRemote')
  if (value === undefined) {
    // 绑定不可见：拒绝。
    throw new TypertGatewayError(
      'gateway/binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has no visible typertRemote binding`,
    )
  }
  return {
    binding: readBinding(value, original, serviceKey, endpoint, namespace),
    original,
  }
}

function readBinding(
  value: unknown,
  original: object,
  serviceKey: string,
  endpoint: string,
  namespace?: string,
): TypertGatewayBinding {
  // 绑定必须指向同一原始对象与服务键，命名空间是字符串且（给定时期望）匹配。
  if (!isObject(value)
    || Reflect.get(value, 'service') !== original
    || Reflect.get(value, 'serviceKey') !== serviceKey
    || typeof Reflect.get(value, 'namespace') !== 'string'
    || (namespace !== undefined && Reflect.get(value, 'namespace') !== namespace)) {
    throw new TypertGatewayError(
      'gateway/binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has an inconsistent typertRemote binding`,
    )
  }
  return value as TypertGatewayBinding
}

function originalOf(receiver: object): object {
  // 读 Cordis 的内部符号取原始对象；取不到就把接收者本身当原始对象。
  const original: unknown = Reflect.get(receiver, symbols.original)
  return isObject(original) ? original : receiver
}

function methodParameterNames(service: object, method: string, endpoint: string): readonly string[] {
  // 从服务实例沿原型链向上找方法。
  let prototype: object | null = Object.getPrototypeOf(service) as object | null
  let implementation: ((this: object, ...args: never[]) => unknown) | undefined
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    if (descriptor !== undefined) {
      // 只接受值属性形式的函数实现。
      if ('value' in descriptor && typeof descriptor.value === 'function') {
        implementation = descriptor.value as (this: object, ...args: never[]) => unknown
      }
      break
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  if (implementation === undefined) {
    // 原型链上没有该方法。
    throw new TypertGatewayError(
      'gateway/method-unavailable',
      endpoint,
      `Remote marker has no prototype method ${JSON.stringify(method)}`,
    )
  }
  // 反编译函数源码提取参数列表。
  const source = Function.prototype.toString.call(implementation)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  /* v8 ignore next -- standard public class-method syntax always contains a parenthesized parameter list. */
  // 标准公有类方法语法必有括号包裹的参数列表，此分支不可达（测试覆盖豁免）。
  if (open < 0 || close < 0) return invalidSignature(endpoint, method)
  // 取括号内参数文本。
  const body = source.slice(open + 1, close).trim()
  if (body.length === 0) return []
  // 按逗号切分并去空白。
  const parts = body.split(',').map(part => part.trim())
  const names = new Set<string>()
  for (const part of parts) {
    // 每个参数必须是唯一标识符：不允许解构、默认值或剩余参数。
    if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return invalidSignature(endpoint, method)
    names.add(part)
  }
  return [...names]
}

function invalidSignature(endpoint: string, method: string): never {
  // 统一的签名非法错误。
  throw new TypertGatewayError(
    'gateway/signature-invalid',
    endpoint,
    `SRC method ${JSON.stringify(method)} must use unique identifier parameters without destructuring, defaults, or rest`,
  )
}

function assertExactArguments(
  args: Readonly<Record<string, unknown>>,
  descriptor: InvocationDescriptor,
  endpoint: string,
): void {
  // args 必须是普通对象。
  if (!isPlainObject(args)) {
    throw new TypertGatewayError('gateway/arguments-invalid', endpoint, 'args must be a plain object')
  }
  // 期望字段：全部参数线上字段，加上 Context 身份字段。
  const expected = new Set(descriptor.parameters.map(parameter => parameter.wire))
  if (descriptor.invocation.kind === 'context') expected.add(descriptor.invocation.wire)
  // 多余字段：非字符串键或不在期望集合内。
  const actual = Reflect.ownKeys(args)
  const extra = actual.filter(key => typeof key !== 'string' || !expected.has(key))
  // A JSON field may be omitted when the strict descriptor declares absence,
  // and always under SRC: a weak descriptor reads parameter names from the
  // JavaScript signature and cannot see which are optional, so LIB is where an
  // omitted required argument is caught. Lookup ids are never omissible.
  // JSON 字段在严格描述符声明可缺席时可省略，SRC 下总是可省略：弱描述符从 JavaScript 签名读参数名，
  // 看不出哪些可选，因此被省略的必填参数由 LIB 捕获。查找 id 永不可省略。
  const acceptsMissing = new Set(descriptor.parameters
    .filter(parameter => parameter.source === 'json'
      && (parameter.acceptsUndefined === true || parameter.codec.mode === 'src-json'))
    .map(parameter => parameter.wire))
  // 缺失字段：期望但不存在且不接受缺席。
  const missing = [...expected].filter(key => !Object.hasOwn(args, key) && !acceptsMissing.has(key))
  if (extra.length === 0 && missing.length === 0) return
  // 组装诊断：先缺失后多余。
  const clauses: string[] = []
  if (missing.length > 0) clauses.push(`missing ${missing.map(key => JSON.stringify(key)).join(', ')}`)
  if (extra.length > 0) clauses.push(`unexpected ${extra.map(key => JSON.stringify(String(key))).join(', ')}`)
  throw new TypertGatewayError('gateway/arguments-invalid', endpoint, `args fields do not match the descriptor: ${clauses.join('; ')}`)
}

/**
 * Decode every present JSON argument once through its parameter codec; a
 * Typert codec drops object fields its compiled type does not declare. Lookup
 * and Context identities keep their wire values; dispatch decodes and resolves
 * them only after the access check. An absent field stays absent; a present
 * `undefined` is not JSON-safe and fails decoding.
 */
function validateArguments(
  descriptor: InvocationDescriptor,
  args: Readonly<Record<string, unknown>>,
  endpoint: string,
): Readonly<Record<string, unknown>> {
  // 每个出现的 JSON 参数都经其编解码器解码一次；Typert 编解码器会丢弃编译类型未声明的对象字段。
  const entries: [string, unknown][] = []
  // Context 身份字段保持线上的值（访问判定后再解码解析）。
  if (descriptor.invocation.kind === 'context') entries.push([descriptor.invocation.wire, args[descriptor.invocation.wire]])
  for (const parameter of descriptor.parameters) {
    // 缺席字段保持缺席。
    if (!Object.hasOwn(args, parameter.wire)) continue
    const value = args[parameter.wire]
    // JSON 参数立即解码；查找/身份参数保留线上的值。
    entries.push([parameter.wire, parameter.source === 'json' ? decode(parameter.codec, value, endpoint, parameter.wire) : value])
  }
  return Object.fromEntries(entries)
}

function decode(
  codec: TypertCodec,
  value: unknown,
  endpoint: string,
  field: string,
): unknown {
  try {
    if (codec.mode === 'strict') {
      // 严格编解码器：先按编译类型解析。
      value = codec.create().parse(value)
      /* v8 ignore next -- generated optional-input codecs are the only strict codecs that return undefined. */
      // 只有生成的可选输入编解码器会返回 undefined（测试覆盖豁免）。
      if (value === undefined) return value
    }
    // 无论何种模式都做最终 JSON 安全断言。
    assertJsonValue(value, new Set())
    return value
  } catch (cause) {
    // 统一包装为边界校验失败，指明字段。
    throw new TypertGatewayError(
      'gateway/input-invalid',
      endpoint,
      `wire field ${JSON.stringify(field)} failed boundary validation`,
      { cause, field },
    )
  }
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  // 基础 JSON 标量直接通过。
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    // 数字必须有限（排除 NaN/Infinity）。
    if (Number.isFinite(value)) return
    throw new TypeError('non-finite number is not JSON-safe')
  }
  // 其余非对象类型（undefined、bigint、函数、symbol）都不安全。
  if (!isObject(value)) throw new TypeError(`${typeof value} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError('cyclic value is not JSON-safe')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      // 数组不允许符号装饰，也不允许稀疏（键数与长度不符）。
      if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
        throw new TypeError('sparse or decorated array is not JSON-safe')
      }
      for (let index = 0; index < value.length; index += 1) {
        // 逐索引确认存在（防御稀疏洞）。
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array is not JSON-safe')
        assertJsonValue(value[index], ancestors)
      }
      return
    }
    // 对象必须是普通对象。
    if (!isPlainObject(value)) throw new TypeError('non-plain object is not JSON-safe')
    // 不允许符号键。
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('symbol property is not JSON-safe')
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      /* v8 ignore next -- ownKeys() just returned this key; only a hostile same-process Proxy can delete it between operations. */
      // ownKeys() 刚返回过该键；只有同进程内的恶意 Proxy 才可能在两步之间删除它（测试覆盖豁免）。
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('non-data property is not JSON-safe')
      }
      // 递归校验属性值。
      assertJsonValue(descriptor.value, ancestors)
    }
  } finally {
    // 无论成败都移出祖先集合。
    ancestors.delete(value)
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  // 排除数组后，要求原型为 Object.prototype 或 null。
  if (Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || prototype === Object.prototype
}

function isObject(value: unknown): value is object {
  // 对象（非 null）或函数。
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

// 默认导出网关服务类。
export default TypertGatewayService
