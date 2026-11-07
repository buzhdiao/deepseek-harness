// 网关多路复用 Remote 流套接字的客户端属主：维持一条物理连接并在其上复用多条逻辑流。
/** Client owner for the Gateway multiplexed Remote stream socket. */
// 引入 RemoteError：把宿主下发的错误帧重建为带码的本地错误。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 仅类型导入：连接层的 WebSocket 封装（浏览器与 Node ws 的统一外观）。
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

// 引入多路复用协议：服务端消息解析器、复用路径常量与上下行消息类型。
import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
// 双端队列：逻辑流收件箱与上行队列的底层缓冲。
import { Deque } from '@deepseek-ai/dsh-deque'
// 生成随机 UUID：作为逻辑流的 streamId。
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

// 承载层（carrier）错误：物理 Remote 流套接字故障；领域传输层可据此决定重试。
/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  // 仅命名错误类，便于 instanceof/日志识别；语义与普通 Error 相同。
  /**
   * @param message - physical carrier failure description.
   * @param options - optional causal error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

// 等待物理套接字的排队者：记录发起时的修订号，避免被旧代尝试误结算。
interface SocketWaiter {
  readonly revision: number
  resolve(socket: ConnectionWebSocket): void
  reject(error: unknown): void
}

// 上行泵句柄：done 在泵停止发送后结算；stop 可中断（包括阻塞在调用方迭代器上的读取）。
interface UplinkPump {
  /** Settles once the pump has stopped sending. */
  readonly done: Promise<void>
  /** Interrupt the pump, including a read blocked on the caller's iterator, and release the iterator. */
  stop(): void
}

// 一条已打开的逻辑流：下行帧收件箱 + `open` 帧发出后才有值的上行泵。
/** One open logical stream: its downlink frames and, once the `open` frame is out, its uplink pump. */
interface LogicalStream {
  readonly inbox: StreamInbox
  pump: UplinkPump | undefined
}

// 上行迭代的统一"结束"结果常量，避免反复分配对象。
const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

// Remote 流复用客户端：维持一条物理 WebSocket，把多条可独立取消的逻辑流复用其上；
// 载体若提供进程内流开启器（in-process opener）则永远不会启动物理连接。
/**
 * Keep one physical WebSocket and share it among independently cancellable
 * Remote streams. A carrier that supplies an in-process stream opener never
 * starts one.
 */
export class RemoteStreamMuxClient {
  // 当前物理套接字；undefined 表示未连接/连接中。
  private socket: ConnectionWebSocket | undefined
  // 连接尝试的取消回调：reconnect/close 借此立即否决进行中的握手。
  private cancelCandidate: ((error: Error) => void) | undefined
  // 当前连接尝试（含失败收尾）的 Promise；undefined 表示没有进行中的尝试。
  private keepAlive: Promise<void> | undefined
  // 重连修订号：每次 reconnect 递增，用于作废旧尝试的等待者。
  private revision = 0
  // 全部活跃逻辑流：streamId -> 收件箱与上行泵。
  private readonly streams = new Map<string, LogicalStream>()
  // 等待物理套接字的排队者集合。
  private readonly waiters = new Set<SocketWaiter>()
  // 历史套接字的关闭 Promise 集合：close() 需等待它们全部落地。
  private readonly socketClosures = new Set<Promise<void>>()
  // 是否已启动（允许建立物理连接）。
  private running = false
  // 是否已永久释放。
  private disposed = false
  // 最近一次失败的缓存：未等待重连模式下，后续 open 立即以此失败。
  private failure: RemoteStreamCarrierError | undefined

  // 默认用浏览器 WebSocket 按页面基准 URL 推导的地址；应答型客户端等待重连，被动型立即失败。
  /**
   * @param openSocket - selected authenticated carrier; omission uses the browser socket.
   * @param waitForReconnect - answering Clients wait for Connection to replace a lost socket; passive Clients fail later opens immediately.
   */
  constructor(
    private readonly openSocket: (path: string) => ConnectionWebSocket = () => new WebSocket(remoteStreamUrl()),
    private readonly waitForReconnect = false,
  ) {}

