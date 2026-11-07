/** Reconnecting lifecycle for one single-consumer Remote stream. */

// 引入 RemoteError 与 remoteErrorOf：用于构造/识别带宿主错误码的远程失败。
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// 仅类型导入：连接句柄（ConnectionHandle），这里只用到其 generation 观测源。
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 引入承载层（carrier）错误类：物理 WebSocket 故障的可重试信号。
import { RemoteStreamCarrierError } from './stream-client.ts'

// 单个流条目：在领域值之外附带交付它的物理代（generation）信息。
/** One item annotated with the physical Remote-stream generation that delivered it. */
export interface RemoteStreamItem<Item> {
  /** Monotone physical generation number within this logical stream. */
  readonly generation: number
  /** Decoded item yielded by the generated Remote method. */
  readonly value: Item
  /** Cancellation lifetime of the generation that delivered this item. */
  readonly signal: AbortSignal
  /** Mark this generation's opening baseline or cursor as accepted. */
  accept(): void
}

// 领域方注入的操作集合：如何打开一个物理代、如何给"正常结束"定性，以及承载层故障观察器。
/** Domain-owned operations used by {@link RemoteStream}. */
export interface RemoteStreamOptions<Item> {
  /** Diagnostic owner name used for cancellation failures. */
  readonly name: string
  /** Open one physical generation of the logical stream. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** Classify a normal generation end after or before its opening item was accepted. */
  readonly ended: (accepted: boolean) => Error
  /** Observe a retryable carrier loss before the supervisor waits or reopens. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
}

// 跨"物理代"重开一个逻辑 Remote 流：Connection 负责断连重试的节奏，网关只执行每一次换代请求；
// 开场条目与其后每个条目的去留由领域消费方掌控，仅在校验开场基线/游标后才调用 accept()。
/**
 * Reopens one logical Remote stream across carrier generations.
 *
 * Connection owns physical retry timing; Gateway performs each requested
 * replacement. The domain consumer owns its opening item and every later
 * item, and calls {@link RemoteStreamItem.accept} only after validating the
 * opening baseline or cursor.
 */
export class RemoteStream<Item> implements AsyncIterable<RemoteStreamItem<Item>> {
  // 逻辑流整体生命周期：一旦中止，整个流永久停止，不再重开任何物理代。
  private readonly lifetime = new AbortController()
  // 当前物理代的取消控制器：restart/dispose 用它中断正在读取的一代。
  private generationAbort: AbortController | undefined
  // 唯一消费者的迭代器；dispose 需要用它关闭生成器。
  private iterator: AsyncGenerator<RemoteStreamItem<Item>> | undefined
  // dispose 的关闭 Promise（缓存以保证幂等）。
  private closing: Promise<void> | undefined
  // 重开修订号：每次 restart 递增，用于让读取循环识别"当前代已被放弃"。
  private revision = 0
  // 是否已有消费者取走唯一的异步迭代器。
  private taken = false

  // 记录连接的 generation 观测源（用于重试节奏）与领域回调；构造时不做任何 IO。
  /**
   * @param connection - observable Host generation source used to pace retries.
   * @param options - domain stream opener, end classification, and diagnostics.
   */
  constructor(
    private readonly connection: Pick<ConnectionHandle, 'generation'>,
    private readonly options: RemoteStreamOptions<Item>,
  ) {}

  /** Cancellation lifetime shared by the stream and sibling page requests. */
  get signal(): AbortSignal {
    // 返回逻辑流生命周期信号：跟随/分页等兄弟请求共用它一起取消。
    return this.lifetime.signal
  }

  /** Interrupt the current generation and immediately request a replacement. */
  restart(): void {
    // 流已永久停止后 restart 无效。
    if (this.lifetime.signal.aborted) return
    // 递增修订号：读取循环据此判定当前代已被放弃。
    this.revision++
    // 立即中止当前物理代，其 open() 迭代被中断后循环会立刻重开。
    this.generationAbort?.abort(new Error(`${this.options.name} generation restarted`))
  }

  /**
   * Permanently stop this stream and wait for its iterator to close.
   * @returns when the active generation and consumer iterator are quiescent.
   */
  dispose(): Promise<void> {
    // 幂等：已在关闭中则复用同一个 Promise。
    if (this.closing !== undefined) return this.closing
    // 尚未停止过：先永久中止逻辑流与当前物理代。
    if (!this.lifetime.signal.aborted) {
      // 以 dispose 原因中止生命周期信号。
      const reason = new Error(`${this.options.name} disposed`)
      // 中止逻辑流整体。
      this.lifetime.abort(reason)
      // 同时中断正在读取的物理代。
      this.generationAbort?.abort(reason)
    }
    // 取出唯一消费者的迭代器。
    const iterator = this.iterator
    // 尚无人消费：无需关闭迭代器，直接完成。
    if (iterator === undefined) return Promise.resolve()
    // 关闭消费迭代器（吞掉取消失败），并缓存该 Promise 保证幂等。
    const closing = closeRemoteStreamIterator(iterator)
    this.closing = closing
    return closing
  }

