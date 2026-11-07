// 通用按会话投影（projection）值存储（推送模型）：Host 是唯一计算点，客户端按键保存两种来源的成品值；键寻址的裸可观察面供 useProjection 使用。
/**
 * Generic per-session projection value store (push model; see the
 * session-projection subsystem page, docs/subsystems/session-projection.md):
 * the host is the only computation site; the client holds finished whole
 * values per key in one of two row kinds. A `sequenced` row
 * (`{ value, seq }`) comes from the connected Host — a follow opening
 * baseline, a Session Controller `projection` frame, a list block the Host
 * computed for an attached Session — and merges under **higher seq wins**
 * against other sequenced rows. A `cached` row (`{ value }`) comes from
 * a Host view of the persisted checkpoint, carries no comparable
 * seq, and yields to every sequenced write. No client-side domain folding
 * exists: a domain ships projection support with zero client code. Per-key
 * bare observable faces feed `useProjection` (ui-renderer binds them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Notifier } from './notifier.ts'

// The single projection type table, typed end to end (host unit, wire block,
// client store, React hook) — the Service Definition package's pure-type outlet
// (`/types`, zero imports), never the package root: the root's dsh-agent →
// dsh-session chain would drag the host `Context.sessions` merge into the
// client program (one program must not hold both sides). No second
// client-side "views" table (rejected in the Alternatives of
// .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
// 端到端贯通（host 单元、线块、客户端存储、React 钩子）的唯一投影类型表；只从纯类型出口（/types，零导入）导入，绝不从包根导入：包根的依赖链会把 Host 的 Context.sessions 合并拖进客户端程序。
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

// 第五个框架钩子席位：按键寻址的投影读取器，经标准 kit 交付；undefined 统一表示能力缺失（host 单元未挂载，或尚无基线/帧携带该键）。选择器重载镜像 useSession（每键 uSES 绑定）。
/**
 * The fifth framework hook seat (see the session-projection subsystem page,
 * docs/subsystems/session-projection.md): key-addressed
 * projection reader delivered through the standard kit. `undefined` uniformly
 * means capability absent — host unit unmounted, or no baseline/frame has
 * carried the key yet. The selector overload mirrors useSession (per-key uSES
 * binding; reference stability holds because a key's value reference changes
 * only when a frame or baseline lands).
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

// follow 打开时的投影基线，在此复述以免 React-free 存储依赖线协议包的响应词汇。
/**
 * Follow-opening projection baseline, restated here so the
 * React-free store depends only on the type table, not the wire package's
 * response vocabulary.
 */
export interface ProjectionsBaseline {
  // 一致性切点（consistent-cut）seq（按构造等于窗口尾 seq）。
  /** The consistent-cut seq (equals the window tail seq by construction). */
  asOfSeq: SessionSeqCursor
  // 键 → 当前完整值；已注册键在此缺失即能力缺失。
  /** Whole current values by key; a registered key absent here means the capability is absent. */
  values: Readonly<Record<string, unknown>>
}

// 单键的行：sequenced 行来自当前连接代内 Host 的计算并携带可比 seq；cached 行来自无会话的仅列表头检查点视图，其来源无法担保 seq 可比，故不带 seq、让位于一切 sequenced 写入。
/**
 * One key's row. A `sequenced` row was computed by the Host for this Session
 * within the current connection generation and carries the seq it is
 * consistent with; seqs of sequenced rows are comparable with each other. A
 * `cached` row was viewed from the persisted projection checkpoint by a
 * header-only listing without a Session: its origin cannot vouch that its
 * stored seq is comparable with the log the client later opens, so it carries
 * none and yields to every sequenced write.
 */
type Row =
  | { kind: 'cached'; value: unknown }
  | { kind: 'sequenced'; value: unknown; seq: SessionSeqCursor }

// 每键通知通道：裸面加上它的合批通知器。
/** Per-key notification channel: the bare face plus its batching notifier. */
interface Channel {
  // 该键的裸可观察面。
  face: ObservableSnapshot<unknown>
  // 该键的合批通知器。
  notifier: Notifier
}

