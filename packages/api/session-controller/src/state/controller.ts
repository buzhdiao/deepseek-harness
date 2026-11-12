// 模块说明：StateController——Session 状态的被动读取与等待入口：一次性读取完整状态、
// 订阅合并（coalesced）失效通知的观测流，以及静默（quiescence）等待；等待动作
// （输入所需 / 继续 / 空闲）由纯函数从状态推导。
/** Passive Session state, coalesced observations and quiescence waits. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 导入 Agent 类型
import type { Agent } from '@deepseek-ai/dsh-agent'
// 侧向类型引用：dsh-api-gateway 提供的网关服务类型增强
import type {} from '@deepseek-ai/dsh-api-gateway'
// 导入用户消息类型
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// 导入 SessionId 类型
import type { SessionId } from '@deepseek-ai/dsh-session'
// 导入截止时间（deadline）、最大定时器延迟与超时原因提取工具
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
// 导入远程错误类型
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 导入 JsonValue 类型
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// 导入 HistoryController 类型（冷状态读取的底层入口）
import type { HistoryController } from '../history/controller.ts'
// 导入默认消息上限与 404 拒绝辅助
import { DEFAULT_MAX_MESSAGES, rejectNotFound } from '../history.ts'
// 导入待处理输入、队列项、状态与等待相关的对外类型
import type { SessionPendingInput, SessionQueuedItem, SessionState, SessionStateRequest, SessionWaitRequest, SessionWaitValue } from '../types.ts'

// 导入状态监听器与其带版本的状态类型
import { StateListener } from './listener.ts'
import type { VersionedSessionState } from './listener.ts'

// 默认的等待超时时间：30 秒
const DEFAULT_WAIT_TIMEOUT_MS = 30_000

/** 读取与等待都不会激活（activate）或取消 Session 的执行。 */
export class StateController {

  /**
   * @param ctx - 活动 Session 与待处理远程事件服务所在的宿主上下文。
   * @param historyController - 用于冷状态读取及其有界输出的被动读取入口。
   */
  constructor(private readonly ctx: Context, private readonly historyController: HistoryController) {}

  /**
   * 读取被动的执行与待输入（pending-input）状态。
   * @param request - Session 身份。
   * @param signal - 读取取消信号。
   * @returns 当前被动状态。
   */
  async state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState> {
    // 直接委托给内部的状态读取实现
    return this.readState(request.sessionId, signal)
  }

  /**
   * 观测完整被动状态的每次整体替换。
   * @param request - Session 身份。
   * @param signal - 观测取消信号。
   * @returns 完整状态替换流，第一条为当前状态。
   */
  async *observeState(request: SessionStateRequest, signal: AbortSignal): AsyncIterable<SessionState> {
    // 创建状态监听器（using：生成器退出时自动释放）
    using listener = this.listen(request.sessionId, signal)
    // 逐条产出带版本的状态中的状态部分
    for await (const { state } of listener.observeStates()) yield state
  }

