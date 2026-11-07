/** Client owner for forwarded Remote Event subscriptions and deliveries. */

// 仅类型导入：Cordis 上下文（Context），监听器注册与 Agent 上下文解析都以它为载体。
import type { Context } from '@deepseek-ai/cordis'
// 仅类型导入：连接承载的换代源、宿主信息与句柄类型。
import type {
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
// 仅类型导入：Typert 客户端事件监听器、所有权值与远程事件声明类型。
import type {
  TypertClientEventListener,
  TypertOwnedValue,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
// 运行时守卫：判断无损 JSON 值与"所有权值"（owned value）。
import { isRemoteJsonValue, isTypertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
// 生成随机 UUID：为每个客户端实例派生私有事件键前缀。
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// 引入网关内部转发事件流的端点常量、载荷、帧类型与各字段校验/投影工具。
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  isRemoteEventAgentId,
  isRemoteEventClientId,
  isRemoteEventId,
  projectRemoteEventRejection,
  type RemoteEventClientId,
  type RemoteEventDownlinkFrame,
  type RemoteEventEmitFrame,
  type RemoteEventInvocationFrame,
  type RemoteEventResult,
} from '../stream-protocol.ts'

// 流开启器类型：在选定承载（进程内直连或 WebSocket）上打开网关内部的转发事件流。
/** Open the Gateway-internal forwarded-event stream on the selected carrier. */
export type RemoteEventStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

// 去除事件专属签名后的通用监听器形态（Cordis 私有事件键下注册）。
/** One subscribed listener after its event-specific signature is erased. */
type RemoteEventListener = (this: Context, ...args: unknown[]) => unknown

// 对 Cordis 事件系统的非类型化访问封装：仅用于实例私有的事件键（避免污染公共类型面）。
/** Untyped access used only for instance-private Cordis event keys. */
interface PrivateEventContext {
  on(name: string, listener: RemoteEventListener): () => boolean
  parallel(name: string, ...args: unknown[]): Promise<void>
  waterfall(
    thisArg: Context,
    name: string,
    request: Readonly<Record<string, unknown>>,
    next: () => Promise<symbol>,
  ): unknown
}

// 客户端监听链处理一次调用后的结果：要么给出结果、要么让链继续（next）、要么已拒绝。
/** Transport outcome after one Client listener chain either claims or delegates. */
type RemoteEventReplyOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }
  | { readonly kind: 'rejected'; readonly error: ReturnType<typeof projectRemoteEventRejection> }

// 链尾私有标记：用 Symbol 保证永远不会与监听器返回的 JSON 值混淆。
/** Private end-of-chain marker that cannot collide with a JSON listener result. */
const REMOTE_EVENT_NEXT = Symbol('api-gateway.remote-event.next')

// 客户端转发事件的唯一属主：管理 Cordis 注册、换代（generation）泵送、瀑布分发与 HTTP 结果回执。
/** Own Cordis registrations, generation pumping, waterfall dispatch, and HTTP replies. */
export class ClientRemoteEvents {
  // 本实例私有事件键前缀：随机 UUID 隔离不同实例，避免事件键互相串扰。
  private readonly eventPrefix = `internal/api-gateway/remote-event/${randomUUID()}/`
  // 注销换代源的函数（构造时向 Connection 注册获得）。
  private readonly unregisterGeneration: () => void
  // 当前活跃的换代 Promise：dispose 时等待它静默。
  private activeGeneration: Promise<void> | undefined

  // 保存根上下文、连接句柄与流开启器，并把换代泵注册进 Connection。
  /**
   * @param ownerCtx - Client Gateway root used for Agent Context resolution.
   * @param connection - Connection carrier used for HTTP result calls.
   * @param openStream - selected in-process or WebSocket stream opener.
   */
  constructor(
    private readonly ownerCtx: Context,
    private readonly connection: ConnectionHandle,
    private readonly openStream: RemoteEventStreamOpener,
  ) {
    // 把 runGeneration 注册为换代源：每次 Connection 建立新代时都会调用它。
    this.unregisterGeneration = connection.registerGenerationSource(this.runGeneration)
  }

  /**
   * Register one typed Remote Event listener in its calling fiber.
   * @param callerCtx - fiber Context owning the registration.
   * @param event - selected forwarded event.
   * @param listener - listener derived from that event's declaration.
   * @returns disposer for this exact registration.
   */
  subscribe<Event extends TypertRemoteEvent>(
    callerCtx: Context,
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    // 在调用方 fiber 的私有事件空间按事件键注册监听器（签名在此被擦除为通用形态）。
    const dispose = privateEvents(callerCtx).on(
      this.eventKey(event),
      listener as RemoteEventListener,
    )
    // 返回只注销本次注册的清理函数。
    return () => { dispose() }
  }

  /** Withdraw the generation source and wait for active listener work to quiesce. */
  async dispose(): Promise<void> {
    // 先注销换代源：Connection 不再为事件泵开启新的代。
    this.unregisterGeneration()
    // 等待进行中的换代工作结束（无论成败），保证监听器不再被调用。
    await Promise.allSettled([this.activeGeneration])
  }

  // 换代源本体：记录当前代 Promise，使插件 dispose 能等待监听工作停止。
  /** Track the current generation so plugin disposal waits for listener work to stop. */
  private readonly runGeneration: ConnectionGenerationSource = (signal, ready) => {
    // 启动本代事件泵，并在其结束后（无论成败）清空活跃记录。
    const tracked = this.pumpEvents(signal, ready).finally(() => {
      // 仅当活跃记录仍是本代时才清除（防止覆盖更新的一代）。
      if (this.activeGeneration === tracked) this.activeGeneration = undefined
    })
    // 记为当前活跃代。
    this.activeGeneration = tracked
    // 把本代 Promise 交回 Connection 追踪。
    return tracked
  }

  /** Deliver one notification through Cordis while containing listener failures. */
  private deliver(frame: RemoteEventEmitFrame): void {
    // 以 parallel 方式在根上下文并发投递通知；监听器抛错只记日志，不影响事件泵。
    void privateEvents(this.ownerCtx)
      .parallel(this.eventKey(frame.event), ...frame.args)
      .catch((error: unknown) => { this.reportError(frame.event, error) })
  }

  /** Run one Connection generation over the forwarded-event logical stream. */
  private async pumpEvents(
    signal: AbortSignal,
    ready: (host: ConnectionHostInfo) => void,
  ): Promise<void> {
    // 本代分配到的客户端身份（ready 帧到来前未知）。
    let clientId: RemoteEventClientId | undefined
    // 结果投递失败信号：任一 waterfall 应答回执失败都会中止整代。
    const failed = new AbortController()
    // 本代总信号 = Connection 换代信号 + 结果投递失败信号。
    const generationSignal = AbortSignal.any([signal, failed.signal])
    // 进行中的 waterfall 调用：eventId -> 取消控制器（供 Host 侧 cancel 中止）。
    const active = new Map<string, AbortController>()
    // 全部应答任务的集合：代结束时统一等待其静默。
    const tasks = new Set<Promise<void>>()
    // 在总信号下打开网关内部转发事件流。
    const source = this.openStream(
      REMOTE_EVENT_STREAM_ENDPOINT,
      REMOTE_EVENT_STREAM_PAYLOAD,
      generationSignal,
    )
    // 流是否因异常退出（区别于正常结束）。
    let streamFailed = false
    // 流抛出的原始错误。
    let streamError: unknown
    try {
      // 逐帧读取转发事件流。
      for await (const value of source) {
        // 第一帧必须是 ready：取出客户端身份并上报宿主信息，宣告本代就绪。
        if (clientId === undefined) {
          // 校验并解析 ready 帧。
          const opening = parseRemoteEventReady(value)
          // 记录客户端身份，后续应答需要回传。
          clientId = opening.clientId
          // 通知 Connection 本代可用（附宿主事实）。
          ready(opening.host)
          // ready 帧处理完毕，读下一帧。
          continue
        }
        // 校验并解析后续帧（cancel/emit/waterfall）。
        const frame = parseRemoteEventFrame(value)
        // Host 主动取消某次 waterfall 调用：中止对应任务。
        if (frame.type === 'cancel') {
          active.get(frame.eventId)?.abort(new Error('client api: Remote event was cancelled by the Host'))
          continue
        }
        // 单向通知：无需应答，直接经 Cordis 分发。
        if (frame.type === 'emit') {
          this.deliver(frame)
          continue
        }
        // waterfall 调用：为它建立独立取消控制器并登记。
        const controller = new AbortController()
        active.set(frame.eventId, controller)
        // 应答信号 = 本代总信号 + 该调用的取消信号。
        const deliverySignal = AbortSignal.any([generationSignal, controller.signal])
        // 启动应答任务：失败时（若非已取消）中止整代；结束后清理登记。
        const task = this.answer(frame, clientId, deliverySignal)
          .catch((error: unknown) => {
            if (!deliverySignal.aborted) failed.abort(error)
          })
          .finally(() => {
            active.delete(frame.eventId)
            tasks.delete(task)
          })
        tasks.add(task)
      }
    } catch (error) {
      // 记录流异常退出，待收尾后统一处理。
      streamFailed = true
      streamError = error
    } finally {
      // 代结束：中止所有仍在进行中的 waterfall 调用。
      for (const controller of active.values()) {
        controller.abort(new Error('client api: Remote event generation ended'))
      }
      // 等待全部应答任务静默（无论成败），避免悬挂写操作。
      await Promise.allSettled(tasks)
    }
    // 结果投递失败导致整代失败：以原始原因抛出。
    if (failed.signal.aborted) {
      throw toError(failed.signal.reason, 'client api: Remote event result delivery failed')
    }
    // Connection 正常换代/停止：静默返回，不算异常。
    if (signal.aborted) return
    // 流自身抛错：原样上抛。
    if (streamFailed) throw streamError
    // 流未异常也未换代却走完了：视为宿主异常，报错。
    throw new Error('client api: forwarded Remote event stream ended unexpectedly')
  }

  private async answer(
    frame: RemoteEventInvocationFrame,
    clientId: RemoteEventClientId,
    signal: AbortSignal,
  ): Promise<void> {
    // 取 Agent 上下文适配器：把宿主给的 agentId 解析回本地 Agent 上下文。
    const adapter = this.ownerCtx.typert.contexts.getClient('agent')
    // 解析结果：本地 Context 或带所有权的值（owned value）。
    let resolved: Context | TypertOwnedValue<Context> | undefined
    try {
      // 按 agentId 解析目标 Agent 上下文。
      resolved = adapter?.resolve(frame.agentId)
    } catch (error) {
      // 解析失败不中断本代：记录后按"无目标"处理。
      this.reportError(frame.event, error)
    }
    // 若解析出所有权值，记下以便用后释放。
    const owned = isTypertOwnedValue(resolved) ? resolved : undefined
    try {
      // 目标上下文本体（所有权值则取其内部值）。
      const target = isTypertOwnedValue(resolved) ? resolved.value : resolved
      // 默认结果为"无人认领"（next）。
      let outcome: RemoteEventReplyOutcome = { kind: 'next' }
      // 找到了目标 Agent：进入瀑布分发。
      if (target !== undefined) {
        try {
          // 在目标上下文的监听链上执行 waterfall，拿回处理结果。
          outcome = await this.dispatchWaterfall(target, frame, signal)
        } catch (error) {
          // 等待期间已被取消：静默返回，不再回执。
          if (signal.aborted) return
          // 链上抛错：投影为可回传的拒绝结果。
          outcome = { kind: 'rejected', error: projectRemoteEventRejection(error) }
        }
      }
      // 回执前信号已中止（取消/换代结束）：放弃回执。
      if (signal.aborted) return
      // 组装应答载荷：把"result 但值为 undefined"归一为无值 result。
      const result: RemoteEventResult = {
        clientId,
        eventId: frame.eventId,
        outcome: outcome.kind === 'result' && outcome.value === undefined
          ? { kind: 'result' }
          : outcome,
      }
      // 经连接的 HTTP 通道把结果回执给宿主。
      const response = await this.connection.rpc.call(
        '/api',
        REMOTE_EVENT_RESULT_ENDPOINT,
        { args: result },
        signal,
      )
      // 回执被宿主拒绝：抛错（由 pumpEvents 决定是否终本代）。
      if (!response.ok) throw new Error(response.error.message)
    } finally {
      // 无论成败，释放解析得到的所有权值（若有）。
      owned?.[Symbol.dispose]()
    }
  }

  private async dispatchWaterfall(
    target: Context,
    frame: RemoteEventInvocationFrame,
    signal: AbortSignal,
  ): Promise<RemoteEventReplyOutcome> {
    // 组装瀑布请求：宿主原始请求 + 目标 Agent 上下文 + 取消信号。
    const request = {
      ...frame.request,
      agent: target,
      signal,
    }
    // Cancellation reaches the handler, whose Context remains owned until it settles.
    // 在目标上下文的事件键上执行瀑布；链尾 next() 返回私有标记表示无人认领。
    const value = await privateEvents(target).waterfall(
      target,
      this.eventKey(frame.event),
      request,
      () => Promise.resolve(REMOTE_EVENT_NEXT),
    )
    // 链上有监听器认领：结果必须是可跨端传输的无损 JSON（undefined 除外）。
    if (value !== REMOTE_EVENT_NEXT && value !== undefined && !isRemoteJsonValue(value)) {
      throw new TypeError('Remote event listener result is not lossless JSON data')
    }
    // 私有标记 => next（委托宿主继续）；其余 => result。
    return value === REMOTE_EVENT_NEXT
      ? { kind: 'next' }
      : { kind: 'result', value }
  }

  private eventKey(event: string): string {
    // 事件键 = 实例私有前缀 + 事件名，保证不同客户端实例互不干扰。
    return `${this.eventPrefix}${event}`
  }

  private reportError(event: string, error: unknown): void {
    // 监听器/解析抛错只记录到控制台：通知分发失败不应当拖垮事件泵。
    console.error(`client api: Remote event ${JSON.stringify(event)} listener threw:`, error)
  }
}

// 校验 ready 帧并取出本代的客户端身份与宿主事实。
/** Validate and return one generation's Client identity and Host facts. */
function parseRemoteEventReady(value: unknown): {
  readonly clientId: RemoteEventClientId
  readonly host: ConnectionHostInfo
} {
  // 逐项校验：普通对象、键集合精确、type 为 ready、clientId 与 host 结构合法。
  if (!isRemoteEventRecord(value)
    || !hasExactRemoteEventKeys(value, ['type', 'clientId', 'host'])
    || value.type !== 'ready'
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventRecord(value.host)
    || !hasExactRemoteEventKeys(value.host, ['home'])
    || typeof value.host.home !== 'string') {
    // 任一不满足：说明流的第一帧不是合法 ready，直接失败。
    throw new TypeError('client api: forwarded Remote event stream did not begin with ready')
  }
  // 返回可信的客户端身份与宿主信息（home 目录）。
  return { clientId: value.clientId, host: { home: value.host.home } }
}

// 校验转发事件流上的一个不可信帧，返回去掉 ready 后的三种下行帧之一。
/** Validate one untrusted value from the Gateway-internal forwarded-event stream. */
function parseRemoteEventFrame(value: unknown): Exclude<RemoteEventDownlinkFrame, { type: 'ready' }> {
  // 首先要求是普通对象，否则立即判非法。
  if (!isRemoteEventRecord(value)) invalidRemoteEventFrame()
  // cancel 帧：键精确为 type+eventId，且 eventId 合法。
  if (value.type === 'cancel'
    && hasExactRemoteEventKeys(value, ['type', 'eventId'])
    && isRemoteEventId(value.eventId)) {
    return { type: 'cancel', eventId: value.eventId }
  }
  // emit 帧：键精确，事件名非空，args 是数组且整体为无损 JSON。
  if (value.type === 'emit'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'args'])
    && validRemoteEventName(value.event)
    && Array.isArray(value.args)
    && isRemoteJsonValue(value.args)) {
    return { type: 'emit', event: value.event, args: value.args }
  }
  // waterfall 帧：键精确，各字段合法；request 不得预置 agent/signal（由客户端注入）。
  if (value.type === 'waterfall'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'eventId', 'agentId', 'request'])
    && validRemoteEventName(value.event)
    && isRemoteEventId(value.eventId)
    && isRemoteEventAgentId(value.agentId)
    && isRemoteEventRecord(value.request)
    && !Object.hasOwn(value.request, 'agent')
    && !Object.hasOwn(value.request, 'signal')
    && isRemoteJsonValue(value.request)) {
    // 三种帧全部通过，返回结构化的 waterfall 调用帧。
    return {
      type: 'waterfall',
      event: value.event,
      eventId: value.eventId,
      agentId: value.agentId,
      request: value.request,
    }
  }
  // 都不匹配：帧非法。
  invalidRemoteEventFrame()
}

// 判断值是否为"普通对象"（原型为 Object.prototype 或 null，排除数组）。
function isRemoteEventRecord(value: unknown): value is Record<string, unknown> {
  // 非对象、null 或数组都不算。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  // 取原型链做最终判定，防止伪造类实例绕过键校验。
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// 键集合必须精确相等：自有键数量一致且每个声明键都存在（防止夹带额外字段）。
function hasExactRemoteEventKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  // 列出全部自有键（含 Symbol）。
  const ownKeys = Reflect.ownKeys(value)
  // 数量一致且逐一存在才通过。
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

// 事件名守卫：非空字符串。
function validRemoteEventName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// 帧非法时统一抛出的 TypeError（never 返回类型便于控制流收窄）。
function invalidRemoteEventFrame(): never {
  throw new TypeError('client api: invalid forwarded Remote event frame')
}

// 取出 Cordis 事件系统的非类型化访问面（仅用于私有事件键场景）。
function privateEvents(ctx: Context): PrivateEventContext {
  return ctx.events
}

// 把中止原因归一为 Error：已是 Error 则原样用，否则包一层并保留原因。
function toError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason })
}
