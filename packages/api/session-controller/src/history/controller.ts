// 模块说明：HistoryController——Session 快照与被动（passive）读取入口：不激活会话，
// 按精确切点（cut）分页读取事件与投影，或建立事件/投影/助手输出的被动订阅流；
// 另提供观测借出、地址校验、历史分页与请求校验等共享辅助函数。
/** Independent Session snapshots and passive event subscriptions. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 导入 Session 日志偏移、序列号工具与追加表面事件判断
import { SessionLogOffset, SessionSeq, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
// 导入 SessionId、SessionEvent 类型
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
// 导入 Session 观测（observation）类型
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
// 导入远程错误类型与从任意错误中提取远程错误的工具
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// 导入历史分页与校验的辅助函数
import {
  DEFAULT_MAX_MESSAGES, paginate, pageRecords, entryFor, addressId,
  validateHistoryWindow, validateAddress, rejectNotFound,
} from '../history.ts'
// 导入被动事件监听器与投影监听器
import { EventListener, ProjectionListener } from './listener.ts'
// 导入助手输出流监听器
import { SessionAssistantStreamsListener } from './assistant-stream.ts'
// 导入本包对外的事件帧、分页、地址、投影等类型
import type {
  SessionEventFrame, SessionEventsPage, SessionPageRequest,
  SessionObserveEventRequest, SessionProjectionsRequest, SessionProjectionFrame,
  SessionAddress, SessionProjectionBaseline, SessionProjectionValues, SessionProjectionsValue, SessionWaitOutput, SessionHistoryRecord,
} from '../types.ts'


/** Session 快照与被动订阅不共享生命周期：快照借出后由调用方负责释放。 */
export class HistoryController {

  /** 本控制器的助手（assistant）订阅的重连状态。 */
  readonly streamsListener: SessionAssistantStreamsListener

  /** @param ctx - 携带 Session 读取与投影能力的宿主上下文。 */
  constructor(private readonly ctx: Context) {
    // 构造助手输出流监听器，用于断线重连后的续读
    this.streamsListener = new SessionAssistantStreamsListener(this.ctx)
  }

  /**
   * 在一个精确切点（cut）读取一页被动（不激活 Session）的 Session 事件。
   * @param request - Session 身份以及可选的切点与分页窗口。
   * @param signal - 读取取消信号。
   * @returns 所给切点上的一页数据；未提供切点时返回观测日志的末尾。
   */
  async events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage> {
    // 先校验并解析请求（补齐 maxMessages 预算）
    const spec = resolveHistoryRequest(request)
    try {
      // 借出一次观测（不保留租约），回调结束后自动释放；subagent 地址需要投影
      return await this.usingObservation({ sessionId: addressId(request.address), projection: request.address.kind === 'subagent' }, signal, (observation) => {
        // 校验地址与观测头一致（防止读到与地址不符的会话）
        validateObservationAddress(request.address, observation)
        // 把观测转换为按请求窗口的一页历史
        return history(observation, spec)
      })
    } catch (error: unknown) {
      // 若错误是"会话不存在"，抛出针对该地址的更精确的 404 错误
      if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
      // 其余错误原样向上抛出
      throw error
    }
  }

  /**
   * 订阅 Session 事件：不读取历史、不激活 Session。
   * @param request - 要订阅的 Session 地址。
   * @param signal - 流取消信号。
   * @returns 先产出订阅就绪帧，之后是事件帧；就绪不代表会话已存在。
   */
  async *observeEvent(request: SessionObserveEventRequest, signal: AbortSignal): AsyncIterable<SessionEventFrame> {
    // 创建事件监听器（using：生成器退出时自动释放订阅）
    using listener = new EventListener(this.ctx, addressId(request.address), signal)
    // 先发出就绪帧，告诉客户端订阅已建立（不代表会话存在）
    yield { type: 'ready' }
    // 把监听器缓冲中的事件帧逐个转发给调用方
    yield* listener.events()
  }

