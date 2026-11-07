// 多路复用(mux) Typert Remote 流的 Host 端 WebSocket 持有者。
/** Host WebSocket owner for multiplexed Typert Remote streams. */

// 引入 HTTP 升级请求与双工套接字类型。
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
// 引入双端队列：上行收件箱的底层缓冲。
import { Deque } from '@deepseek-ai/dsh-deque'
// 引入 Remote 失败类型与工具：识别 Remote 失败、对等端作用域、上行窗口。
import { RemoteError, remoteErrorOf, type PeerScope, type RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol'
// 引入 ws 库的 WebSocket 与服务端，以及原始消息数据类型。
import WebSocket, { WebSocketServer, type RawData } from 'ws'
// 引入线上协议：客户端消息解析与帧/失败类型。
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/**
 * Open one validated Remote stream for a decoded wire request on behalf of one
 * Peer. `uplink` carries the Client's items; `control` cancels the logical
 * stream, and aborting it with a Remote failure as the reason delivers that
 * failure to the Client. `window` describes this stream's complete-frame inbox budget.
 */
// 代表某个对等端(Peer)为已解码的线上请求打开一个校验过的 Remote 流。
// `uplink` 承载 Client 的条目；`control` 取消逻辑流，且若以 Remote 失败为原因中止，
// 该失败会送达 Client。`window` 描述本流完整帧的收件箱预算。
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** The opener one socket uses: its Peer is fixed at upgrade time. */
// 单个套接字使用的开启器：其 Peer 在升级(upgrade)时就固定。
type BoundStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
  window: RemoteUplinkWindow,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
// 把调用或载体失败转换为稳定的线上值。
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

// 心跳容差：连续错过这么多次 Ping 即判定对端死亡。
const MAX_MISSED_HEARTBEATS = 2

/** Carrier options for {@link RemoteStreamMuxServer}. */
// 多路复用服务器的载体配置项。
export interface RemoteStreamMuxServerOptions {
  /** Interval between WebSocket Ping control frames. */
  // WebSocket Ping 控制帧的发送间隔。
  readonly heartbeatIntervalMs: number
  /** Buffered uplink frame bytes one logical stream may hold before it fails. */
  // 单个逻辑流在失败前允许缓冲的上行帧字节数。
  readonly streamInboxBytes: number
  /** Whether accepted connections negotiate the `permessage-deflate` extension. */
  // 受理的连接是否协商 `permessage-deflate` 压缩扩展。
  readonly compression: boolean
}

/** Own the no-server WebSocket acceptor and every active logical stream. */
// 持有无服务器(no-server)模式的 WebSocket 受理器与所有活跃逻辑流。
export class RemoteStreamMuxServer {
  // 底层 ws 服务器（noServer 模式，只做升级受理）。
  private readonly server: WebSocketServer
  // 心跳间隔配置。
  private readonly heartbeatIntervalMs: number
  // 上行收件箱字节预算配置。
  private readonly streamInboxBytes: number
  // 是否启用压缩配置。
  private readonly compression: boolean
  // 每条连接的完成 Promise 集合，close 时统一等待。
  private readonly connections = new Set<Promise<void>>()
  // 各套接字连续错过的心跳次数（WeakMap，连接关闭后自动回收）。
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  // 心跳定时器：首个升级后才启动，close 时清理。
  private heartbeatTimer: NodeJS.Timeout | undefined

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param options - heartbeat interval, uplink inbox bound, and compression setting for accepted connections.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    options: RemoteStreamMuxServerOptions,
  ) {
    // 固化三项配置。
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
    this.streamInboxBytes = options.streamInboxBytes
    this.compression = options.compression
    // 创建 noServer 的 ws 实例：升级由宿主 Web 服务器转交。
    this.server = new WebSocketServer({
      noServer: true,
      // `ws` ignores its own `threshold` option while context takeover is
      // enabled, so the mux decides per frame in send().
      // 上下文接管(context takeover)开启时 `ws` 会忽略自己的 `threshold` 选项，
      // 所以压缩与否由 send() 逐帧决定。
      perMessageDeflate: options.compression ? { zlibDeflateOptions: { level: 1 } } : false,
    })
  }

  /**
   * Upgrade one admitted request and begin serving its logical streams. Every
   * stream the socket opens speaks for the Peer admitted at upgrade, and the
   * socket closes when that Peer's scope is disposed.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   * @param peer - Peer the upgrade was admitted as.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope): void {
    // 把已鉴权的升级请求转交 ws，拿到 WebSocket 后开始服务其逻辑流。
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      // 把套接字绑定到 Peer 的作用域；已释放的 Peer 会直接关闭套接字。
      const release = bindPeer(websocket, peer)
      if (release === undefined) return
      // 活性回调：任何对端活动都会清零错过计数。
      const alive = (): void => { this.missedHeartbeats.set(websocket, 0) }
      alive()
      // 首个连接到来时启动共享心跳定时器。
      this.startHeartbeat()
      // 绑定 Peer 的开启器：调用时补上固定的 peer 参数。
      const bound: BoundStreamOpener = (endpoint, payload, uplink, control, window) =>
        this.open(endpoint, payload, uplink, peer, control, window)
      // 建立连接级处理器，接管该套接字的全部逻辑流。
      const connection = new RemoteStreamMuxConnection(
        websocket, bound, this.failure, this.streamInboxBytes, this.compression, alive,
      )
      // 串接连接生命周期：运行 → 释放 Peer 作用域，任何一步失败都记日志。
      const done = connection.run().catch((error: unknown) => {
        console.error('[api-gateway] Remote stream connection failed:', error)
      }).then(async () => { await release() }).catch((error: unknown) => {
        console.error('[api-gateway] Remote stream scope cleanup failed:', error)
      })
      // 登记完成 Promise，close 时等待全部连接收尾。
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) })
    })
  }

  /** Terminate all sockets and wait until every iterator has returned. */
  // 终止所有套接字，并等待每个迭代器都返回。
  async close(): Promise<void> {
    // 停掉心跳定时器。
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    // 强制断开所有客户端套接字。
    for (const socket of this.server.clients) socket.terminate()
    // 以外部可控的 Promise 包装 server.close 回调。
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    // 先等服务器完全关闭。
    await closed.promise
    // 再等所有连接的迭代器返回。
    await Promise.all(this.connections)
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  // 首次升级后启动一个 `unref()` 定时器；即使没有客户端也持续运行，直到 close()。
  private startHeartbeat(): void {
    // 已在运行则跳过。
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      // 每轮遍历所有客户端套接字。
      for (const socket of this.server.clients) {
        // 非 OPEN 状态跳过。
        if (socket.readyState !== WebSocket.OPEN) continue
        // 读取该套接字已错过的心跳次数。
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          // 延后到下一轮宏任务再终止：给刚到达的 Pong 一个机会。
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              socket.terminate()
            }
          })
          continue
        }
        // 先递增错过计数再发 Ping：Pong 到达时由 alive 回调清零。
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    // unref：不阻止进程因其他原因退出。
    this.heartbeatTimer.unref()
  }
}