  /** @inheritdoc */
  [Symbol.asyncIterator](): AsyncIterator<RemoteStreamItem<Item>> {
    // 单消费者：第二次取迭代器直接报错。
    if (this.taken) throw new Error(`${this.options.name} already has a consumer`)
    // 标记已被消费。
    this.taken = true
    // 创建后台读取生成器。
    const iterator = this.read()
    // 记录下来供 dispose 关闭。
    this.iterator = iterator
    // 返回该生成器作为迭代器。
    return iterator
  }

  // 读取主循环：不断打开物理代并向消费者交付条目，跨代重连与重试节奏都在这里。
  private async * read(): AsyncGenerator<RemoteStreamItem<Item>> {
    // 当前连续失败（承载层故障）次数，成功接受条目后归零。
    let attempt = 0
    // 物理代计数器，交付给条目的 generation 字段。
    let generation = 0
    // 上次观察到的修订号，用于检测 restart。
    let observedRevision = this.revision
    try {
      // 逻辑流未被永久中止就持续换代重开。
      while (!isAborted(this.lifetime.signal)) {
        // restart 发生过：同步观察到的修订号，并把重试计数清零（新要求视为全新开始）。
        if (observedRevision !== this.revision) {
          observedRevision = this.revision
          attempt = 0
        }
        // 记住本轮代的修订号，供后续判断"本代是否已被 restart 放弃"。
        const revision = this.revision
        // 为这一代创建独立的取消控制器（restart 用它中断读取）。
        const generationAbort = new AbortController()
        // 登记为当前代控制器，供 restart/dispose 触发。
        this.generationAbort = generationAbort
        // 这一代的取消信号 = 逻辑流生命周期 + 本代控制器的合成信号。
        const signal = AbortSignal.any([this.lifetime.signal, generationAbort.signal])
        // 物理代号递增，随条目交付。
        const generationId = ++generation
        // 领域是否已接受本代的开场条目（影响"正常结束"的定性）。
        let accepted = false
        try {
          // 打开一个物理代并逐值读取领域提供的 open() 迭代。
          for await (const value of this.options.open(signal)) {
            // 逻辑流已被永久停止：整个读取结束。
            if (isAborted(this.lifetime.signal)) return
            // 本代已被 restart 放弃：跳出内层循环去开新一代。
            if (revision !== this.revision) break
            // 把领域值包装成带代信息的条目交付给消费者（yield 处会等待消费者取走）。
            yield {
              generation: generationId,
              value,
              signal,
              accept: () => {
                // 代已被替换或 restart 过：接受无效，直接忽略。
                if (this.generationAbort !== generationAbort || revision !== this.revision) return
                // 记录"开场条目已被领域接受"。
                accepted = true
                // 成功接受条目：重置连续失败计数。
                attempt = 0
              },
            }
          }
          // 逻辑流已被永久停止：结束。
          if (isAborted(this.lifetime.signal)) return
          // 本代被 restart 放弃：直接进入下一轮循环开新代。
          if (revision !== this.revision) continue
          // open() 正常走完却没有换代：交由领域定性这是否是失败。
          throw this.options.ended(accepted)
        } catch (error) {
          // 逻辑流已被永久停止：静默结束。
          if (isAborted(this.lifetime.signal)) return
          // 本代被 restart 放弃：换下一轮，不把旧代的错误外抛。
          if (revision !== this.revision) continue
          // 非承载层错误（领域/协议失败）不可重试：标记为终态失败后外抛。
          if (!(error instanceof RemoteStreamCarrierError)) throw terminalStreamFailure(error)
          // 承载层可重试故障：先让领域观察一次（例如用于保住已发布窗口）。
          this.options.carrierFailed?.(error)
          // 等待期间又被 restart：换下一轮。
          if (revision !== this.revision) continue
          // 累计连续失败次数，参与重试节奏计算。
          attempt++
          try {
            // 按 Connection 的换代节奏等待重试时机（已连接则立即重试或判负）。
            await waitForRemoteStreamRetry(this.connection, error, attempt, signal)
          } catch (retryError) {
            // 等待期间逻辑流被永久停止：静默结束。
            if (isAborted(this.lifetime.signal)) return
            // 等待期间又被 restart：换下一轮。
            if (revision !== this.revision) continue
            // 重试等待失败（如信号中止之外的异常）：终态失败外抛。
            throw terminalStreamFailure(retryError)
          }
        } finally {
          // 无论以何种方式离开本代，都不再把它当作"当前代"。
          this.generationAbort = undefined
          // 若本代控制器还没被中止（正常走完），补一个"代已结束"的中止，通知打开中的 IO。
          if (!generationAbort.signal.aborted) {
            generationAbort.abort(new Error(`${this.options.name} generation ended`))
          }
        }
      }
    } finally {
      // 消费者退出（读毕或提前 return）而逻辑流还没停止：把它一并终止，避免无人读取的空转。
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort(new Error(`${this.options.name} consumer closed`))
      }
      // 中止残留的当前代控制器（原因取生命周期信号的中止原因）。
      this.generationAbort?.abort(this.lifetime.signal.reason)
      // 清空当前代控制器引用。
      this.generationAbort = undefined
    }
  }
}