  /**
   * 精确读取投影（projections）或迁移缓存提示，且不激活 Session。
   * @param request - 需要其精确投影基线（baseline）的 Session 身份。
   * @param signal - 读取取消信号。
   * @returns 精确的按序列号对齐的值、迁移缓存提示；会话不存在时返回 null。
   */
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    // 取出请求中的 sessionId
    const { sessionId } = request
    // 空 sessionId 属于非法请求
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    // 以下读取与转换中的错误统一在此归一化为对外语义（null / 取消 / 内部错误）
    try {
      // 先检查取消信号，避免已取消的请求继续执行
      signal.throwIfAborted()
      // 若该 Session 当前是活动（live）的，直接从活动投影服务取快照
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) {
        // 活动会话：取当前投影快照（asOfSeq 为截至的序列号）
        const snapshot = this.ctx.sessionProjections.snapshot(live)
        return { kind: 'sequenced', asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
      } else {
        // 冷会话：从持久化服务查询其存储状态（服务可能未挂载）
        const stored = await this.ctx.get('sessionPersistence')?.stat(sessionId, { signal })
        // 查询后再次检查取消
        signal.throwIfAborted()
        // 存储标记为"需要迁移"：返回投影迁移缓存中的旧值作为提示
        if (stored?.formatStatus === 'migration-required') {
          const cached = this.ctx.get('sessionProjectionCache')?.cachedSnapshot(stored.header)
          return { kind: 'migration-required', values: { ...cached?.values } as SessionProjectionValues }
        }
        // 正常冷会话：借出一次带投影的观测并转换为精确基线
        return await this.usingObservation({ sessionId: request.sessionId, projection: true }, signal, observation => ({
          kind: 'sequenced' as const,
          ...projections(observation),
        }))
      }
    } catch (error: unknown) {
      // 尝试从错误对象中提取 code 字段（用于分类处理）
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      // 会话不存在：按约定返回 null（而不是报错），表示无投影数据
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') {
        return null
      }
      // 读取被取消：映射为网关取消错误并保留原始原因
      if (signal.aborted || code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      // 已是远程错误的原样抛出，避免重复包装
      if (remoteErrorOf(error) !== undefined) throw error
      // 其余失败统一包装为网关内部错误
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * 订阅投影变化：不读取基线（baseline）。
   * @param request - 要订阅（不读基线）的 Session 身份。
   * @param signal - 流取消信号。
   * @returns 先产出就绪帧，之后每个提交的事件产生一个变化帧，列出它改变的所有键。
   */
  async *observeProjections(request: SessionProjectionsRequest, signal: AbortSignal): AsyncIterable<SessionProjectionFrame> {
    // 创建投影监听器（using：生成器退出时自动释放）
    using listener = new ProjectionListener(this.ctx, request.sessionId, signal)
    // 先发出就绪帧
    yield { type: 'ready' }
    // 逐个转发投影变化帧
    yield* listener.changes()
  }

  /**
   * 通过一个停止游标（cursor）读取有上限的、已提交的助手消息。
   * @param sessionId - 请求其已提交助手消息的 Session。
   * @param afterSeq - 排他下界（不包含）。
   * @param throughSeq - 包含在内的停止状态游标。
   * @param maxMessages - 正数的助手记录上限。
   * @param signal - 调用方取消信号，独立于已完成的等待截止时间。
   * @returns 按最新优先排列的助手消息，以及是否省略了更多匹配记录。
   */
  async assistantOutput(
    sessionId: SessionId, afterSeq: number, throughSeq: number, maxMessages: number, signal: AbortSignal,
  ): Promise<SessionWaitOutput> {
    // 借出一次不带投影的观测，回调结束自动释放
    return this.usingObservation({ sessionId, projection: false }, signal, (observation) => {
      // 停止游标超出观测覆盖范围：说明历史已被截断，等待游标失效
      if (throughSeq > observation.cursor) {
        throw new RemoteError('gateway/internal', 'Session history no longer covers the wait cursor', {})
      }
      // 收集到的助手消息记录（最新优先）
      const records: SessionHistoryRecord[] = []
      // 观测内的事件索引表
      const events = observation.events
      // 从停止游标向 afterSeq 倒序扫描（最新优先）
      for (let index = throughSeq; index > afterSeq; index--) {
        // 取出该序列号上的事件
        const event = events[index] as SessionEvent
        // 只保留"助手消息"类型且属于追加表面（append surface）的事件
        if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
        // 达到数量上限：标记被截断并立即返回
        if (records.length === maxMessages) return { records, truncated: true }
        // 转换为历史记录条目并加入结果
        records.push(entryFor(event))
      }
      // 扫描完成且未触及上限：完整返回
      return { records, truncated: false }
    })
  }

  /**
   * 获取一次读取（不激活 Session）；投影为可选。
   * @param request - Session 身份与是否计算投影。
   * @param signal - 读取取消信号。
   * @param callback - 省略时把租约（lease）所有权转移给调用方。
   * @returns 一个由调用方负责释放的租约。
   */
  usingObservation(
    request: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal, callback?: undefined,
  ): Promise<SessionObservation>
  /**
   * 借出的租约在回调结束后保持存活，随后释放。
   * @param request - Session 身份与是否计算投影。
   * @param signal - 读取取消信号。
   * @param callback - 同步或异步计算；若结果需要逃逸（在回调外继续使用），请另行保留租约。
   * @returns 回调的结果；读取与回调的失败都会向上传播。
   */
  usingObservation<T>(
    request: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal,
    callback: (observation: SessionObservation) => T,
  ): Promise<Awaited<T>>
  // 实现签名：同时支持"转移租约"与"回调内使用"两种调用形态
  async usingObservation<T>(
    { sessionId, projection }: { readonly sessionId: SessionId; readonly projection: boolean }, signal: AbortSignal,
    callback?: (observation: SessionObservation) => T,
  ): Promise<SessionObservation | Awaited<T>> {
    // 观测对象
    let observation: SessionObservation
    try {
      // 通过 Session 查询服务借出观测；projection 决定是否计算全部投影
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: projection ? 'all' : 'none' })
    } catch (error: unknown) {
      // 提取错误的 code 字段做分类
      const code = (error as { readonly code?: unknown } | null | undefined)?.code
      // 会话不存在：映射为远程错误并附带 sessionId
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      // 查询被取消：映射为网关取消错误
      if (code === 'SESSION_QUERY_ABORTED') {
        // Keep the query's own message: cancellation detail was visible before this mapping.
        // 映射为网关取消错误；保留查询服务自身的消息（取消细节在映射前已可见）
        throw new RemoteError('gateway/cancelled',
          error instanceof Error ? error.message : 'Session read was cancelled', {}, { cause: error })
      }
      // 其他错误原样抛出
      throw error
    }
    try {
      // 借出成功后检查取消：避免把已取消的观测交给调用方
      signal.throwIfAborted()
    } catch (error: unknown) {
      // 已取消：立即释放观测再向上抛出取消错误
      observation[Symbol.dispose]()
      throw error
    }
    // 未提供回调：把观测（租约）所有权转移给调用方
    if (callback === undefined) return observation
    // 有回调：用 using 持有观测，回调结束后（无论成败）自动释放
    using ownedObservation = observation
    // 执行回调并返回其结果
    return await callback(ownedObservation)
  }
}

