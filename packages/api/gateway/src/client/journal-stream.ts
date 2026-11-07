/** Cursor, page, and live-tail coordination over a reconnecting Remote stream. */

// 引入 RemoteError：构造带网关错误码的协议违规错误。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 引入承载层错误类型：重连期间向领域观察者暴露的"可重试故障"。
import { RemoteStreamCarrierError } from './stream-client.ts'
// 引入跨代重连流及其条目/选项类型：日志流（journal）构建在其上。
import type {
  RemoteStream,
  RemoteStreamItem,
  RemoteStreamOptions,
} from './remote-stream.ts'

// 构造"协议违规"错误：宿主帧违反日志流协议时使用，消费方将其呈现为错误状态。
/** Host-side stream protocol violation, marked so consumers surface it as an error state. */
function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  // 固定 gateway/internal 码包装诊断消息。
  return new RemoteError('gateway/internal', message, {})
}

// 日志流帧：与传输无关的开场快照（opened）、持久条目（entry），或无游标通知（notification）。
/** Transport-neutral opening snapshot, durable entry, or cursorless notification. */
export type RemoteJournalFrame<Entry, Cursor, Page, Notification = never> =
  | { readonly type: 'opened'; readonly cursor: Cursor; readonly page: Page }
  | { readonly type: 'entry'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

// 领域可见的窗口变更：整体替换（replace）、历史前插（prepend）、追加（append）或无游标通知。
/** One journal-window update or cursorless domain notification. */
export type RemoteJournalChange<Page, Entry, Notification = never> =
  | {
    readonly type: 'replace'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | {
    readonly type: 'prepend'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

// 带物理代信息的日志流条目：帧内容 + 交付它的代与取消信号。
type JournalStreamItem<Page, Entry, Cursor, Notification> = RemoteStreamItem<
  RemoteJournalFrame<Entry, Cursor, Page, Notification>
>

// 网关能力抽象：创建一个跨代重连的 Remote 流（子类经它接入 $stream 或等价物）。
/** Gateway capability used to create one reconnecting Remote stream. */
export interface RemoteStreamFactory {
  /**
   * Create one independently cancellable logical stream.
   * @param options - domain-owned opener and generation-end classification.
   * @returns a reconnecting single-consumer stream.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
}

// 领域注入的游标代数与发布回调：定义条目/页/游标如何比较、衔接，以及状态如何落地。
/** Domain publication and cursor operations for one addressed journal stream. */
export interface RemoteJournalStreamOptions<Page, Entry, Cursor, Notification = never> {
  /** Diagnostic stream name used in protocol failures. */
  readonly name: string
  /** Cursor representing a journal with no entries. */
  readonly emptyCursor: Cursor
  /** Read the ordered entries carried by a page. */
  readonly entries: (page: Page) => readonly Entry[]
  /** Read whether an older page exists. */
  readonly hasMore: (page: Page) => boolean
  /** Read the inclusive first durable cursor covered by one entry. */
  readonly first: (entry: Entry) => Cursor
  /** Read the inclusive final cursor, which must not precede the first. */
  readonly last: (entry: Entry) => Cursor
  /** Compare two cursors. */
  readonly compare: (left: Cursor, right: Cursor) => number
  /** Test whether the right cursor immediately follows the left cursor. */
  readonly follows: (left: Cursor, right: Cursor) => boolean
  /** Apply one complete journal-window change or cursorless notification. */
  readonly publish: (change: RemoteJournalChange<Page, Entry, Notification>) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

// 日志流基类：负责快照优先的开场、有序实时交付、分页（prepend/补洞）与修复。
/**
 * Owns snapshot-first opening, ordered live delivery, pagination, and repair.
 *
 * The domain retains its published window during reconnection. A replacement is
 * published only after the opening page reaches the generation's cursor.
 * Notifications never change a cursor and wait behind an in-flight gap repair.
 */
export abstract class RemoteJournalStream<
  Page, Entry, Cursor, PageRequest = void, Notification = never,
> {
  // 底层跨代重连流：承载 opened/entry/notification 帧。
  private readonly stream: RemoteStream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>
  // 首次 open 的页请求：留作后续重连与补洞（gap repair）的派生来源。
  private initialRequest!: PageRequest
  // 恢复游标：最近一次成功应用的末尾游标（断线重连时据此续读）。
  private resumeCursor: Cursor | undefined
  // 是否已有恢复游标（区分"从未开启"与"游标恰为空"）。
  private hasResumeCursor = false
  // 当前已应用的物理代号。
  private generation = 0
  // 已发布窗口的最旧（首）游标。
  private firstCursor: Cursor | undefined
  // 已发布窗口的最新（末）游标。
  private lastCursor: Cursor | undefined
  // open 是否已调用（只允许一次）。
  private started = false
  // 开场快照是否已成功发布。
  private opened = false
  // 是否已永久释放。
  private disposed = false
  // 后台消费循环的完成 Promise。
  private done: Promise<void> | undefined
  // dispose 的关闭 Promise（缓存保证幂等）。
  private closing: Promise<void> | undefined
  // 复用中的 iterator.next() Promise：页读取与跟随读取共用同一次挂起读取。
  private pendingNext: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> | undefined

  /**
   * @param remote - Gateway factory for the reconnecting physical-generation stream.
   * @param options - cursor algebra and domain publication sinks.
   */
  protected constructor(
    remote: RemoteStreamFactory,
    private readonly options: RemoteJournalStreamOptions<Page, Entry, Cursor, Notification>,
  ) {
    // 用网关工厂创建重连流：open 每代都调用子类 follow；正常结束若开场已被接受则视为可重试的承载丢失，否则是协议违规。
    this.stream = remote.$stream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>({
      // 诊断名。
      name: options.name,
      // 每个物理代的开流函数：以保留的初始请求调用领域 follow。
      open: signal => this.follow(this.initialRequest, signal),
      // 代的正常结束定性：已接受开场却无终态结果 => 可重试承载错误；从未到达开场游标 => 协议违规。
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${options.name} ended without a terminal result`)
        : protocolViolation(
          `${this.hasResumeCursor ? 'resumed ' : ''}${options.name} ended before its opening cursor`,
        ),
      // 领域可选的承载故障观察器：有则透传给底层流。
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
    })
  }

  /**
   * Open one physical journal generation with a complete current snapshot.
   * @param request - opening-window request retained for later repair.
   * @param signal - cancellation lifetime of the physical generation.
   * @returns opening cursor followed by live entries.
   */
  protected abstract follow(
    request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, Cursor, Page, Notification>>

  /**
   * Read one journal page through the addressed domain source.
   * @param request - domain page request.
   * @param through - inclusive journal cursor that fixes the source read.
   * @param signal - cancellation lifetime shared with the logical stream.
   * @returns the requested page, whose tail equals `through` unless the domain request selects older entries.
   */
  protected abstract readPage(request: PageRequest, through: Cursor, signal: AbortSignal): Promise<Page>

  /**
   * Derive an unbounded-tail request from the initial page request.
   * @param initial - request used to open the journal window.
   * @returns request suitable for reconnect and gap repair.
   */
  protected abstract repairRequest(initial: PageRequest): PageRequest

  /** Cancellation lifetime shared by follow and page calls. */
  get signal(): AbortSignal {
    // 与底层流共享的生命周期信号：follow 与分页请求一起取消。
    return this.stream.signal
  }

  /**
   * Establish follow and publish the opening snapshot carried by its first frame.
   * @param request - initial tail-page request.
   * @returns after the first complete window is published.
   */
  async open(request: PageRequest): Promise<void> {
    // 幂等保护：重复 open 报错。
    if (this.started) throw new Error(`${this.options.name} already opened`)
    // 标记已启动。
    this.started = true
    // 保存初始页请求，供重连与补洞派生。
    this.initialRequest = request
    // 取走唯一的消费者迭代器。
    const iterator = this.stream[Symbol.asyncIterator]()
    try {
      // 读取第一帧（必须是 opened）。
      const first = await this.takeNext(iterator)
      // 流在开场游标之前就结束：协议违规。
      if (first.done) throw protocolViolation(`${this.options.name} ended before its opening cursor`)
      // 用开场帧整体替换当前窗口（首次发布）。
      this.replaceGeneration(first.value, false)
      // 开场已成功发布。
      this.opened = true
      // 启动后台消费循环并记录其完成 Promise。
      this.done = this.consume(iterator)
    } catch (error) {
      // 开场失败：永久停止底层流后再抛出。
      await this.stream.dispose()
      throw error
    }
  }

  /**
   * Read and prepend one older page after a successful open.
   * @param request - domain page request bound to this stream's address.
   * @returns after the page is applied or rejected as discontinuous.
   */
  async prepend(request: PageRequest): Promise<void> {
    // 未成功开启或已释放：拒绝读取历史页。
    if (!this.opened || this.disposed) throw new Error(`${this.options.name} is not open`)
    // 经领域源读取一页：其尾部必须恰好到达当前首游标（除非该请求选的是更旧条目）。
    const page = await this.readPage(request, this.currentCursor(), this.stream.signal)
    // 读取后检查信号：中止则立即抛出。
    this.stream.signal.throwIfAborted()
    // 抽取页内有序条目。
    const entries = this.options.entries(page)
    // 校验页内条目游标连续。
    this.assertPage(entries)
    // 当前窗口首游标。
    const before = this.firstCursor
    // 只保留严格 older 于当前首游标的条目（避免与已发布窗口重叠）。
    const accepted = before === undefined
      ? [...entries]
      : entries.filter(entry => this.options.compare(this.options.first(entry), before) < 0)
    // 接受集合的最后一个条目。
    const tail = accepted.at(-1)
    // 尾条目的末游标必须紧邻当前首游标，否则历史页不连续。
    if (tail !== undefined && before !== undefined
      && !this.options.follows(this.options.last(tail), before)) {
      // 先发布一个空 prepend（页对象仍给领域，便于其展示），再抛协议违规。
      this.options.publish({ type: 'prepend', page, entries: [], hasMore: false })
      throw protocolViolation(`${this.options.name} history page is discontinuous`)
    }
    // 接受集合非空：更新窗口首游标。
    const first = accepted[0]
    if (first !== undefined) this.firstCursor = this.options.first(first)
    // 发布 prepend 变更（附是否还有更旧页）。
    this.options.publish({
      type: 'prepend',
      page,
      entries: accepted,
      hasMore: this.options.hasMore(page),
    })
  }

  /** Replace the active physical generation while retaining the published window. */
  restart(): void {
    // 委托底层流换代：保留已发布窗口，直到新代开场游标追上为止。
    this.stream.restart()
  }

  /**
   * Permanently stop follow, page requests, and the background consumer.
   * @returns when no stream work or publication callback can still run.
   */
  dispose(): Promise<void> {
    // 幂等：复用进行中的关闭 Promise。
    if (this.closing !== undefined) return this.closing
    // 标记释放：此后不再上报失败。
    this.disposed = true
    // 记下后台循环完成 Promise。
    const done = this.done
    // 关闭流程：先停底层流，再等后台循环静默。
    const closing = (async () => {
      await this.stream.dispose()
      await done
    })()
    this.closing = closing
    return closing
  }

  // 后台消费循环：逐帧应用条目/通知，检测换代并触发窗口替换。
  private async consume(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    try {
      while (true) {
        // 读取下一帧。
        const next = await this.takeNext(iterator)
        // 流结束：循环退出。
        if (next.done) return
        // 当前帧。
        const item = next.value
        // 换代：新代的第一帧必为 opened，用它替换窗口（续读模式）。
        if (item.generation !== this.generation) {
          this.replaceGeneration(item, true)
          continue
        }
        // 同代内再次出现 opened：协议违规。
        if (item.value.type === 'opened') {
          throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
        }
        // 无游标通知：不改游标，直接发布。
        if (item.value.type === 'notification') {
          this.publishNotification(item.value.notification)
          continue
        }
        // 常规条目：校验游标衔接，必要时补洞后发布。
        await this.acceptEntry(item.value.entry, item, iterator)
      }
    } catch (error) {
      // 非主动释放引发的错误：作为终态失败上报领域。
      if (!this.disposed) this.options.failed(error)
    }
  }

  // 换代处理：解析 opened 帧并从其开场页整体替换窗口。
  private replaceGeneration(
    initial: JournalStreamItem<Page, Entry, Cursor, Notification>,
    resumed: boolean,
  ): void {
    // 校验并接受 opened 帧。
    const opening = this.opening(initial, resumed)
    // 从开场页发布 replace（不发起第二次 Remote 调用）。
    this.replaceFromOpening(opening.page, opening.cursor)
  }

  // 校验 opened 帧：类型必须正确；续读时游标不得落后于已应用的末游标。
  private opening(
    item: RemoteStreamItem<RemoteJournalFrame<Entry, Cursor, Page, Notification>>,
    resumed: boolean,
  ): { readonly cursor: Cursor; readonly page: Page } {
    // 开场帧类型不符：协议违规。
    if (item.value.type !== 'opened') {
      throw protocolViolation(`${resumed ? 'resumed ' : ''}${this.options.name} emitted an entry before its opening cursor`)
    }
    // 开场游标。
    const cursor = item.value.cursor
    // 续读代的开场游标落后于已应用末游标：宿主回退，协议违规。
    if (resumed && this.lastCursor !== undefined
      && this.options.compare(cursor, this.lastCursor) < 0) {
      throw protocolViolation(
        `${this.options.name} resumed at a cursor behind the last applied entry`,
      )
    }
    // 记录当前物理代号。
    this.generation = item.generation
    // 向流确认本代开场基线已接受。
    item.accept()
    // 返回开场游标与页。
    return { cursor, page: item.value.page }
  }

  /** Publish a generation's opening page without issuing a second Remote call. */
  private replaceFromOpening(page: Page, cursor: Cursor): void {
    // 校验页尾恰好到达开场游标。
    this.assertPageThrough(page, cursor)
    // 复制页内条目，避免领域后续修改页对象影响已发布状态。
    const entries = [...this.options.entries(page)]
    // 校验条目游标连续。
    this.assertPage(entries)
    // 首条目决定窗口首游标（空页则为 undefined）。
    const first = entries[0]
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    // 末游标即开场游标。
    this.lastCursor = cursor
    // 记录恢复游标（重连续读基准）。
    this.setResumeCursor(cursor)
    // 以 replace 发布完整窗口（含是否还有更旧页）。
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
  }

  // 应用一条流式条目：过期则忽略；衔接则追加；出现缺口则发起补洞替换。
  private async acceptEntry(
    entry: Entry,
    item: JournalStreamItem<Page, Entry, Cursor, Notification>,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    // 条目的游标区间（含合法性校验）。
    const { first, last: cursor } = this.entryRange(entry)
    // 当前已应用末游标。
    const last = this.lastCursor as Cursor
    // 条目不比末游标更新：过期，忽略。
    if (this.options.compare(cursor, last) <= 0) return
    // 条目与已应用区间部分重叠：协议违规。
    if (this.options.compare(first, last) <= 0) {
      throw protocolViolation(`${this.options.name} emitted a partially overlapping entry`)
    }
    // 条目与末游标之间存在缺口：发起补洞读取（以该条目为占位，暂不发布）。
    if (!this.options.follows(last, first)) {
      // 派生补洞页请求。
      const request = this.repairPageRequest()
      // 读页补洞直到游标衔接；期间可能被换代打断。
      const superseded = await this.replaceThrough(
        request,
        cursor,
        item.generation,
        item.signal,
        iterator,
        [entry],
        [],
      )
      // 补洞期间换代：用新代的开场帧替换窗口。
      if (superseded !== undefined) {
        this.replaceGeneration(superseded, true)
      }
      return
    }
    // 窗口为空：补上首游标。
    if (this.firstCursor === undefined) this.firstCursor = first
    // 推进末游标。
    this.lastCursor = cursor
    // 更新恢复游标。
    this.setResumeCursor(cursor)
    // 发布 append 变更。
    this.options.publish({ type: 'append', entry })
  }

  // 补洞主流程：反复读页并合并排队条目，直到页尾到达目标游标后整体 replace。
  // 返回 undefined 表示补洞完成并已发布；返回帧表示期间发生换代，交由调用方处理新代。
  private async replaceThrough(
    request: PageRequest,
    requiredCursor: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<JournalStreamItem<Page, Entry, Cursor, Notification> | undefined> {
    // 第一轮：读取页面，同时继续跟随流缓存新条目/通知。
    let read = await this.readPageWhileFollowing(
      request,
      requiredCursor,
      generation,
      signal,
      iterator,
      queued,
      notifications,
    )
    // 读取期间换代：交给调用方处理新代。
    if (read.type === 'superseded') return read.item
    // 拿到的页。
    let page = read.page
    // 校验页尾到达必需游标。
    this.assertPageThrough(page, requiredCursor)
    // 合并页条目与排队条目；undefined 表示仍有缺口。
    let entries = this.mergeReplacement(page, queued)
    // 目标游标 = 必需游标与所有排队条目末游标的最大者。
    let target = this.maxCursor(requiredCursor, queued)
    // 仍有缺口或页尾未达目标：再读一页（从请求末尾继续向新方向）。
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      // 第二轮读取：目标推进到 target。
      read = await this.readPageWhileFollowing(
        this.repairPageRequest(),
        target,
        generation,
        signal,
        iterator,
        queued,
        notifications,
      )
      // 读取期间换代：交给调用方处理。
      if (read.type === 'superseded') return read.item
      page = read.page
      // 校验页尾到达新目标。
      this.assertPageThrough(page, target)
      // 再次合并排队条目。
      entries = this.mergeReplacement(page, queued)
      // 重新计算目标（排队集合可能又增加了）。
      target = this.maxCursor(requiredCursor, queued)
    }
    // 两轮后仍不达标：宿主分页未按要求覆盖缺口，协议违规。
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      throw protocolViolation(`${this.options.name} page did not reach its opening cursor`)
    }
    // 合并结果的首条目决定新窗口首游标。
    const first = entries[0]
    /* v8 ignore next -- a successful positive-cursor replacement page cannot be empty. */
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    // 末游标推进到合并结果尾部。
    this.lastCursor = this.tailCursor(entries)
    // 更新恢复游标。
    this.setResumeCursor(this.lastCursor)
    // 以 replace 原子发布补洞后的完整窗口。
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
    // 补洞期间积压的通知按序补发（通知不改变游标）。
    for (const notification of notifications) {
      this.publishNotification(notification)
    }
    // 补洞完成。
    return undefined
  }

  // 读页同时继续跟随流：页读取与流读取赛跑；换代即返回 superseded，通知/条目被缓存。
  private async readPageWhileFollowing(
    request: PageRequest,
    through: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<
    | { readonly type: 'page'; readonly page: Page }
    | { readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }
  > {
    // 启动页读取并把结果/错误都归一为值，便于 race。
    const page = this.readPage(request, through, signal).then(
      value => ({ type: 'page' as const, value }),
      (error: unknown) => ({ type: 'page-error' as const, error }),
    )
    while (true) {
      // 复用/发起一次流读取（页与流共享同一个挂起读取）。
      const pending = this.nextResult(iterator)
      // 把流读取的结果/错误也归一为值。
      const next = pending.then(
        value => ({ type: 'next' as const, value }),
        (error: unknown) => ({ type: 'next-error' as const, error }),
      )
      // 页与流帧赛跑。
      const result = await Promise.race([page, next])
      // 页先完成：确认信号未中止后返回页。
      if (result.type === 'page') {
        signal.throwIfAborted()
        return { type: 'page', page: result.value }
      }
      // 页读取失败：
      if (result.type === 'page-error') {
        // 信号未中止（真错误）或整流已停止：原样抛出。
        if (!signal.aborted || this.stream.signal.aborted) throw result.error
        // 页读取因换代取消：等待新代开场帧。
        return this.awaitReplacementGeneration(generation, iterator, pending)
      }
      // 流帧先到：释放共享读取槽，继续处理该帧。
      this.releaseNext()
      // 流自身抛错：原样上抛。
      if (result.type === 'next-error') throw result.error
      // 流在补洞期间结束：确认非中止后判为协议违规。
      if (result.value.done) {
        signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while reading its replacement page`)
      }
      // 取出帧内容。
      const item = result.value.value
      // 换代帧：向上返回，交由调用方替换窗口。
      if (item.generation !== generation) return { type: 'superseded', item }
      // 同代内再次 opened：协议违规。
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      // 通知帧：先缓存，待补洞完成后按序补发。
      if (item.value.type === 'notification') {
        notifications.push(item.value.notification)
        continue
      }
      // 条目帧：加入排队集合，稍后与页合并。
      queued.push(item.value.entry)
    }
  }

  // 等待换代后的新代开场帧：跳过旧代残留帧，直到出现新代帧。
  private async awaitReplacementGeneration(
    generation: number,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    initial: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>>,
  ): Promise<{ readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }> {
    // 从挂起中的读取开始。
    let pending = initial
    while (true) {
      // 等待当前读取完成；无论成败释放共享读取槽。
      let next: IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>
      try {
        next = await pending
      } finally {
        this.releaseNext()
      }
      // 流结束：确认非中止后判为协议违规。
      if (next.done) {
        this.stream.signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while replacing an aborted page generation`)
      }
      // 出现新代帧：返回给调用方处理。
      const item = next.value
      if (item.generation !== generation) return { type: 'superseded', item }
      // 同代内再次 opened：协议违规。
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      // 旧代残留帧：继续读下一帧。
      pending = this.nextResult(iterator)
    }
  }

  // 合并替换页与排队条目；返回 undefined 表示存在无法衔接的缺口（需要再读一页）。
  private mergeReplacement(page: Page, queued: readonly Entry[]): Entry[] | undefined {
    // 复制页内条目并校验连续性。
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    // 逐个校验排队条目的游标区间合法。
    for (const entry of queued) this.entryRange(entry)
    // 排队条目按首游标排序。
    const sorted = [...queued].sort((left, right) => (
      this.options.compare(this.options.first(left), this.options.first(right))
    ))
    // 当前合并结果的尾游标。
    let tail = this.tailCursor(entries)
    for (const entry of sorted) {
      // 条目游标区间。
      const first = this.options.first(entry)
      const last = this.options.last(entry)
      // 不比当前尾部更新：已被覆盖，跳过。
      if (this.options.compare(last, tail) <= 0) continue
      // 与已合并区间部分重叠：协议违规。
      if (this.options.compare(first, tail) <= 0) {
        throw protocolViolation(`${this.options.name} replacement contains a partially overlapping entry`)
      }
      // 与尾部存在缺口：告诉调用方还要再读页。
      if (!this.options.follows(tail, first)) return undefined
      // 衔接成功：并入结果并推进尾游标。
      entries.push(entry)
      tail = last
    }
    // 返回合并后的完整条目序列。
    return entries
  }

  // 求 required 游标与所有条目末游标中的最大者。
  private maxCursor(cursor: Cursor, entries: readonly Entry[]): Cursor {
    // 以 required 为初始最大值。
    let result = cursor
    for (const entry of entries) {
      // 逐个比较条目末游标。
      const candidate = this.options.last(entry)
      if (this.options.compare(candidate, result) > 0) result = candidate
    }
    // 返回最大游标。
    return result
  }

  // 复用/发起共享的流读取：保证任意时刻至多一个挂起的 iterator.next()。
  private nextResult(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    // 尚无挂起读取则发起，否则复用。
    this.pendingNext ??= iterator.next()
    return this.pendingNext
  }

  // 取走一次共享读取的结果；无论成败都释放读取槽。
  private async takeNext(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    // 复用/发起共享读取。
    const pending = this.nextResult(iterator)
    try {
      // 等待其完成。
      return await pending
    } finally {
      // 释放读取槽。
      this.releaseNext()
    }
  }

  // 释放共享读取槽。
  private releaseNext(): void {
    this.pendingNext = undefined
  }

  // 发布无游标通知（不改任何游标状态）。
  private publishNotification(notification: Notification): void {
    this.options.publish({
      type: 'notification',
      notification,
    } as RemoteJournalChange<Page, Entry, Notification>)
  }

  // 从初始请求派生一个"无上界尾部"的补洞/重连页请求。
  private repairPageRequest(): PageRequest {
    return this.repairRequest(this.initialRequest)
  }

  // 记录恢复游标（含"已有游标"标志）。
  private setResumeCursor(cursor: Cursor): void {
    this.resumeCursor = cursor
    this.hasResumeCursor = true
  }

  // 当前恢复游标（仅在开启后调用）。
  private currentCursor(): Cursor {
    return this.resumeCursor as Cursor
  }

  // 条目序列的尾游标；空序列退化为 emptyCursor。
  private tailCursor(entries: readonly Entry[]): Cursor {
    const tail = entries.at(-1)
    return tail === undefined ? this.options.emptyCursor : this.options.last(tail)
  }

  // 校验页内条目游标两两紧邻（连续）。
  private assertPage(entries: readonly Entry[]): void {
    // 手动迭代以便先取首条目。
    const iterator = entries[Symbol.iterator]()
    const first = iterator.next()
    // 空页无需校验。
    if (first.done) return
    // 首条目的游标区间。
    let previousRange = this.entryRange(first.value)
    for (const entry of iterator) {
      // 当前条目区间。
      const range = this.entryRange(entry)
      // 前一条目末游标必须紧邻当前条目首游标。
      if (!this.options.follows(previousRange.last, range.first)) {
        throw protocolViolation(`${this.options.name} page contains discontinuous entries`)
      }
      // 推进前驱区间。
      previousRange = range
    }
  }

  // 校验条目游标区间方向合法（first 不得晚于 last）并返回区间。
  private entryRange(entry: Entry): { readonly first: Cursor; readonly last: Cursor } {
    // 读取条目的首/末游标。
    const first = this.options.first(entry)
    const last = this.options.last(entry)
    // 区间倒置：协议违规。
    if (this.options.compare(first, last) > 0) {
      throw protocolViolation(`${this.options.name} entry has an inverted cursor range`)
    }
    return { first, last }
  }

  // 校验页尾恰好等于请求的目标游标（不多不少）。
  private assertPageThrough(page: Page, through: Cursor): void {
    // 页尾游标。
    const tail = this.tailCursor(this.options.entries(page))
    // 不相等即协议违规。
    if (this.options.compare(tail, through) !== 0) {
      throw protocolViolation(`${this.options.name} page did not end at its requested cursor`)
    }
  }
}