// 按 Connection 的换代节奏等待重试时机：连接已就绪时立即返回或判负；未就绪则订阅换代事件。
async function waitForRemoteStreamRetry(
  connection: Pick<ConnectionHandle, 'generation'>,
  error: RemoteStreamCarrierError,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  // 调用方信号已中止：直接抛出，不再等待。
  signal.throwIfAborted()
  // 当前已有 Connection 代快照（连接在线）：
  if (connection.generation.getSnapshot() !== undefined) {
    // 第一次重试：立即重开，不给用户可感知的停顿。
    if (attempt === 1) return
    // 连续失败且连接明明在线：说明故障不是断连导致，把原承载错误抛回（终态化）。
    throw error
  }
  // 连接离线：挂起等待，直到 Connection 报告换代恢复（或信号中止）。
  await new Promise<void>((resolve, reject) => {
    // 订阅记录：dispose 是换代订阅的退订函数，finished 防止重复结算。
    const subscription: {
      dispose?: () => void
      finished: boolean
    } = { finished: false }
    // 统一结算入口：只生效一次，负责退订、移除 abort 监听并按成败 resolve/reject。
    const finish = (failure?: Error): void => {
      // 已结算过：忽略后续调用。
      if (subscription.finished) return
      // 标记已结算。
      subscription.finished = true
      // 退订换代事件。
      subscription.dispose?.()
      // 移除调用方信号上的 abort 监听。
      signal.removeEventListener('abort', aborted)
      // 无失败则完成等待；有失败则拒绝。
      if (failure === undefined) resolve()
      else reject(failure)
    }
    // 每次换代事件都检查连接是否已恢复（出现代快照即恢复）。
    const inspect = (): void => {
      if (connection.generation.getSnapshot() !== undefined) finish()
    }
    // 调用方信号中止：以中止错误拒绝等待。
    const aborted = (): void => {
      finish(new Error('Remote stream retry aborted', { cause: signal.reason }))
    }
    // 订阅 Connection 的换代通知。
    const dispose = connection.generation.subscribe(inspect)
    // 记录退订函数，供 finish 使用。
    subscription.dispose = dispose
    // 订阅回调里可能已经同步结算：此时立即退订。
    if (subscription.finished) dispose()
    // 监听调用方信号的中止（只触发一次）。
    signal.addEventListener('abort', aborted, { once: true })
    // 竞态兜底：注册监听前信号可能已中止，立即结算；否则先检查一次当前状态。
    if (signal.aborted) aborted()
    else inspect()
  })
}

/**
 * Mark a terminal escape before it crosses the stream boundary: consumers
 * discriminate failures by code, so an unmarked throw reads as a local bug.
 * Marked failures pass through verbatim. The carrier class never escapes as a
 * terminal outcome — it stays the retry-internal signal fed to `carrierFailed`
 * and the `ended(true)` retry trigger.
 */
function terminalStreamFailure(error: unknown): Error {
  // 已经是带码的远程失败：原样透传，不做二次包装。
  return remoteErrorOf(error) ?? new RemoteError(
    'gateway/internal',
    error instanceof Error ? error.message : String(error),
    {},
    { cause: error },
  )
}

// 信号是否已中止的小工具（读取循环里大量使用，收拢成一个谓词便于阅读）。
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

// 关闭消费迭代器：吞掉关闭过程中的错误（已释放的流不再有消费者在乎取消失败）。
async function closeRemoteStreamIterator<Item>(
  iterator: AsyncIterator<RemoteStreamItem<Item>>,
): Promise<void> {
  try {
    // 调用迭代器的 return() 触发生成器清理逻辑。
    await iterator.return?.()
  } catch {
    // The disposed logical stream has no remaining consumer for cancellation failures.
  }
}