  /**
   * 等待静默（quiescence）、待输入或截止时间，且不取消执行。
   * @param request - Session 身份、超时与助手输出窗口。
   * @param signal - 仅取消本次等待，绝不取消 Agent 执行。
   * @returns 停止原因与最后一份完整状态；超时前没有任何状态属于错误。
   */
  async wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue> {
    // 超时时间：未指定时用默认 30 秒
    const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    // 起始游标：未指定时用 -1（从头开始）
    const afterSeq = request.afterSeq ?? -1
    // 助手消息上限：未指定时用默认值
    const maxMessages = request.maxMessages ?? DEFAULT_MAX_MESSAGES
    // afterSeq 必须是 >= -1 的安全整数（-1 为哨兵值），且禁止 -0
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || Object.is(afterSeq, -0)) {
      throw new RemoteError('gateway/bad-request', 'afterSeq must be an integer greater than or equal to -1', {})
    }
    // maxMessages 必须是正整数
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
      throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
    }
    // timeoutMs 必须是平台定时器支持的正延迟
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new RemoteError('gateway/bad-request', 'timeoutMs must be a positive supported timer delay', {})
    }
    // 建立等待截止定时器（using：作用域结束自动清理）；timer.signal 在到期时中止
    using timer = deadline(signal, timeoutMs, 'session/wait-timeout')
    // 用截止信号创建状态监听器
    using listener = this.listen(request.sessionId, timer.signal)
    // 取出会话 id
    const sessionId = request.sessionId
    // 启动状态观测生成器；1_000 毫秒为空闲周期的复查间隔
    const statesGenerator = listener.observeStates(1_000)
    // 预取下一个状态（保持流水线常驻一次读取）
    let nextStatePromise = statesGenerator.next()
    // 目前确认的最新状态
    let currentState: SessionState | undefined
    // 停止原因：默认超时
    let reason: SessionWaitValue['reason'] = 'timeout'
    try {
      // 持续消费状态替换直到出现停止条件
      for (;;) {
        // 等待下一个观测状态
        const observedState = await nextStatePromise
        // 观测流提前结束（如会话被销毁）：若并非超时导致，则报观测结束错误
        if (observedState.done) {
          timer.signal.throwIfAborted()
          throw new RemoteError('session/observation-ended', 'Session observation ended before a stopping state', {})
        }
        // 预取再下一个状态
        nextStatePromise = statesGenerator.next()
        // Observe rejection on immediate exits without replacing the original demand.
        // 观察预取的拒绝错误（即时退出路径），但不替换原始请求的 promise
        void nextStatePromise.catch(() => undefined)
        // Only a state the listener still confirms may drive this wait; an invalidated
        // sample never becomes the state a timeout reports.
        // 只有监听器仍确认为最新的状态才能驱动等待；被失效的样本绝不作为超时报告的状态
        if (!listener.isCurrent(observedState.value.revision)) continue
        // 记录当前确认的状态
        currentState = observedState.value.state
        // 根据状态计算下一步等待动作
        const action = computeWaitAction(currentState)
        // 继续等待
        if (action === 'continue') continue
        // 需要输入或已空闲（冷会话）：立即以此原因结束等待
        if (action === 'input-required' || action === 'idle') {
          reason = action
          break
        }

        // check-idle 路径：活动会话显示已停步，需确认执行真正静默
        const agent = this.ctx.agents.get(sessionId)
        // Agent 已消失或会话绑定已变化：状态样本过期，继续等待
        if (agent === undefined || this.ctx.sessions.get(sessionId) !== agent.session) continue
        // 竞速：Agent 空闲回调 vs 下一个状态到来
        if (await waitForIdleOrStateChange(agent, nextStatePromise) === 'state-changed') continue
        // 空闲回调胜出后做最终一致性校验：状态版本、Agent 与会话绑定都未被替换
        if (!listener.isCurrent(observedState.value.revision) || this.ctx.agents.get(sessionId) !== agent
          || this.ctx.sessions.get(sessionId) !== agent.session) continue
        // 确认静默：以 idle 结束等待
        reason = 'idle'
        break
      }
    } catch (error: unknown) {
      // A caller cancellation is never a wait outcome; the deadline absorbs only the read
      // it cancelled, and any other failure keeps its own error.
      // 调用方取消永远不会是等待结果；截止时间只吞掉它取消的那次读取，其余失败保留原始错误
      if (signal.aborted) throw signal.reason
      if (!expired(timer.signal, error)) throw error
    } finally {
      // Wake/cancel a pending read before asking the generator to return.
      // 在让生成器返回之前，先唤醒/取消一次挂起中的读取
      listener[Symbol.dispose]()
      // 吞掉预取可能的拒绝
      await nextStatePromise.catch(() => undefined)
      // 显式结束状态生成器
      await statesGenerator.return(undefined)
    }
    // 到达这里意味着等待正常结束；若调用方信号已中止则抛出
    signal.throwIfAborted()
    // 期间没有收到任何状态：报等待超时错误
    if (currentState === undefined) throw new RemoteError('session/wait-timeout', 'No Session state arrived before the wait deadline', {})
    // 读取停止游标之前的助手输出（受消息上限约束，用调用方信号而非截止信号）
    const output = await this.historyController.assistantOutput(
      sessionId, afterSeq, currentState.cursor, maxMessages, signal,
    )
    // 返回停止原因、最终状态与助手输出
    return { reason, state: currentState, output }
  }

  // 创建状态监听器：注入被动状态读取实现
  private listen(sessionId: SessionId, signal: AbortSignal): StateListener {
    return new StateListener(this.ctx, sessionId, signal, readSignal => this.readState(sessionId, readSignal))
  }

  /**
   * @param sessionId - 要采样的 Session。
   * @param signal - 读取取消信号。
   * @param retried - 活动（live）来源是否已经重定向过本次读取。
   * @returns 一个被动状态样本。
   */
  private async readState(sessionId: SessionId, signal: AbortSignal, retried = false): Promise<SessionState> {
    // 读取前检查取消
    signal.throwIfAborted()
    // 优先查看该会话是否有活动 Agent
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) {
      // 活动会话没有 cwd：视为不存在（未完成初始化）
      if (agent.session.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
      // 用活动 Agent 的实时信息组装状态
      return {
        // 游标 = 已提交的最后一个序列号
        cursor: agent.session.seq - 1,
        // 会话处于活动状态
        active: true,
        // Agent 是否正在运行
        running: agent.status === 'running',
        // 收集排队中的消息
        queue: queueItems(agent),
        // 收集待处理的输入类型
        pendingInput: this.pendingInput(agent.session.id),
      }
    }
    // 冷会话：借出一次不带投影的观测并采样
    const state = await this.historyController.usingObservation({ sessionId, projection: false }, signal, (observation) => {
      // A live source means the Session attached during this read; report its live state
      // rather than a live cursor paired with an inactive sample.
      // live 来源意味着 Session 在本次读取期间刚被挂载；此时返回 undefined 触发重试，
      // 而不是给出"活动游标 + 非活动样本"的矛盾组合
      if (!retried && observation.source === 'live') return undefined
      // 冷会话没有 cwd：视为不存在
      if (observation.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
      // 用观测信息组装非活动状态
      return {
        cursor: observation.cursor,
        // 冷会话不活动也不运行
        active: false,
        running: false,
        // 冷会话没有队列
        queue: null,
        // 待处理输入按观测头部的会话 id 查询
        pendingInput: this.pendingInput(observation.header.id),
      }
    })
    // 读取后再检查取消
    signal.throwIfAborted()
    // 读取结果为 undefined（live 来源）：用 retried 标记重试一次
    return state ?? this.readState(sessionId, signal, true)
  }

  // 收集某会话当前待处理的输入种类（approval/question/other，去重）
  private pendingInput(sessionId: SessionId): readonly SessionPendingInput[] {
    // 待处理种类集合
    const kinds = new Set<SessionPendingInput>()
    // 遍历网关上所有待处理的远程事件
    for (const { event, agentId } of this.ctx.typertGateway.getPendingRemoteEvents()) {
      // 只关心属于目标会话的事件
      if (String(agentId) !== sessionId) continue
      // 把远程事件名归类为待输入种类
      kinds.add(event === 'approval/request' ? 'approval' : event === 'user-questions/request' ? 'question' : 'other')
    }
    // 返回去重后的种类列表
    return [...kinds]
  }
}

