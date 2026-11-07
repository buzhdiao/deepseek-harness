/** Baseline-and-delta protocol layered over a reconnecting Remote stream. */

// 引入 RemoteError：用于构造带网关错误码（gateway/internal）的协议违规错误。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 仅类型导入：底层"跨代重连"逻辑流（RemoteStream），本模块按"快照+增量"协议消费它。
import type { RemoteStream } from './remote-stream.ts'

// 构造"协议违规"（protocol violation）错误的工厂：宿主（Host）发出的帧违反了本协议约定。
// 错误自带 gateway/internal 码，消费方据此把它当作可展示的错误状态，而不是本地程序缺陷。
/** Host-side stream protocol violation, marked so consumers surface it as an error state. */
function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  // 以固定错误码 gateway/internal 包装诊断消息，形成标准 RemoteError。
  return new RemoteError('gateway/internal', message, {})
}

// 领域方（domain）注入的回调集合：告诉本类如何区分快照与增量、如何落地状态、如何上报失败。
/** Domain operations for one snapshot stream. */
export interface RemoteSnapshotStreamOptions<Snapshot, Delta> {
  /** Diagnostic stream name used in protocol failures. */
  readonly name: string
  /** Distinguish the opening snapshot from later deltas. */
  readonly isSnapshot: (value: Snapshot | Delta) => value is Snapshot
  /** Atomically replace the domain model from a complete snapshot. */
  readonly replace: (snapshot: Snapshot) => void
  /** Apply one incremental update after the generation snapshot. */
  readonly update: (delta: Delta) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/**
 * Consumes generations that each contain exactly one opening snapshot followed by deltas.
 *
 * The previous domain snapshot remains published while the underlying stream retries. A
 * replacement becomes accepted only after the domain owner applies it successfully.
 */
export class RemoteSnapshotStream<Snapshot, Delta> {
  // 是否已启动后台消费循环（start 只允许生效一次）。
  private started = false
  // 是否已永久释放（dispose 后不再向领域回调上报任何失败）。
  private disposed = false
  // 后台消费循环的完成 Promise，dispose 时需要等待它静默。
  private done: Promise<void> | undefined

  // 保存底层重连流与领域回调；此刻不启动任何读取。
  /**
   * @param stream - reconnecting physical-generation stream.
   * @param options - frame discriminator and domain state destinations.
   */
  constructor(
    private readonly stream: RemoteStream<Snapshot | Delta>,
    private readonly options: RemoteSnapshotStreamOptions<Snapshot, Delta>,
  ) {}

  /** Start the single consumer; repeated calls are inert. */
  start(): void {
    // 幂等：重复调用 start 不产生第二个消费者。
    if (this.started) return
    // 标记已启动，防止后续再次启动。
    this.started = true
    // 启动后台消费循环并记录其完成 Promise，供 dispose 等待。
    this.done = this.consume()
  }

  /** Replace the active physical generation without discarding the published snapshot. */
  restart(): void {
    // 委托底层流中断当前物理代并立即请求重开；已发布的快照保持不动。
    this.stream.restart()
  }

  /**
   * Permanently stop the stream and wait for its consumer to become quiescent.
   * @returns when no generation or callback can still run.
   */
  async dispose(): Promise<void> {
    // 先标记释放：此后消费循环即使抛错也不再上报给领域。
    this.disposed = true
    // 永久停止底层重连流（中断当前物理代）。
    await this.stream.dispose()
    // 再等待后台消费循环完全静默，保证之后不会再有回调运行。
    await this.done
  }

  // 单消费者循环：逐帧读取底层流，把每个物理代的开场快照与后续增量分发给领域回调。
  private async consume(): Promise<void> {
    // 当前已见条目的物理代号（0 表示尚未收到任何条目）。
    let generation = 0
    // 当前物理代是否已经消费过开场快照。
    let snapshotSeen = false
    try {
      // 逐条读取跨代重连流交付的条目（每条携带其所属物理代的信息）。
      for await (const item of this.stream) {
        // 物理代切换：说明底层重开了一次流，新代必须以快照重新开始。
        if (item.generation !== generation) {
          // 记录新的物理代号。
          generation = item.generation
          // 新代尚未见到开场快照。
          snapshotSeen = false
        }
        // 用领域提供的判别函数区分这一帧是开场快照还是增量。
        if (this.options.isSnapshot(item.value)) {
          // 一个物理代内出现第二个快照属于宿主协议违规。
          if (snapshotSeen) {
            throw protocolViolation(`${this.options.name} emitted more than one opening snapshot`)
          }
          // 用完整快照原子替换领域模型。
          this.options.replace(item.value)
          // 标记本代已见到快照，后续帧按增量处理。
          snapshotSeen = true
          // 向流确认本代的开场基线已被接受（影响"正常结束"的判定）。
          item.accept()
          // 处理完快照帧，继续读下一帧。
          continue
        }
        // 快照之前先到增量，同样是宿主协议违规。
        if (!snapshotSeen) {
          throw protocolViolation(`${this.options.name} emitted an update before its opening snapshot`)
        }
        // 正常增量：在当前代快照的基础上应用一次领域更新。
        this.options.update(item.value)
      }
    } catch (error) {
      // 流终止或协议违规：只要不是主动 dispose 引发的，就作为终态失败上报领域。
      if (!this.disposed) this.options.failed(error)
    }
  }
}