  /** Ensure a physical attempt exists, following the current attempt once if needed. */
  start(): void {
    // 已释放：不再建立任何连接。
    if (this.disposed) return
    // 标记为已启动。
    this.running = true
    // 物理套接字已就绪：无需动作。
    if (this.socket?.readyState === 1) return
    // 记下进行中的连接尝试（若有）。
    const pending = this.keepAlive
    // 没有进行中的尝试：立即维护一次；否则等它结束后再维护一次（跟进当前尝试）。
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** Cancel the current socket or retry wait and start a fresh attempt immediately. */
  reconnect(): void {
    // 未启动或已释放：忽略重连请求。
    if (!this.running || this.disposed) return
    // 以"请求重连"为原因构造承载错误，作为旧连接全部逻辑流的失败原因。
    const failure = new RemoteStreamCarrierError('api gateway: Remote stream reconnect requested')
    // 记下进行中的连接尝试（若有）。
    const pending = this.keepAlive
    // 递增修订号：旧尝试的等待者不再被结算。
    this.revision++
    // 清空失败缓存：重连后允许新的 open。
    this.failure = undefined
    // 若有进行中的握手：立即以失败否决它。
    this.cancelCandidate?.(failure)
    // 若已有物理套接字：登记失败、通知所有逻辑流并主动关闭。
    const socket = this.socket
    if (socket !== undefined) {
      // 先摘除当前套接字，避免 close 事件再次触发 lost 逻辑。
      this.socket = undefined
      // 让所有活跃逻辑流以此失败。
      this.failAll(failure)
      // 以 4000 状态码关闭物理套接字。
      socket.close(4000, 'reconnect requested')
    }
    // 没有进行中的尝试：立即重开；否则等它结束后再维护一次。
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /**
   * Open one logical stream on the persistent physical connection.
   * After an established socket is lost, answering Clients wait for Connection
   * to reconnect or for their signal to abort; passive Clients reject immediately.
   * An initial socket failure rejects both modes.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @param uplink - the Client's items: each is sent as an `item` frame, its end as `end`; its `return()`
   * runs when the stream finishes, and its failure cancels the stream and fails the downlink.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator {
    // 调用方信号已中止：立即失败，不做任何事。
    signal.throwIfAborted()
    // 为本逻辑流生成唯一 id。
    const streamId = randomUUID()
    // 创建下行帧收件箱。
    const inbox = new StreamInbox()
    // 组装逻辑流记录（上行泵在 open 帧发出后才挂上）。
    const stream: LogicalStream = { inbox, pump: undefined }
    // 本流使用的物理套接字。
    let carrier: ConnectionWebSocket | undefined
    // `open` 帧是否已发出（决定 finally 是否需要发 cancel）。
    let opened = false
    // 是否已收到终态帧（error/end），决定是否还要向宿主发 cancel。
    let terminal = false
    // 调用方中止时的收件箱失败回调。
    const abort = (): void => { inbox.fail(signal.reason) }
    // 监听调用方信号中止（一次性）。
    signal.addEventListener('abort', abort, { once: true })
    try {
      // 等待物理套接字就绪（按客户端模式等待重连或立即失败）。
      const socket = await this.waitForSocket(signal)
      // 拿到套接字后再查一次信号，防止竞态中止。
      signal.throwIfAborted()
      // 记录本流使用的物理套接字。
      carrier = socket
      // 把逻辑流登记进复用器，之后服务端帧才能按 streamId 路由进来。
      this.streams.set(streamId, stream)
      // 发送 open 帧请求打开该逻辑流。
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      // open 帧已上线。
      opened = true
      // 有上行来源：启动上行泵把调用方条目泵到宿主。
      if (uplink !== undefined) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox)
      // 主循环：逐帧消费下行收件箱。
      while (true) {
        // 等待下一帧。
        const frame = await inbox.next()
        // 每帧之后检查中止，确保及时退出。
        signal.throwIfAborted()
        // 普通数据帧：向调用方交付一个条目。
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        // 走到这里说明是终态帧，记录下来以免 finally 再发 cancel。
        terminal = true
        // 错误帧：重建为带码 RemoteError 抛给调用方。
        if (frame.type === 'error') {
          throw new RemoteError(frame.error.code as never, frame.error.message, frame.error.details as never)
        }
        // end 帧：宿主正常结束本流。
        return
      }
    } finally {
      // 移除调用方信号的 abort 监听。
      signal.removeEventListener('abort', abort)
      // 注销本逻辑流。
      this.streams.delete(streamId)
      // 停掉上行泵（若存在）。
      stream.pump?.stop()
      // open 已发出、未收到终态且物理套接字仍在线：主动向宿主发 cancel。
      if (opened && !terminal && carrier?.readyState === 1) {
        this.send(carrier, { type: 'cancel', streamId })
      }
      // The old generation's pump has stopped before a supervisor reopens the next one.
      // 等待上行泵完全停止，保证换代重开前旧泵已静默。
      if (stream.pump !== undefined) await stream.pump.done
    }
  }

  /**
   * Send the caller's uplink items on this generation's socket. `stop()`
   * interrupts a pump blocked on `uplink.next()` and releases the iterator: a
   * handle's queue closes at once, so `send()` throws from then on, and any
   * other iterator's `return()` is invoked without being awaited because a
   * generator blocked in `next()` only completes it once it yields.
   */
  private pumpUplink(
    socket: ConnectionWebSocket,
    streamId: string,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: StreamInbox,
  ): UplinkPump {
    // 当前那次读取的"被打断"结算器（每次读取新建，属于单次读取而非整条上行）。
    let stopped: PromiseWithResolvers<IteratorReturnResult<undefined>> | undefined
    // 用于打断 race 的哨兵结果。
    const interruption: IteratorReturnResult<undefined> = { value: undefined, done: true }
    // 调用方上行的迭代器。
    const uplinkIterator = uplink[Symbol.asyncIterator]()
    // 泵状态：stopping 已被叫停；exhausted 上行自然读尽；released 迭代器已释放。
    const state = { stopping: false, exhausted: false, released: false }
    // 释放上行迭代器：先关闭队列（若有），再异步触发 return()（不等待其完成）。
    const release = (): void => {
      // 已释放或已读尽：无需重复。
      if (state.released || state.exhausted) return
      // 标记迭代器已释放。
      state.released = true
      // 是客户端队列：立即关闭，使后续 push() 抛错。
      if (uplink instanceof ClientUplinkQueue) uplink.close()
      // 微任务里调用迭代器 return()；生成器阻塞在 next() 时会在其恢复后补完，忽略其错误。
      void Promise.resolve().then(() => uplinkIterator.return?.()).catch(() => undefined)
    }
    // 泵主体：循环读调用方条目并按 item/end 帧发送。
    const done = (async (): Promise<void> => {
      try {
        while (true) {
          // 进入本轮读取前是否已被叫停。
          const stoppingBeforeRead = state.stopping
          // 已叫停：直接结束，不再读取。
          if (stoppingBeforeRead) return
          // A stop promise belongs to one read, not the whole uplink history.
          // 为本次读取建立独立的打断结算器。
          stopped = Promise.withResolvers<IteratorReturnResult<undefined>>()
          // 读取与打断信号赛跑：谁先落定用谁。
          const next = await Promise.race([uplinkIterator.next(), stopped.promise])
          // 读取完成，清空本次的打断器。
          stopped = undefined
          // 已叫停/被打断/信号中止/物理套接字已换代：静默结束泵。
          if (state.stopping || next === interruption || signal.aborted || this.socket !== socket) return
          // 上行自然读尽：跳出循环发送 end。
          if (next.done === true) {
            // 标记已读尽（release 无需再调用 return()）。
            state.exhausted = true
            break
          }
          // 把条目作为 item 帧发到宿主。
          this.send(socket, { type: 'item', streamId, value: next.value })
        }
        // 上行完成：发送 end 帧做半关闭。
        this.send(socket, { type: 'end', streamId })
      } catch (error) {
        // 读取/发送抛错：令本逻辑流下行失败（错误会传给消费方）。
        inbox.fail(error)
      } finally {
        // 清空残留的打断器。
        stopped = undefined
        // 无论如何释放上行迭代器。
        release()
      }
    })()
    return {
      done,
      stop: () => {
        // 幂等：已叫停则忽略。
        if (state.stopping) return
        // 标记泵已叫停。
        state.stopping = true
        // 若有读取正在进行：以哨兵结果打断它。
        stopped?.resolve(interruption)
        // 释放上行迭代器。
        release()
      },
    }
  }

  /**
   * Permanently stop the carrier, close the physical socket, and fail every
   * active logical stream.
   * @returns once the connection attempt and every physical socket have closed.
   */
  async close(): Promise<void> {
    // 首次调用：执行一次性释放。
    if (!this.disposed) {
      // 标记已释放，阻止后续任何新连接与新 open。
      this.disposed = true
      // 退出运行状态。
      this.running = false
      // 统一的"已释放"失败原因。
      const error = new Error('api gateway: Remote stream client disposed')
      // 所有活跃逻辑流下行失败并停泵。
      this.failAll(error)
      // 拒绝所有还在等套接字的排队者。
      for (const waiter of [...this.waiters]) waiter.reject(error)
      // 有进行中的握手则立即否决。
      this.cancelCandidate?.(error)
      // 摘除并正常关闭当前物理套接字（关闭码 1000）。
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    // 等待当前连接尝试（若有）完全结束。
    await this.keepAlive
    // 等待所有历史物理套接字关闭事件落地。
    await Promise.all(this.socketClosures)
  }

  private async connect(): Promise<ConnectionWebSocket> {
    // 用选定的载体发起物理连接。
    const socket = this.openSocket(REMOTE_STREAM_MUX_PATH)
    // 该套接字的关闭 Promise：close() 会等待它。
    const closed = new Promise<void>((resolve) => { socket.addEventListener('close', () => { resolve() }, { once: true }) })
    // 登记该关闭 Promise，供 close() 汇合等待。
    this.socketClosures.add(closed)
    // 关闭事件触发后自动从集合中移除，避免集合无限增长。
    void closed.then(() => { this.socketClosures.delete(closed) })
    // 连接 Promise：open 即 resolve，握手失败/取消即 reject。
    const connecting = new Promise<ConnectionWebSocket>((resolve, reject) => {
      // 该尝试是否已终局（open 或被否决），防止重复结算。
      let settled = false
      // 否决当前尝试：reconnect/close 会借 cancelCandidate 调用它。
      const rejectCandidate = (error: Error): void => {
        // 标记该尝试已终局。
        settled = true
        // 摘除 open 与 message 监听（error 监听保留到 close，见下）。
        socket.removeEventListener('open', opened)
        socket.removeEventListener('message', received)
        // 清空取消回调：此后 reconnect 不再作用于这次已否决的尝试。
        this.cancelCandidate = undefined
        // Node ws emits error when a connecting socket is closed. Keep its
        // error listener until close even after rejecting the attempt.
        // 尚未进入 CLOSING/CLOSED（readyState<2）则主动关闭套接字。
        if (socket.readyState < 2) socket.close()
        // 以给定错误拒绝连接 Promise。
        reject(error)
      }
      const opened = (): void => {
        // 握手成功：标记终局。
        settled = true
        // 清空取消回调。
        this.cancelCandidate = undefined
        // 登记为当前物理套接字。
        this.socket = socket
        // 唤醒所有等待者，把套接字交给它们。
        for (const waiter of [...this.waiters]) waiter.resolve(socket)
        // 连接 Promise 完成。
        resolve(socket)
      }
      const failed = (): void => {
        // 尚未终局：视为握手失败并否决尝试。
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket failed to open',
          ))
          return
        }
        // 已建立后的错误：作为承载层故障。
        const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed')
        // 按"连接丢失"处理：失败所有逻辑流。
        this.lost(socket, error)
        // 尚未关闭则主动关闭。
        if (socket.readyState < 2) socket.close()
      }
      const closed = (): void => {
        // 清理全部监听。
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        // 未 open 就关闭：视为握手失败。
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        // 正常路径：按连接丢失处理（默认错误原因）。
        this.lost(socket)
      }
      // 消息回调：仅当该套接字仍是当前物理套接字时才会被处理（receive 内部再校验）。
      const received = (event: { readonly data: unknown }): void => { this.receive(socket, event.data) }
      // 登记取消回调，供 reconnect/close 否决握手。
      this.cancelCandidate = rejectCandidate
      // 注册四类套接字事件；open/close 只触发一次，error/message 持续有效。
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed)
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  // 等待物理套接字就绪：已有连接立即返回；否则排队等待握手完成或失败。
  private waitForSocket(signal: AbortSignal): Promise<ConnectionWebSocket> {
    // 调用方已中止：立即失败。
    signal.throwIfAborted()
    // 物理套接字已就绪（OPEN=1）：直接复用。
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket)
    // 已释放：失败。
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    // 尚未 start：失败。
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    // 缓存了上次失败（未等待重连模式）：直接以该失败拒绝。
    if (this.failure !== undefined) return Promise.reject(this.failure)
    // 排队等待下一次握手结果。
    return new Promise((resolve, reject) => {
      // 调用方信号中止：以中止原因拒绝等待。
      const aborted = (): void => { waiter.reject(signal.reason) }
      // 清理：从等待者集合移除并注销 abort 监听。
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      // 等待者记录：带发起时的修订号，防止被后续 reconnect 的尝试结算。
      const waiter: SocketWaiter = {
        revision: this.revision,
        resolve: (socket) => {
          cleanup()
          resolve(socket)
        },
        reject: (error) => {
          cleanup()
          // AbortSignal.reason belongs to the caller and may intentionally be a non-Error sentinel.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      // 加入等待者集合。
      this.waiters.add(waiter)
      // 监听调用方中止（一次性）。
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  // 服务端消息入口：解析、按 streamId 路由到逻辑流收件箱；解析失败视为承载层致命故障。
  private receive(socket: ConnectionWebSocket, data: unknown): void {
    // 过期套接字的消息（刚被 reconnect 换掉）：忽略。
    if (socket !== this.socket) return
    try {
      // 协议要求文本帧：二进制消息直接判为错误。
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      // 解析并校验服务端消息帧。
      const frame = parseRemoteStreamServerMessage(data)
      // 按 streamId 找到目标逻辑流；找不到（已取消/未注册）则丢弃。
      const stream = this.streams.get(frame.streamId)
      if (stream === undefined) return
      // 帧入队，唤醒等待中的消费者。
      stream.inbox.push(frame)
      // A terminal frame ends the uplink now, not on the consumer's next read.
      // 终态帧（error/end）：立即停上行泵，不等消费者下次读取。
      if (frame.type !== 'item') stream.pump?.stop()
    } catch (error) {
      // 任何解析/处理错误都升级为承载层故障：打包成 CarrierError。
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      // 失败所有逻辑流。
      this.failAll(failure)
      // 按"连接丢失"处理（未等待重连模式会缓存失败）。
      this.lost(socket, failure)
      // 以 4002（协议错误）关闭物理套接字。
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: ConnectionWebSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    // 不是当前物理套接字的关闭/错误事件：忽略。
    if (this.socket !== socket) return
    // 摘除当前套接字：回到未连接状态。
    this.socket = undefined
    // 未等待重连模式（被动客户端）：缓存失败，让后续 open 立即失败。
    if (!this.waitForReconnect) this.failure = error
    // 让所有活跃逻辑流以此错误失败。
    this.failAll(error)
    // 未等待重连模式：拒绝所有排队等待套接字的请求（应答型客户端则留给 Connection 换代）。
    if (!this.waitForReconnect) {
      for (const waiter of [...this.waiters]) waiter.reject(error)
    }
  }

  // 确保存在一个进行中的连接尝试（幂等；已连接或已有尝试时不动作）。
  private maintain(): void {
    // 未启动或已释放：不连接。
    if (!this.running || this.disposed) return
    // 已连接或已有进行中的尝试：无需重复。
    if (this.socket?.readyState === 1 || this.keepAlive !== undefined) return
    // 记住本次尝试的修订号。
    const revision = this.revision
    // 新尝试开始：清空失败缓存。
    this.failure = undefined
    // 发起连接；失败时归一为 CarrierError 并结算旧修订号的等待者。
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        // 已停止运行（如 close）：静默。
        if (!this.running) return
        // 已是 CarrierError 则原样用；否则包装一层。
        const failure = error instanceof RemoteStreamCarrierError ? error
          : new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open', { cause: error })
        // 修订号未变（期间没有 reconnect）：缓存失败供后续 open 快速失败。
        if (this.revision === revision) this.failure = failure
        // 仅结算本次尝试之前排队（修订号不大于它）的等待者。
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(failure)
        }
      },
    )
    // 记录为当前保活尝试。
    this.keepAlive = task
    // 尝试结束后清空保活记录，允许下一次 maintain 发起新尝试。
    void task.then(() => {
      this.keepAlive = undefined
    })
  }

  // 让所有活跃逻辑流失败并停止其上行泵。
  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) {
      // 下行收件箱以该错误失败。
      stream.inbox.fail(error)
      // 停止上行泵。
      stream.pump?.stop()
    }
  }

  private send(socket: ConnectionWebSocket, message: RemoteStreamClientMessage): void {
    // 序列化为 JSON 文本帧发送。
    socket.send(JSON.stringify(message))
  }
}

// 逻辑流的下行收件箱：缓存服务端帧，用单槽唤醒让消费者异步等待下一帧或失败。
class StreamInbox {
  // 已收到但尚未被消费的帧队列。
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  // 等待下一帧的消费者唤醒器（单消费者模型下只会有一个）。
  private wake: (() => void) | undefined
  // 已缓存的失败：一旦设置，队列作废，后续读取直接抛出。
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    // 已失败：丢弃迟到的帧。
    if (this.failure !== undefined) return
    // 帧入队。
    this.frames.pushBack(frame)
    // 有等待者则唤醒。
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    // 幂等：失败只记录第一次。
    if (this.failure !== undefined) return
    // 归一为 Error（保留原始值作为 cause）。
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    // 清空缓存帧：终态之后不再交付旧数据。
    this.frames.clear()
    // 唤醒等待者让其抛出失败。
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    // 队列为空时挂起等待；有失败则抛出。
    while (this.frames.size === 0) {
      // 已失败：抛出缓存的错误。
      if (this.failure !== undefined) throw this.failure
      // 挂起：把唤醒器登记在单槽上，等 push/fail 唤醒。
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    // 取出并返回队首帧。
    return this.frames.popFront() as RemoteStreamServerMessage
  }
}

/**
 * Uplink items a stream handle queues for its carrier: the mux pump or the
 * in-process Host decoder iterates it as the stream's uplink. `end()` is the
 * Client half-close; `close()` marks the stream terminated, after which
 * `push()` throws. One consumer reads it, one read at a time.
 */
export class ClientUplinkQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  // 已排队待发送的条目。
  private readonly items = new Deque<unknown>()
  // 是否已半关闭（end 已调用）：之后 push 抛错。
  private ended = false
  // 是否已终止（close 已调用）：之后 push/next 都按终止处理。
  private closed = false
  // 等待条目的读取者唤醒器（单读取者）。
  private wake: (() => void) | undefined

  // 仅记录端点名用于错误消息。
  /** @param endpoint - canonical Remote endpoint named by failures. */
  constructor(private readonly endpoint: string) {}

  /**
   * Queue one item for the carrier.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} after `end()` or once the stream has terminated.
   */
  push(item: unknown): void {
    // 流已终止：拒绝入队。
    if (this.closed) throw new Error(`client api: ${this.endpoint} stream has terminated`)
    // 已半关闭：拒绝继续发送。
    if (this.ended) throw new Error(`client api: ${this.endpoint} uplink was ended`)
    // 条目入队。
    this.items.pushBack(item)
    // 唤醒等待中的读取者。
    this.signal()
  }

  /** Half-close: the carrier reads the queued items, then `end`. Idempotent; ignored after termination. */
  end(): void {
    // 幂等；终止后忽略。
    if (this.ended || this.closed) return
    // 标记半关闭：队列读完后再发 end 帧。
    this.ended = true
    // 唤醒读取者。
    this.signal()
  }

  /** The carrier stopped reading: the logical stream terminated or was disposed. Idempotent. */
  close(): void {
    // 幂等。
    if (this.closed) return
    // 标记终止。
    this.closed = true
    // 丢弃未发送的条目。
    this.items.clear()
    // 唤醒读取者让其看到终止。
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // 自身既是可迭代对象也是迭代器。
    return this
  }

  /**
   * Take the next queued item, waiting for one; ends after `end()` or `close()`.
   * @returns the next item, or the end of the uplink.
   * @throws {Error} when a read is already pending.
   */
  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      // 已终止：迭代结束。
      if (this.closed) return UPLINK_DONE
      // 有排队条目：立即交付。
      if (this.items.size > 0) return { value: this.items.popFront(), done: false }
      // 已半关闭且队列已空：迭代结束（泵随后发 end 帧）。
      if (this.ended) return UPLINK_DONE
      // 已有读取在等待：单消费者模型下不允许并发读取。
      if (this.wake !== undefined) throw new Error(`client api: ${this.endpoint} uplink has one pending read`)
      // 挂起等待 push/end/close 唤醒。
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * The carrier is done with the uplink: close it.
   * @returns the end of the uplink.
   */
  return(): Promise<IteratorResult<unknown>> {
    // 载体不再读取：视为终止并清空队列。
    this.close()
    return Promise.resolve(UPLINK_DONE)
  }

  private signal(): void {
    // 取出并调用唤醒器（一次性）。
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

// 推导浏览器端 Remote 流复用 WebSocket 的绝对地址。
function remoteStreamUrl(): string {
  // The mux route is registered absolute; a page resolves its document-relative
  // form against its own document base. A shell-owned Host on another origin
  // supplies that base through the transport.
  // 读取传输层注入的基准地址（跨源 Host 场景），否则退回页面文档基准。
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  // 以基准 URL 解析复用路径（去掉开头的 /）得到绝对 URL。
  const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
  // 按页面协议切换 WebSocket 协议：https 对应 wss，否则 ws。
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  // 返回最终地址字符串。
  return url.href
}