// 单条活跃逻辑流的登记项。
interface ActiveStream {
  // 取消控制器：上行违约或取消时中止逻辑流。
  readonly abort: AbortController
  // 该流的上行收件箱。
  readonly inbox: UplinkInbox
  /** Cancel the logical stream and end any Host read still waiting on its uplink. */
  // 取消逻辑流，并让仍在等待上行的 Host 读取立即结束。
  readonly stop: (reason: Error) => void
  // 泵送完成（含收尾）的 Promise。
  done: Promise<void>
}

// 单个 WebSocket 连接的复用处理器。
class RemoteStreamMuxConnection {
  // 流 id → 活跃流登记表。
  private readonly streams = new Map<string, ActiveStream>()
  // 下行写串行链：保证帧按序写出。
  private writes = Promise.resolve()

  // 构造注入：参数即成员，无额外逻辑。
  constructor(
    private readonly socket: WebSocket,
    private readonly open: BoundStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly streamInboxBytes: number,
    private readonly compression: boolean,
    private readonly alive: () => void,
  ) {}

  /**
   * Serve frames until the socket closes. A Pong, any received frame, and a
   * downlink write that does not complete at once count as peer activity, so
   * a congested link that delays the Pong behind data keeps its socket. A
   * frame above the compression threshold deflates asynchronously, so its
   * completion always counts; a write that completes at once proves nothing
   * about the peer and does not count.
   */
  async run(): Promise<void> {
    // 以 Promise 表达“套接字关闭”这一终态。
    const closed = new Promise<void>((resolve) => {
      // 正常关闭即解决。
      this.socket.once('close', resolve)
      // 错误直接终止套接字（随后触发 close）。
      this.socket.once('error', () => { this.socket.terminate() })
      // Pong 属于对端活动。
      this.socket.on('pong', this.alive)
      this.socket.on('message', (data, isBinary) => {
        // 任何收到的帧都算对端活动。
        this.alive()
        if (isBinary) {
          // 协议只允许文本帧：以 1003 关闭。
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          // 解析并分发文本帧。
          this.receive(rawText(data))
        } catch {
          // 非法请求（含重复 open）：以 1008 关闭。
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    // 等待套接字关闭。
    await closed
    // 关闭后取消所有仍活跃的逻辑流。
    const active = [...this.streams.values()]
    for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
    // 等待每条流的泵送收尾完成。
    await Promise.all(active.map(stream => stream.done))
  }

  /**
   * Dispatch one frame. `item`, `end`, and `cancel` for a stream this connection
   * no longer owns are dropped: a finished stream leaves the table while the
   * Client's in-flight frames are still arriving. A duplicate `open` is the one
   * protocol violation that closes the socket.
   */
  private receive(text: string): void {
    // 先解析校验，失败会抛给 run() 关闭套接字。
    const message = parseRemoteStreamClientMessage(text)
    // 按帧型分发；找不到流 id 的 item/end/cancel 直接忽略（流已结束后迟到帧属正常）。
    switch (message.type) {
      case 'open': {
        // 打开新逻辑流。
        this.openStream(message)
        return
      }
      case 'item': {
        // 上行条目连同整帧字节一起入收件箱。
        this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      }
      case 'end': {
        // 上行半关闭。
        this.streams.get(message.streamId)?.inbox.end()
        return
      }
      case 'cancel': {
        // 以取消原因停掉该流。
        this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
        return
      }
      /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
      // 解析器只放行上述四种帧，此分支不可达（测试覆盖豁免）。
      default: {
        const unknown: never = message
        throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`)
      }
    }
  }

  private openStream(message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>): void {
    // 重复 open 是唯一关闭套接字的协议违例。
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    // 每条流一个取消控制器。
    const abort = new AbortController()
    // Created before the opener resolves so items the Client sends right
    // after `open` wait in the inbox instead of being lost.
    // 收件箱在开启器解决之前就建好：Client 紧随 `open` 发来的条目会先排队而不会丢失。
    const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error) })
    // 登记项：stop 同时中止控制器并让收件箱失败，唤醒所有等待者。
    const active: ActiveStream = {
      abort,
      inbox,
      stop: (reason) => {
        abort.abort(reason)
        inbox.fail(reason)
      },
      done: Promise.resolve(),
    }
    // 先入表，再启动泵送。
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    // 无论成功失败，结束后都从表中移除。
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    // 记录泵送结果：失败与否及原因。
    let outcome: { readonly failed: false } | { readonly failed: true; readonly error: unknown }
    try {
      // 让网关开启真正的业务流；窗口参数按本流的收件箱预算计算。
      const source = await this.open(endpoint, payload, active.inbox, active.abort, {
        maxBytes: this.streamInboxBytes,
        frameOverheadBytes: Buffer.byteLength(JSON.stringify({ type: 'item', streamId, value: null }), 'utf8') - 'null'.length,
      })
      // 逐值下发，直到业务流结束。
      for await (const value of source) {
        await this.send({ type: 'item', streamId, value })
      }
      outcome = { failed: false }
    } catch (error) {
      // 打开或消费阶段的失败都记录为终态。
      outcome = { failed: true, error }
    }
    // The downlink has settled; later uplink frames cannot change the outcome.
    // 下行已落定；此后的上行帧不再影响结果。
    active.inbox.fail(new Error('Remote stream ended'))
    if (active.abort.signal.aborted) {
      // A Remote failure as the abort reason is the Gateway or this mux failing
      // the stream (a rejected or overflowing uplink item, or an item after
      // end); the Client is still waiting for that terminal frame. Any other
      // abort is a cancellation.
      // 以 Remote 失败为中止原因，意味着网关或多路复用器让流失败（上行条目被拒/溢出，或 end 之后再收 item），
      // Client 仍在等这个终态帧；其他中止都属取消。
      const reason: unknown = active.abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) await this.sendFailure(streamId, reason)
      return
    }
    if (outcome.failed) {
      // 业务失败：转成稳定线上值下发。
      await this.sendFailure(streamId, outcome.error)
      return
    }
    try {
      // 正常结束：补发 end 帧。
      await this.send({ type: 'end', streamId })
    } catch (error) {
      // end 帧发不出去也按失败处理。
      await this.sendFailure(streamId, error)
    }
  }

  private async sendFailure(streamId: string, error: unknown): Promise<void> {
    // 套接字已不开放则无处可发。
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      // 经失败映射器转成载体安全的错误帧。
      await this.send({ type: 'error', streamId, error: this.failure(error) })
    } catch {
      // A terminal frame that cannot be encoded or written leaves the
      // logical stream ambiguous, so fail the physical generation.
      // 终态帧编码或写出失败会让逻辑流悬而未决，因此直接失败整个物理连接代。
      this.socket.close(1011, 'Remote stream failure could not be delivered')
    }
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      // 序列化帧。
      text = JSON.stringify(message)
    } catch (cause) {
      // 序列化失败（如循环引用）直接以 Promise 拒绝。
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    // 挂到写链尾部，保证帧有序；真正的写出在回调 Promise 中完成。
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      // 写前再检查连接是否仍开放。
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      let queued = false
      this.socket.send(text, {
        // 压缩策略：启用压缩且帧达到阈值（1KiB）才逐帧压缩。
        compress: this.compression && text.length >= 1024,
      }, (error) => {
        if (error) {
          // 写失败上抛。
          reject(error)
          return
        }
        // 写完成且当初有积压：说明对端确实在收，算一次活动。
        if (queued) this.alive()
        resolve()
      })
      // Read after send(): buffered bytes mean the write did not complete at
      // once, so its completion counts as peer activity. For a compressed frame
      // the buffered bytes include ws's deflate queue, not just the TCP send
      // buffer.
      // 在 send() 之后读取：有缓冲字节说明写未立即完成，其完成才算对端活动；
      // 压缩帧的缓冲还包含 ws 的 deflate 队列，不只是 TCP 发送缓冲。
      queued = this.socket.bufferedAmount > 0
    }))
    // 写链吞掉错误继续，避免后续帧被前一个失败卡死；错误由 delivery 本身上抛。
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

// 上行收件箱中的单个条目。
interface UplinkEntry {
  // 条目值。
  readonly value: unknown
  // 该帧占用的字节数，用于预算核算。
  readonly bytes: number
}

// 复用的“迭代结束”结果对象。
const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * Host method reads through `invocation.uplink()`. Buffered frame bytes are
 * capped: overflow, and an item after the Client's `end`, fail the queue and
 * report a Remote failure that the connection uses to fail the logical stream.
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  // 缓冲队列。
  private readonly queue = new Deque<UplinkEntry>()
  // 当前缓冲的字节总量。
  private bytes = 0
  // Client 是否已半关闭上行。
  private ended = false
  // 消费者是否已停止读取。
  private closed = false
  // 迭代器是否已被取走（单消费者）。
  private taken = false
  // 终态失败：置位后所有后续读取都抛它。
  private failure: Error | undefined
  // 唤醒挂起读取的回调。
  private wake: (() => void) | undefined

  // 字节上限、端点与违例回调均由构造注入。
  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>) => void,
  ) {}

  push(value: unknown, frameBytes: number): void {
    // 已失败或已关闭：静默丢弃迟到条目。
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      // end 之后再收条目是协议违例：让整条流失败。
      this.violate(new RemoteError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      // 超出缓冲字节预算：以溢出失败让整条流失败。
      this.violate(new RemoteError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ))
      return
    }
    // 入队并累加字节，再唤醒挂起的读取。
    this.queue.pushBack({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client half-close; idempotent. */
  // Client 半关闭；幂等。
  end(): void {
    if (this.ended) return
    this.ended = true
    // 唤醒等待者，让它们看到“不会再有数据”。
    this.signal()
  }

  /** End the consumer's next read with `error`; idempotent, drops buffered items. */
  // 让消费者的下一次读取以 `error` 结束；幂等，并丢弃已缓冲条目。
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.clear()
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // 单消费者：第二次取迭代器直接报错。
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    // 拉取循环：队列有值出值，否则按状态结束、失败或挂起等待。
    while (true) {
      // 消费者已停止：一律报告结束。
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.popFront()
      if (entry !== undefined) {
        // 出队成功：扣减字节预算并返回该值。
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      // 半关闭且无积压：正常结束。
      if (this.ended) return UPLINK_DONE
      // 单消费者约束：不允许并发读取。
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      // 挂起等待下一次 push/end/fail 的唤醒。
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** Consumer stopped reading: later items are dropped, a pending read ends. */
  // 消费者停止读取：此后条目一律丢弃，挂起的读取立即结束。
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>): void {
    // 先让收件箱失败，再通知连接中止整条逻辑流。
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    // 取出并清空唤醒回调后调用，保证只唤醒一次。
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Close the socket when the Peer's scope is disposed. A scope that is already
 * disposed leaves no Peer for the socket to speak for, so the socket closes now.
 * @returns the registration's disposer, or `undefined` when the socket was closed.
 */
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    // 在 Peer 作用域上注册清理副作用：作用域释放时以 1001 关闭套接字。
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
  } catch {
    // Peer 已释放：没有可代表的主体，立即关闭套接字。
    websocket.close(1001, 'peer left')
    return undefined
  }
}

function rawText(data: RawData): string {
  // 分片数组：拼接后解码。
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  // ArrayBuffer：包装后解码。
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  // 其余（Buffer/Buffer 视图）：直接解码。
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403 | 409): void {
  // 按状态码选择标准短语。
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Conflict'
  // 正文用小写短语，长度与之对应。
  const body = reason.toLowerCase()
  // 手写 HTTP 拒绝响应：不把套接字所有权交给 ws。
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