/**
 * 判断截止信号是否真的到期并取消了那次读取。
 * @param signal - 等待截止信号。
 * @param error - 进行中读取抛出的失败。
 * @returns 截止时间是否已到并取消了该读取。
 */
function expired(signal: AbortSignal, error: unknown): boolean {
  // 从信号中提取截止原因；没有则说明截止时间未到
  const reason = timeoutOf(signal, 'session/wait-timeout')
  if (reason === undefined) return false
  // Cancellation carries the deadline reason along its cause chain; any other failure does not.
  // 取消会把截止原因带在原因链（cause chain）上；其他失败则不会
  let current: unknown = error
  // 沿原因链最多向下找 4 层
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    // 错误本身或其直接 cause 等于截止原因：确认是到期取消
    if (current === reason || current.cause === reason) return true
    // 继续向下追原因链
    current = current.cause
  }
  // 兜底：错误本身直接等于截止原因
  return error === reason
}

/** 选择下一步等待动作；check-idle 需要调用方的 whenIdle 与身份校验。 */
function computeWaitAction(state: SessionState): 'input-required' | 'continue' | 'idle' | 'check-idle' {
  // 有待处理输入：立即结束，等待用户输入
  if (state.pendingInput.length > 0) return 'input-required'
  // 仍在运行：继续等
  if (state.running) return 'continue'
  // 会话不活动（冷会话）：视为空闲
  if (!state.active) return 'idle'
  // 活动但已停步：需要进一步确认是否真正静默
  return 'check-idle'
}

/** 同时等待驱动静默或已就绪的下一个状态；保留两者的拒绝错误。 */
function waitForIdleOrStateChange(
  agent: Agent,
  nextStatePromise: Promise<IteratorResult<VersionedSessionState>>,
): Promise<'idle' | 'state-changed'> {
  // 用 Promise.race 竞速：Agent 空闲 vs 状态变化，胜者决定结果
  return Promise.race([
    agent.whenIdle().then(() => 'idle' as const),
    nextStatePromise.then(() => 'state-changed' as const),
  ])
}

// 把 Agent 收件箱中的消息转换为对外的排队项
function queueItems(agent: Agent): SessionQueuedItem[] {
  // 单条消息的转换：提取 id、放置位置、可选 rpcId 与内容
  const item = (message: UserMessage, placement: SessionQueuedItem['placement']): SessionQueuedItem => ({
    id: message.id,
    placement,
    // 仅用户来源且带 rpcId 的消息输出 rpcId（条件展开避免 undefined 字段）
    ...message.source.kind === 'user' && 'rpcId' in message.source ? { rpcId: message.source.rpcId } : {},
    // 内容断言为 JSON 值数组后透传
    content: message.content as typeof message.content & readonly JsonValue[],
  })
  // nextTurn 中的消息是普通排队（queued）；nextStep 中按来源分为 steering（用户）或 context
  return [
    ...agent.inbox.nextTurn.map(message => item(message, 'queued')),
    ...agent.inbox.nextStep.map(message => item(message, message.source.kind === 'user' ? 'steering' : 'context')),
  ]
}
