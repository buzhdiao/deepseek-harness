// 面向 Session 的适配层：管理 Gateway（网关）持有的 Remote 流生命周期。
/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

// 副作用导入：拉取 remote 命名空间的类型环境。
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
// RemoteError（远程错误）：协议层错误类型。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Gateway 客户端流原语：日志流、快照流、载体错误及生成的 Remote 客户端类型。
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
// 本包类型：会话地址、助手流基线/帧、控制帧、历史记录、分页请求/结果、投影基线。
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
} from '../types.ts'
// 历史记录工具：从记录序列取首/尾序号及事件条目列表。
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from './sessions/history-records.ts'
// 事件条目类型：类事件条目与存活（live）事件条目。
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts'
// SessionRemotes：生成的远程命名空间集合。
import type { SessionRemotes } from './sessions/remotes.ts'
// 线上事件本地校验函数。
import { assertSessionWireEvent } from './session-wire-event.ts'

// 重新导出搜索结果上限常量，方便客户端侧统一取用。
export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

// 已定位到某个 Session 日志的分页请求字段（去掉地址与截至序号）。
/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>

// 生成的 `ctx.remote.session` 命名空间完整类型。
/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

// 仅由 follow（跟随）快照携带、绝不会出现在 loadOlder（加载更早）分页里的开场元数据。
/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
  // 可选的投影基线。
  readonly projections?: SessionProjectionBaseline
  // 可选的助手流基线。
  readonly assistantStream?: SessionAssistantStreamBaseline
}

// Session 日志流的一次完整发布（publication）。
/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
    // replace（整窗替换）或 prepend（前插一页）。
    readonly type: 'replace' | 'prepend'
    // 该页的元数据。
    readonly page: SessionJournalPage
    // 页内事件条目。
    readonly entries: readonly SessionEventLikeEntry[]
    // 是否仍有更早历史。
    readonly hasMore: boolean
  }
  // append（追加）：一条存活事件。
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  // assistant-stream：一帧助手流通知。
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

// 把 Gateway 的通用日志变更转换成 Session 领域的变更类型。
function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  // 按变更类型分派。
  switch (change.type) {
    // 整窗替换与前插：把记录转换成事件条目后透传。
    case 'replace':
    case 'prepend':
      return { ...change, entries: historyEntries(change.entries) }
    // 追加：把存活事件断言为 Session 存活事件条目。
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    // 通知（notification）：即助手流帧。
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

// 控制帧的基线成员类型。
type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
// 控制帧的增量成员类型（排除基线之外的全部）。
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

// Gateway 持有的控制快照流：按 Session 控制帧类型参数化。
/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

// 宿主级 Session 控制流使用的领域汇聚点（sink）。
/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  // 应用一份完整基线或一次后续更新。
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  // 在重连前观察一次可重试的载体（carrier）丢失。
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  // 发布终结性的业务或协议失败。
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

// 单个已定位 Session 事件日志使用的领域汇聚点。
/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  // 应用一次完整的事件窗口变更。
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  // 在重连前观察一次可重试的载体丢失。
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  // 打开后发布终结性的流、分页或协议失败。
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
// 创建宿主级 Session 控制快照流（未启动，归客户端 Session 运行时所有）。
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  // 先在生成的 remote 上打开底层流：定义打开方式与结束语义。
  const stream = remote.$stream<SessionControlFrame>({
    // 流名称：用于诊断。
    name: 'session control stream',
    // 打开：调用生成的 control 方法。
    open: signal => remote.session.control(signal),
    // 结束判定：正常结束却无终结结果视为载体错误；开场基线都没收到则视为普通错误。
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    // 仅在调用方提供载体失败回调时才透传该字段。
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  // 再包一层快照流：按 baseline 类型识别快照帧并分发给领域汇聚点。
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    // 快照识别：type 为 baseline 的帧。
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    // 基线与更新都交给同一个 accept 汇聚点。
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

// Gateway 持有的事件日志流：绑定到普通或直连子代理（direct-subagent）会话地址。
/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
  ) {
    // 配置基类：分页游标、序号比较、跟随语义与领域汇聚点。
    super(remote, {
      name: 'session event stream',
      // 空游标：-1 表示窗口为空。
      emptyCursor: -1,
      // 从页面元数据取出记录序列。
      entries: page => page.records,
      // 从页面元数据取出"是否还有更早历史"。
      hasMore: page => page.hasMore,
      // 取记录序列的首序号。
      first: historyRecordFirstSeq,
      // 取记录序列的尾序号。
      last: historyRecordLastSeq,
      // 序号比较：数值直接相减。
      compare: (left, right) => left - right,
      // 连续性判定：右序号恰为左序号加一。
      follows: (left, right) => right === left + 1,
      // 变更发布：先转换成 Session 领域类型再交给汇聚点。
      publish: (change) => { options.publish(toSessionJournalChange(change)) },
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    })
  }

  // 跟随（follow）流：把生成的 follow 迭代器桥接成基类的帧序列，并校验助手流修订号。
  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    // 已见的助手流修订号：用于检测跳号。
    let assistantRevision: number | undefined
    // 迭代生成的 follow 流（activate=true 激活会话并显式订阅助手流）。
    for await (const frame of this.remote.session.follow({
      address: this.address,
      activate: true,
      assistantStream: true,
      ...this.repairRequest(request),
    }, signal)) {
      // 快照帧：开场基线。
      if (frame.type === 'snapshot') {
        // 逐条校验快照内事件是合法线上事件。
        for (const record of frame.records) assertSessionWireEvent(record.event)
        if (frame.assistantStream === undefined) {
          // 显式订阅了助手流却不带开场基线：协议违规。
          throw new RemoteError(
            'gateway/internal',
            'session assistant stream omitted its opted-in opening baseline',
            {},
          )
        }
        // 记录开场修订号。
        assistantRevision = frame.assistantStream.revision
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: {
            records: frame.records,
            hasMore: frame.hasMore,
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        }
        continue
      }
      // 助手流通知帧：校验修订号连续性。
      if (frame.type === 'assistant-stream') {
        // 期待的修订号：上次已见加一（尚无基线时从 0 起算）。
        const expected = (assistantRevision ?? 0) + 1
        if (frame.frame.revision !== expected) {
          // 修订号跳号：视为载体错误，交由重连修复。
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          )
        }
        // 记录新修订号并产出通知。
        assistantRevision = frame.frame.revision
        yield { type: 'notification', notification: frame.frame }
        continue
      }
      // 普通事件帧：校验后作为日志条目产出。
      assertSessionWireEvent(frame.event)
      yield { type: 'entry', entry: frame }
    }
  }

  // 读取一页历史：调用生成的 page 方法并校验每条记录。
  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    // 发起分页 RPC。
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    )
    // 失败则直接抛出远程错误。
    if (!result.ok) throw result.error
    // 逐条校验页面内事件。
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    // 返回校验后的页面。
    return result.value
  }

  // 修复分页请求：只保留已定义的字段，避免把 undefined 传上线上协议。
  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    }
  }
}