/**
 * 针对控制器实际使用的读取，校验一个地址（Address）。
 * @param address - 调用方提供的 Session 地址。
 * @param observation - 借出的读取；subagent 地址要求有投影。
 */
export function validateObservationAddress(address: SessionAddress, observation: SessionObservation): void {
  // 观测头没有 cwd：说明会话不存在或不可读，按地址抛出 404
  if (observation.header.cwd === undefined) rejectNotFound(address)
  // 用观测的头部、继承事件数与投影校验地址（kind、cwd、父会话等一致性）
  validateAddress(address, observation.header, observation.inheritedEventCount, observation.projections)
}

/**
 * 把一次借出的观测转换为单页历史，不获取也不保留观测本身。
 * @param observation - 调用方拥有的精确读取切点。
 * @param request - 已校验的分页窗口与可选的包含式切点。
 * @returns 请求切点上的按时间顺序的一页。
 */
export function history(observation: SessionObservation, request: Omit<SessionPageRequest, 'address'> & { readonly maxMessages: number }): SessionEventsPage {
  // 计算游标：未指定时取观测末尾；-1 表示"开天辟地"之前的哨兵；否则规范为 SessionSeq
  const cursor = request.throughSeq === undefined ? observation.cursor
    : request.throughSeq === -1 ? -1 : SessionSeq(request.throughSeq)
  // 请求的切点超出观测覆盖范围：拒绝请求
  if (cursor > observation.cursor) {
    throw new RemoteError('gateway/bad-request', `session history cut ${String(cursor)} exceeds ${String(observation.cursor)}`, {})
  }
  // 按窗口参数执行分页：beforeSeq（排他上界）、消息预算、游标与轮次窗口
  const page = paginate(
    observation.events,
    request.beforeSeq === undefined ? undefined : SessionLogOffset(request.beforeSeq),
    request.maxMessages,
    cursor,
    request.turnWindow,
  )
  // 返回游标、记录页与"是否还有更多"标志
  return { cursor, records: pageRecords(page.events), hasMore: page.hasMore }
}

/**
 * 转换投影基线，不获取也不保留其观测。
 * @param observation - 调用方拥有的带投影读取切点。
 * @returns 精确的基线；缺少投影支持时显式失败。
 */
export function projections(observation: SessionObservation): SessionProjectionBaseline {
  // 取出观测携带的投影快照
  const snapshot = observation.projections
  // 快照缺失说明该读取没有投影支持：显式报错而非静默返回空值
  if (snapshot === undefined) throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
  // 返回截至序列号与投影值
  return { asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
}

/**
 * 校验并解析历史分页窗口。
 * @param request - 外部传入的历史窗口。
 * @returns 附带显式消息预算的已校验请求。
 */
export function resolveHistoryRequest(request: SessionPageRequest): SessionPageRequest & { readonly maxMessages: number } {
  // throughSeq 必须是 >= -1 的安全整数（-1 为哨兵值），且禁止 -0
  if (request.throughSeq !== undefined
    && (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1 || Object.is(request.throughSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  // beforeSeq 必须是非负安全整数，且禁止 -0
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  // 校验窗口组合本身（如 beforeSeq 与 throughSeq 的关系）
  validateHistoryWindow(request)
  // 返回带显式消息预算的请求（未指定时使用默认值）
  return { ...request, maxMessages: request.maxMessages ?? DEFAULT_MAX_MESSAGES }
}
