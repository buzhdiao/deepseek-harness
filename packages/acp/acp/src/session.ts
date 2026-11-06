/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */
// 单个标准 ACP 会话的 Agent、配置、提示、更新与拆除（teardown）生命周期。

import type { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context 类型。
import {
  RequestError,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
// 导入 ACP SDK：请求错误类型与各协议类型。
import type { Agent, AgentHandle, AgentOptions, AgentStatus } from '@deepseek-ai/dsh-agent'
// 导入 Agent 相关类型：代理、句柄、选项与状态。
import { installModelSelection } from '@deepseek-ai/dsh-agent'
// 导入模型选择安装器：为 Agent 作用域安装模型配置能力。
import { createUserMessage, errorChain, type UserMessage } from '@deepseek-ai/dsh-llm'
// 导入用户消息工厂、错误链工具与用户消息类型。
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
// 导入会话相关类型：会话、会话事件、会话 id 与回合结束原因。
// 导入同包内容模块：提示准入。
import { AcpContentError, admitAcpPrompt } from './content.ts'
// 导入停止原因映射。
import { turnEndToStopReason } from './codec.ts'
// 导入 MCP 挂载器。
import { mountAcpMcpServers } from './mcp.ts'
// 导入模型控制。
import { AcpModelControl } from './model-control.ts'
// 导入更新投影工具：助手输出、工具调用与工具结果。
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/** Subagent completion and teardown without depending on the subagent package. */
// 子代理（subagent）完成与拆除的最小接口，不依赖 subagent 包本身。
interface SubagentLifecycle {
  /** Dispose subagent descendants below exact host-owned parents child-first. */
  // 以“子代优先”顺序释放位于精确宿主父代之下的子代理后代。
  drainDescendants(parents: readonly Agent[]): Promise<void>
  /** Join progressing work in the root's subagent tree without closing future admission. */
  // 等待根代理子代理树中仍在推进的工作，但不关闭未来的准入。
  waitForTreeWork(root: Agent): Promise<boolean>
}

/** Inputs shared by fresh and resumed ACP session construction. */
// 新建与恢复 ACP 会话构建共用的输入。
interface AcpSessionBuildOptions {
  // 会话工作目录。
  cwd: string
  // 请求挂载的 MCP 服务器声明。
  mcpServers: readonly McpServer[]
  // 部署方提供的 agent 选项。
  agentOptions: AgentOptions
  // 构建取消信号。
  signal: AbortSignal
  // 有序协议更新发送器。
  notify: (notification: SessionNotification) => Promise<void>
}

/** Fresh ACP session construction inputs. */
// 新建 ACP 会话的构建输入（额外带新会话 id）。
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
// 恢复持久化 ACP 会话的构建输入（额外带既有会话 id）。
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

// 一个在途（inflight）提示的全部状态。
interface InflightPrompt {
  // 以终止原因结算提示 Promise。
  resolve: (reason: StopReason) => void
  // 以错误拒绝提示 Promise。
  reject: (error: Error) => void
  // 已入队用户消息的 id（用于与回合关联）。
  messageId: string | undefined
  // 消息是否已成功入队到 Agent。
  messageQueued: boolean
  // 关联的 Agent 回合号。
  turn: number | undefined
  // 回合结束原因（turn/end 后填充）。
  endReason: TurnEndReason | undefined
  // 准入（admission）完成的 Promise。
  admissionDone: Promise<void>
  // 结束准入的句柄。
  finishAdmission: () => void
  // 准入阶段的取消控制器。
  admissionController: AbortController
  // 取消流程完成（连同输出队列排空）的结算器。
  cancellationDone: PromiseWithResolvers<void>
  // 取消开始时 Agent 是否处于空闲（空闲则无需等待运行结束）。
  cancelStartedIdle: boolean
  // 结算流程是否已启动（保证只启动一次）。
  settlementStarted: boolean
  // 助手输出投递失败（若有）。
  outputError: Error | undefined
  // Agent 运行期失败（若有）。
  agentError: Error | undefined
}

/** Standard invalid-parameter failure with protocol-safe detail. */
// 标准的参数非法失败（细节对协议安全）。
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
// 标准的内部失败（细节对协议安全）。
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Install switch notices and mount the requested MCP clients in the unpublished Agent scope.
 * @param agentCtx - unpublished Agent scope.
 * @param options - workspace and MCP servers requested for the session.
 */
// 在未发布的 Agent 作用域中安装切换通知并挂载请求的 MCP 客户端。
async function composeAgent(agentCtx: Context, options: AcpSessionBuildOptions): Promise<void> {
  // 安装模型选择能力（provider/model/推理力度的配置视图）。
  installModelSelection(agentCtx)
  // 挂载会话请求的全部 MCP 服务器。
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, model
 * configuration view, one-prompt admission slot, ordered standard updates,
 * and memoized quiescent teardown.
 */
// 每会话的 ACP 模块（详见上方英文说明）：持有未发布的 Agent 组合、模型配置视图、
// 单提示准入槽、有序标准更新，以及只执行一次的静默拆除。
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  // 本 ACP 会话精确拥有的顶层 Agent。
  readonly agent: Agent
  // 模型控制（配置项视图与变更）。
  private readonly modelControl: AcpModelControl
  // 有序输出更新队列的尾部 Promise。
  private outputTail = Promise.resolve()
  // 当前在途提示（单槽位）。
  private inflight: InflightPrompt | undefined
  // 关闭（静默拆除）Promise 缓存。
  private closing: Promise<void> | undefined

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    // 记录拥有的 Agent。
    this.agent = handle.agent
    // 基于会话 LLM 运行时与 Agent 模型构造控制视图。
    this.modelControl = new AcpModelControl(ctx.llm, handle.agent.model)
    this.disposeAgent = () => handle.dispose()
  }

  // Agent 句柄的释放函数（构造时捕获）。
  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  // 在发布前组合全新的 Agent 与全部请求的 MCP 客户端。
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    // 通过 agent 服务创建（带构建钩子）。
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    // 用句柄构造会话模块。
    return new AcpSession(ctx, handle, options.notify)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * The Session's recorded model selection survives; deployment options supply
   * the route only when the Session records neither a selection nor a request.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, workspace, initial route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  // 恢复持久化的 Agent 并组合本次请求的全新 MCP 连接（详见上方英文说明）。
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    // 通过 agent 服务恢复（同样带构建钩子）。
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: agentCtx => composeAgent(agentCtx, options),
    })
    return new AcpSession(ctx, handle, options.notify)
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  // 判断本模块是否精确拥有该 Agent 引用（拒绝同 id 冒名者）。
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  // 判断本模块是否精确拥有该 Session 引用。
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns provider-grouped model and exact-model reasoning options.
   */
  // 返回完整的标准模型配置选项状态。
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    // 会话正在关闭则拒绝。
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * Apply one standard configuration option from the next model step.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  // 应用一个标准配置项，从下一次模型步骤起生效。
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  // 拓扑变化处理：先在链外解析配置状态，再串行发送其通知，不阻塞执行类更新。
  topologyChanged(): void {
    // 已在关闭流程则忽略。
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        // 发送前可能已进入关闭，再查一次。
        if (this.closing !== undefined) return
        // 接到输出队列尾部，保持通知有序。
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'config_option_update', configOptions },
          }))
          /* v8 ignore start -- the bridge notifier contains transport failure. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      })
      /* v8 ignore start -- option discovery contains per-provider failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Admit one prompt and settle after the root, descendants, and updates finish.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  // 准入一个提示；在根工作、后代与更新全部完成后结算（详见上方英文说明）。
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    // 会话正在关闭则拒绝。
    this.assertActive()
    // 单槽位：已有在途提示则拒绝。
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    // 提示完成的结算器（终止原因）。
    const completion = Promise.withResolvers<StopReason>()
    // 准入完成信号。
    const admission = Promise.withResolvers<void>()
    // 准入阶段专用取消控制器。
    const admissionController = new AbortController()
    // 组装在途提示状态。
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancellationDone: Promise.withResolvers<void>(),
      cancelStartedIdle: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    // 占用槽位。
    this.inflight = inflight
    // 请求中止时的回调：取消本提示。
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    // 监听 JSON-RPC 请求取消信号（一次性）。
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    // 信号可能已经中止：立即处理。
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      // 捕获准入阶段的失败，稍后统一结算。
      let admissionFailure: unknown
      // 准入时的模型选择快照。
      const promptSelection = this.agent.model.current()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          // Agent 已在桥接之外被处置：拒绝排队。
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        // 把 ACP 提示准入为持久核心内容（图片在此校验并落盘）。
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        // 准入后检查取消。
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          // 写盘与排队之间 Agent 可能被处置：同样拒绝。
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        // 构造用户消息。
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        // 记录消息 id 并标记已入队。
        inflight.messageId = message.id
        inflight.messageQueued = true
        try {
          // 把消息加入 Agent 的后续队列。
          this.agent.followup(message)
        } catch (error: unknown) {
          // 入队失败则回滚“已入队”标记。
          inflight.messageQueued = false
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        // 无论成败都结束准入，让等待方继续。
        inflight.finishAdmission()
      }

      if (inflight.admissionController.signal.aborted) {
        // 准入被取消：静默后以 cancelled 结算。
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        // 准入失败：释放槽位并映射错误类别。
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        // RequestError 原样上抛。
        if (admissionFailure instanceof RequestError) throw admissionFailure
        // 其余错误统一包装为内部错误。
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      // 正常准入：启动静默结算并等待终止原因。
      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      // 移除请求取消监听。
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  // 取消活动提示；没有 ACP 提示时取消 Agent 的自主工作。
  cancel(): void {
    // 记录调用时是否存在在途提示。
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    // 无在途提示时直接取消 Agent。
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  // 处理一条持久化事件，把它的标准 ACP 投影加入有序更新队列。
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start' && this.inflight?.turn !== undefined) {
      // 回合开始：记录回合号并清空上一回合的结束原因。
      this.inflight.turn = event.data.turn
      this.inflight.endReason = undefined
    }
    try {
      if (event.type === 'assistant/message') {
        // 仅当事件属于在途提示的回合时才关联失败。
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        // 串行把助手输出转换为标准更新并逐条发送。
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        // 投递失败：记入在途提示的输出错误并告警，不阻断队列。
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        const previous = this.outputTail
        // 工具调用投影为标准更新。
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'tool/result') {
        const previous = this.outputTail
        // 工具结果投影（可能需异步补充内容转换）。
        this.outputTail = previous
          .then(async () => this.notify({
            sessionId: this.agent.session.id,
            update: await toolResultUpdate(this.ctx, event),
          }))
          /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        // 回合结束：记录结束原因并清除运行期失败（提交记录优先）。
        inflight.endReason = event.data.reason
        inflight.agentError = undefined
      }
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  // 把已受理的用户消息与其 Agent 回合关联起来。
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param error - original same-process failure.
   */
  // 把 Agent 运行期失败与活动 ACP 提示关联。
  onAgentError(error: unknown): void {
    const inflight = this.inflight
    // 无在途提示或消息未入队时不处理。
    if (inflight === undefined || !inflight.messageQueued) return
    // A later committed turn/end supersedes this live failure. Failed turn
    // start/end appends have no terminal record and keep the failure observable.
    // 稍后提交的 turn/end 会覆盖此实时失败；回合开始/结束追加失败没有终止记录，
    // 因此保持失败可观测。
    inflight.agentError = new Error(errorChain(error))
    // 触发静默结算。
    this.settleAfterQuiescence(inflight)
  }

  /**
   * Complete cancelled activity without following a later root driver.
   * @param status - the emitted transition, which may precede a reentrant wake.
   */
  // 完成已取消的活动，不再跟随其后的根驱动者。
  onAgentStatus(status: AgentStatus): void {
    const inflight = this.inflight
    // 仅处理已入队且准入已被取消的在途提示。
    if (inflight === undefined || !inflight.messageQueued || !inflight.admissionController.signal.aborted) return
    // Maintenance remains publicly idle; its next running transition belongs
    // to work released after the maintenance task finished.
    // 维护活动对外仍为空闲；其后的 running 转换属于维护任务结束后释放的工作。
    if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(this.outputTail)
  }

  /** Await every update queued before this call. */
  // 等待本次调用之前入队的全部更新发送完成。
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  // 一次性完成：取消、排空、落盘并释放本会话（幂等）。
  close(detail: string): Promise<void> {
    // 已在关闭则复用同一 Promise。
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      // 收集拆除阶段的失败。
      const failures: unknown[] = []
      // 捕获当前在途提示。
      const inflight = this.inflight
      // 取消任何准入中的提示。
      this.cancelPrompt(detail)
      // 无已入队消息时直接取消 Agent 的自主工作。
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        // 依次等待：准入结束、Agent 空闲、输出队列排空。
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      // 获取子代理生命周期服务。
      const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
      try {
        // 子代优先释放全部子代理后代。
        await subagents?.drainDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('subagent teardown failed', { cause: error }))
      }
      try {
        // 把会话持久化落盘。
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        // 释放 Agent 句柄。
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      // 单一失败直接上抛。
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
      if (failures.length > 1) {
        // 多个独立拆除失败聚合成 AggregateError。
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  // 断言会话未在关闭中；否则按参数非法拒绝。
  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  // 取消在途提示（幂等）；处理取消完成的结算。
  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    // 无在途提示则无事可做。
    if (inflight === undefined) return
    // 是否为第一次取消。
    const firstCancellation = !inflight.admissionController.signal.aborted
    if (firstCancellation) inflight.cancelStartedIdle = this.agent.status === 'idle'
    // 中止准入控制器（携带取消原因）。
    inflight.admissionController.abort(new Error(detail))
    // 启动静默结算。
    this.settleAfterQuiescence(inflight)
    if (!inflight.messageQueued) {
      // 消息尚未入队：取消即刻完成。
      inflight.cancellationDone.resolve()
      return
    }
    // 已入队：请求 Agent 取消当前工作。
    this.agent.cancel({ kind: 'user' })
    if (firstCancellation) {
      const done = inflight.cancellationDone
      // Plugin disposal can detach status observers before this activity retires.
      // 插件释放可能在本活动退役前移除状态观察者，因此以 whenIdle 兜底。
      void this.agent.whenIdle().then(() => { done.resolve(this.outputTail) }, done.reject)
    }
  }

  // 静默结算：等待准入、运行、后代与更新全部安静后，按失败/取消/结束原因结算提示。
  private settleAfterQuiescence(inflight: InflightPrompt): void {
    // 只启动一次。
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      // 先等准入结束。
      await inflight.admissionDone
      if (inflight.messageQueued) {
        // 已入队：需要等待 Agent 与子代理树安静。
        const subagents = this.ctx.get('subagents') as SubagentLifecycle | undefined
        // 取消完成信号。
        const cancelled = inflight.cancellationDone.promise
        // 是否处于取消状态。
        const isCancelled = (): boolean => inflight.admissionController.signal.aborted
        // Agent 是否空闲且会话序号未变（防止空闲后又被唤醒）。
        const idleAt = (seq: Session['seq']): boolean => this.agent.status === 'idle' && this.agent.session.seq === seq
        while (true) {
          // 等待 Agent 空闲或取消完成。
          await Promise.race([this.agent.whenIdle(), cancelled])
          if (isCancelled()) break
          // 记录空闲时的会话序号。
          const idleSeq = this.agent.session.seq
          // 等待子代理树工作结束或取消。
          const children = await Promise.race([subagents?.waitForTreeWork(this.agent), cancelled])
          if (isCancelled()) break
          // 仍有子代理工作或 Agent 已被再次唤醒则继续轮询。
          if (children || !idleAt(idleSeq)) continue
          // 等输出队列排空。
          await this.outputTail
          // 排空后仍保持空闲（且未取消）才算真正安静。
          if (isCancelled() || idleAt(idleSeq)) break
        }
        if (isCancelled()) await cancelled
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      // 清空槽位。
      this.inflight = undefined
      if (inflight.admissionController.signal.aborted) {
        // 准入被取消：以 cancelled 结算。
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        // 助手输出投递失败：内部错误拒绝。
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        // Agent 运行期失败：内部错误拒绝。
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        // 无结束原因（异常路径）：按取消结算。
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        // 回合以错误结束：内部错误拒绝。
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        // 正常结束：映射为标准停止原因。
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}