// 单个会话的投影值集合：框架语义对所有键一致——sequenced 写入之间比 seq（同代内低或相等者落败：重放帧不能回退值，过期基线不能覆盖更新帧）；cached 写入只填无 sequenced 行的键，基线播种前无条件丢弃全部 cached 行（已连接会话即真相）；从未见过的键读作 undefined（能力缺失）；面按键按需创建并缓存（身份稳定），粗粒度消费者走 subscribeAny。
/**
 * One session's projection values. Framework semantics, uniform across every
 * key. Sequenced writes (a baseline seeds rows at its cut, a push frame
 * updates one row) compare seqs among themselves: a lower-or-equal seq within
 * the Host generation loses, so a replayed frame cannot regress a value and a
 * stale baseline cannot overwrite a newer frame. Cached writes (the session
 * list's zero-I/O block) only fill keys no sequenced row holds, and a baseline
 * discards every cached row before it seeds, regardless of seq: the connected
 * Session is the truth and a cached value never outranks it. A key the store
 * has never seen reads `undefined` (capability absent). Faces are identity-stable
 * per key (create-on-demand, cached) so the React side binds each exactly
 * once; the store-level channel (`subscribeAny`) serves coarse consumers (the
 * manager's list projection reads the `title` key).
 */
export class ProjectionValueStore {
  // 键 → 当前值行。
  private readonly rows = new Map<string, Row>()
  // 键 → 通知通道（按需创建并缓存，保证面身份稳定）。
  private readonly channels = new Map<string, Channel>()
  // values() 的引用稳定缓存。
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
  private readonly anyNotifier = new Notifier(() => {})

  // 按键寻址的裸可观察面（useProjection 的解析路径）；永远有面——缺失是 undefined 快照而非缺面，组件可在键有值之前先订阅。
  /**
   * Key-addressed bare observable face (the useProjection resolution path).
   * Always defined — absence is an `undefined` snapshot, never a missing
   * face, so a component may subscribe before the key ever carries a value.
   * @param key - projection key.
   * @returns the identity-stable face for this key.
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    // 按需创建并缓存该键的通道。
    return this.channel(key).face
  }

  // 读取某键的当前完整值（擦除框架读取；类型化读取走 useProjection 的映射查找）。
  /**
   * Current whole value for a key (erased framework read; typed reads go
   * through `useProjection`'s map lookup).
   * @param key - projection key.
   * @returns the value, or undefined while the key is absent.
   */
  get(key: string): unknown {
    // 行缺失即返回 undefined。
    return this.rows.get(key)?.value
  }

  // 读取已接受的 Host 水位（watermark），不订阅也不复制值。
  /**
   * Read the accepted Host watermark without subscribing or copying a value.
   * @param key - projection key.
   * @returns the current sequence, or undefined for absent and cached values.
   */
  seqOf(key: string): SessionSeqCursor | undefined {
    // 取当前行。
    const row = this.rows.get(key)
    // 只有 sequenced 行携带可比 seq。
    return row?.kind === 'sequenced' ? row.seq : undefined
  }

  // 以一个引用稳定快照读取全部当前投影值。
  /**
   * Read every current projection value as one reference-stable snapshot.
   * @returns The same frozen value map until a row changes.
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    // 缓存缺失才重建。
    if (this.valuesCache === undefined) {
      // 冻结的键值映射，保证引用稳定。
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    // 返回缓存快照。
    return this.valuesCache
  }

  // 订阅任意键变更（微任务合批）——管理器的列表重建通道。
  /**
   * Subscribe to any-key changes (microtask-batched) — the manager's list
   * rebuild channel.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribeAny(listener: () => void): () => void {
    // 直接挂到粗粒度通知器。
    return this.anyNotifier.subscribe(listener)
  }

  // 应用来自 Session 控制流的一个成品值。
  /**
   * Apply one finished value from the Session control stream.
   * @param key - projection key.
   * @param value - whole value computed by the host unit.
   * @param seq - the unit's watermark at emission.
   */
  apply(key: string, value: unknown, seq: SessionSeqCursor): void {
    // 取旧行。
    const row = this.rows.get(key)
    // higher seq wins among sequenced rows; replays and stale frames drop. A
    // cached row has no comparable seq and always yields.
    // sequenced 行之间高 seq 胜：重放与过期帧被丢弃；cached 行没有可比 seq，总是让位。
    if (row?.kind === 'sequenced' && seq <= row.seq) return
    // 覆盖为新的 sequenced 行。
    this.rows.set(key, { kind: 'sequenced', value, seq })
    // 触发键级与全局变更通知。
    this.changed(key)
  }

  // 用 Host 标记为 cached 的数据块填键：持久检查点的零 I/O 视图；只落没有 sequenced 行的键——已连接会话已作答，列表对检查点的视图不可能更新。
  /**
   * Fill keys from a Host block labeled `cached`: a zero-I/O
   * view of the persisted checkpoint. A cached value lands only where no
   * sequenced row exists: a connected Session has already answered for such
   * a key, and the list's view of the persisted checkpoint cannot be newer
   * than it.
   * @param values - whole values by key viewed from the persisted checkpoint.
   */
  applyCached(values: Readonly<Record<string, unknown>>): void {
    // 逐键尝试落地。
    for (const key of Object.keys(values)) {
      // 已有 sequenced 行的键：cached 值不能更新。
      if (this.rows.get(key)?.kind === 'sequenced') continue
      // 写入 cached 行。
      this.rows.set(key, { kind: 'cached', value: values[key] })
      // 触发变更通知。
      this.changed(key)
    }
  }

  // 用历史尾页的 projections 块播种：先无条件丢弃全部 cached 行（块来自已连接会话，检查点视图绝不更高）；块携带的键按与帧相同的 seq 规则落地；块缺失的键视为切点处能力缺失——除非更新的帧已越过切点（过期基线既不能覆盖也不能清除更新的 sequenced 值）。
  /**
   * Seed from a history tail page's projections block. Every cached row is
   * discarded first, regardless of seq: the block comes from the connected
   * Session, and a value viewed from the persisted checkpoint never outranks
   * it. Then every carried key lands under the same seq rule as frames, and a
   * key the block omits is capability-absent as of the cut — its row clears
   * unless a newer frame already superseded the cut (a stale baseline can
   * neither overwrite nor clear newer sequenced values).
   * @param baseline - the response's projections block.
   */
  seed(baseline: ProjectionsBaseline): void {
    // 第一遍：清除所有 cached 行。
    for (const [key, row] of this.rows) {
      // 只清 cached 行。
      if (row.kind !== 'cached') continue
      // 删除该行。
      this.rows.delete(key)
      // 通知变更。
      this.changed(key)
    }
    // Erased walk: the framework crosses the open key space; per-key typing
    // is re-established at the consumer (useProjection's map lookup).
    // 擦除式遍历：框架跨越开放的键空间；按键类型在消费端（useProjection 的映射查找）重新建立。
    const values = baseline.values as Record<string, unknown>
    // 块携带的每个键按帧的 seq 规则落地。
    for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq)
    // 第二遍：清理切点处应缺失的键。
    for (const [key, row] of this.rows) {
      // 块携带的键不在清理范围。
      if (Object.hasOwn(values, key)) continue
      // Every cached row was deleted above; the kind test only narrows the
      // type so `row.seq` is readable.
      // 上面的 cached 行已删光；这里的类型判断只是收窄类型以便读取 row.seq。
      // 比切点更新的 sequenced 值：过期基线既不能覆盖也不能清除。
      if (row.kind === 'sequenced' && row.seq > baseline.asOfSeq) continue
      // 清除该键的行。
      this.rows.delete(key)
      // 通知变更。
      this.changed(key)
    }
  }

  // 丢弃某 Host 代的全部值与水位，但保留已订阅的面。
  /** Discard one Host generation's values and watermarks while preserving subscribed faces. */
  clear(): void {
    // 逐键清除并通知。
    for (const key of this.rows.keys()) {
      // 删除行。
      this.rows.delete(key)
      // 通知变更。
      this.changed(key)
    }
  }

  // 键级变更：作废缓存并通知对应通道。
  private changed(key: string): void {
    // 作废 values() 缓存。
    this.valuesCache = undefined
    // 唤醒该键的订阅者。
    this.channels.get(key)?.notifier.markDirty()
    // 唤醒粗粒度订阅者。
    this.anyNotifier.markDirty()
  }

  // 按需创建并缓存某键的通知通道。
  private channel(key: string): Channel {
    // 先查缓存。
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // The notifier only batches (no snapshot cache to rebuild: faces read rows directly).
      // 通知器只做合批（没有快照缓存要重建：面直接读行）。
      const notifier = new Notifier(() => {})
      // 组装通道：面即时读行，订阅走通知器。
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      // 缓存通道，保证面身份稳定。
      this.channels.set(key, channel)
    }
    // 返回（新建或既有的）通道。
    return channel
  }
}
