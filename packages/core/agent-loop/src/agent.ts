// 模块说明：默认的 Agent 驱动器（ReactLoopAgent）——harness 的"方向盘"：
// 基于排队轮次（turn）与步进边界（step）输入驱动一个会话，每个请求都从
// 会话日志推导而来。关键设计：
// 1. 事件溯源：turn/start、step/start、assistant/message、tool/result、
//    request/header 等事件按序追加到会话日志，模型请求由日志投影重建，
//    崩溃后可无损恢复；
// 2. 相位机：idle / maintenance / running 三相位，取消信号按相位归属；
//    收尾时的唤醒请求（wakeRequested）被闩住，收敛后重放；
// 3. 流式容错：助手流中断时会先落盘已收到的内容块（interrupted 消息），
//    再抛出，保证日志里不丢半轮输出。
/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

// dsh-agent 契约类型：智能体、取消原因、事件分发、选项、状态、取消选项、
// 模型选择与投影、收件箱目标/状态、步前决议、请求错误动作。
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxTarget,
  InboxState,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
// 智能体模型层、事件分发器工厂、上下文组装器。
import { AgentModel, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
// LLM 类型：生成选项、调用配置、消息、预处理的 LLM 调用。
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
// LLM 原语：结构化错误、构造助手/开发者消息、错误链文本、标记主循环请求。
import {
  LlmError,
  createAssistantMessage,
  createDeveloperMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
// 值工具：穷尽断言与深冻结。
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
// 作用域：类型与工厂（驱动器自己的注册边界）。
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
// 会话类型：纪元头部、请求上下文、会话、id、序号、轮次结束原因、用户消息。
import type { EpochHeader, RequestContext, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
// 会话原语：规范化头部、头部相等比较、工具调用恢复观察器。
import { canonicalHeader, headerEquals, ToolCallRecovery } from '@deepseek-ai/dsh-session'
// 系统提示词：段落合并/渲染与最终提示词渲染。
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
// 提示词组装结果类型。
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// 工具侧错误：激活失败与批量执行失败。
import { ToolActivationError, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
// 已解析工具集类型。
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
// cordis Context 类型。
import type { Context } from '@deepseek-ai/cordis'
// 收件箱实现（排队输入的认领与切片）。
import { ReactLoopInbox } from './inbox.ts'
// 运行期上下文投影与系统提示词投影。
import { RuntimeContextProjection } from './runtime-context.ts'
// 助手流单次尝试的落盘/中断处理。
import { AssistantStreamAttempt } from './assistant-stream.ts'
// 系统提示词投影（同文件的另一个导出）。
import { SystemPromptProjection } from './runtime-context.ts'

/** Projected facts consumed by this driver; registration stays with the factory. */
// 本驱动器消费的投影事实；注册仍归工厂（index.ts）所有。
interface LoopProjections {
  /** Current model selection, including pending changes. */
  // 当前模型选择（含待生效变更）。
  readonly modelSelection: () => ModelSelectionProjectionState
  /** Current queued and claimed input. */
  // 当前排队与已认领的输入。
  readonly inbox: () => InboxState
}

// 驱动器相位：idle（空闲，记录上一轮号）| maintenance（维护窗口，独立取消信号
// 与唤醒闩）| running（主循环运行中，带轮号/步号与唤醒闩）。
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

// 步结束原因：轮次结束原因中"自然完成"与"触顶"两类（步级可返回 null 表示继续）。
type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

// 步准备的产出：拒绝，或带齐进入下一步所需的全部输入。
type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    // 本步认领到的用户消息。
    messages: UserMessage[]
    // 是否开启新的请求系列（首个重试/恢复步）。
    startsRequestSeries?: true
    // 提示词组装结果。
    assembly: PromptAssembly
    // 本步固定的模型选择。
    selection: Readonly<ModelSelection>
    /** Admission shared by the step's declarations and dispatch; the turn disposes it after the step. */
    // 步内声明与分发共享的工具准入；轮次在步结束后释放它。
    toolSet: ResolvedToolSet
  }

/** Remove adapter-derived values before plugins propose the next request config. */
// 在插件提议下一个请求配置之前剔除适配器派生值（reasoningEffort/maxTokens
// 若标记为适配器默认则从提案中删除）。
function requestProposal(header: EpochHeader): LlmCallConfig {
  // 无适配器默认标记：配置原样返回。
  if (header.adapterDefaults === undefined) return header.config
  // 复制配置后剔除被适配器接管的键。
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  // 信号未中止：无原因。
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  // cancel() 是本循环所持信号唯一的中止来源，原因必为 AgentCancelCause。
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    // 这三类只拷贝 kind，不携带原始对象。
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    // hook 类额外携带理由文本。
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/** Drives one session through turn and step boundaries. */
// 驱动一个会话跨越轮次与步进边界的驱动器类（implements Agent）。
export class ReactLoopAgent implements Agent {
  // 模型选择层。
  readonly model: AgentModel
  // 排队输入收件箱。
  readonly inbox: ReactLoopInbox
  // 当前相位。
  private phase: Phase
  // 当前活动（驱动/维护）的落定 promise，用于 whenIdle 等待。
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  // 智能体作用域的注册边界；生命周期所有者在驱动器退出后退绕它。
  readonly scope: Scope
  // 智能体自有上下文。
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  // 融合分发器：构造时建一次，热路径分发不再分配。
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  // 本循环实例是否已追加过 initial/resume 请求锚点。
  private requestHeaderLogged = false
  /** Surface generation at attachment or the preceding built request. */
  // 附着时或上一次构建请求时的 surface 世代（用于判断请求系列断点）。
  private requestSurfaceGeneration: number
  // 运行期上下文投影。
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  // 本会话助手帧的进程内修订号（流式重放用）。
  private assistantStreamRevision = 0
  // 助手流尝试计数器。
  private assistantAttemptCounter = 0
  // 系统提示词投影。
  private readonly systemPrompt: SystemPromptProjection
  /** Identities fully frozen by this loop; weak references do not retain replaced history. */
  // 被本循环深冻结过的消息集合；弱引用不保留被替换的旧历史。
  private readonly frozenMessages = new WeakSet<Message>()

  // 构造：装配作用域、分发器、模型层、收件箱与两个投影。
  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    projections: LoopProjections,
    lastTurn: number,
  ) {
    // 记录附着时的 surface 世代。
    this.requestSurfaceGeneration = session.surface.contentGeneration
    // 构建融合事件分发器。
    this.dispatch = agentEvents(loopCtx, this)
    // 创建智能体作用域（独立注册边界）。
    this.scope = createScope(loopCtx, this)
    // 取作用域上下文。
    this.ctx = this.scope.ctx
    // 模型层：基于投影与会话头部推导当前选择。
    this.model = new AgentModel(projections.modelSelection, session, options)
    // 收件箱：基于输入投影。
    this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch)
    // 初始相位：空闲，继承上次轮号。
    this.phase = { kind: 'idle', lastTurn }
    // 建运行期上下文投影。
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    // 建系统提示词投影。
    this.systemPrompt = new SystemPromptProjection(session)
  }

  // 对外状态：running 相位即 running，否则 idle。
  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  // 提交相位并在状态变化时对外发布 agent/status 事件。
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    // 唤醒型输入不能加入已被中止的活动，因此降级为开启下一轮。
    // 在插入之前先判定，拼接观察者触发的重入 cancel 无法改变这个分类。
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    // 已中止则目标改写为 next-turn。
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    // 把消息插入收件箱目标位置（Infinity = 队尾）。
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    // 需要唤醒时驱动主循环（携带中止后唤醒的分类）。
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  // 跟进输入：下一轮队列并唤醒。
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  // 转向输入：下一步队列并唤醒。
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  // 注入输入：下一步队列但不唤醒。
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  // 取消：默认清空收件箱并中止当前活动；keepInbox 则保留排队输入。
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      // 清空收件箱。
      this.inbox.clear()
      // 排队输入已清：撤销被闩住的唤醒请求。
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    // 非空闲相位：以给定原因中止当前活动的信号。
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  // 维护窗口：空闲时才能进入；以维护专用信号运行任务，结束后回 idle 并重放闩住的唤醒。
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // 已有活动：拒绝。
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    // 完成栅栏。
    const done = Promise.withResolvers<void>()
    // 组装维护相位。
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    // 提交相位并发布状态。
    this.setPhase(maintenance)
    // 登记活动 promise。
    this.activityDone = done.promise
    return (async () => {
      try {
        // 以维护信号执行任务。
        return await job(maintenance.abort.signal)
      } finally {
        // 回到空闲（保留轮号）。
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        // 非 disposed 的维护期间若有闩住的唤醒且还有排队输入：重放唤醒。
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        // 放下完成栅栏。
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    // 非空闲：无法立即启动驱动器。
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      // 维护中与已中止的驱动器无法送达唤醒：闩住它，收敛后重放。
      // 存活驱动器自己认领排队工作；disposal 永不闩住，
      // 拆除不必等任何模型轮次。
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    // 驱动器完成栅栏。
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    // 进入 running 相位：新取消信号、轮号从上次值起步、步号归零。
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    // 以发起者身份启动主循环（kick），完成后放下栅栏。
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  // 等待当前活动结束：处理活动替换的竞态（await 后若 promise 已换则再等）。
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  // 在失败发生的活边界上报 agent/error，再原样抛出（由驱动器边界容住）。
  private throwError(error: unknown): never {
    // 记录失败的轮号与步号。
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  // 主循环入口：一轮接一轮，直到某轮返回 false。
  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
      // 已上报的失败与取消在驱动器边界被容住。
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        // 驱动器收尾：回 idle 并重放闩住的唤醒（若仍有排队输入）。
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    // 取当前 running 相位的取消信号。
    const signal = this.phase.abort.signal
    // 从收件箱认领目标位置的输入（锚定到本轮）。
    const claimed = this.inbox.claim(target, position.turn)
    // 读取当前模型选择。
    const selection = this.model.current()
    if (selection === undefined) {
      // 没有模型路由：显式报错。
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`)
    }
    // 解析本步的工具准入（共享给声明与分发）。
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
    try {
      // 组装系统提示词与上下文。
      const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })
      signal.throwIfAborted()
      // 跑 agent/pre-step 瀑布：缺省决议为进入（附运行期上下文消息）。
      const decision = await this.dispatch.waterfall(
        'agent/pre-step', { messages: claimed, ...position, signal, modelSelection: selection },
        (): Promise<PreStepDecision> => {
          // 渲染上下文段落并投影出运行期上下文消息。
          const sections = renderContextSections(assembly)
          const context = this.runtimeContext.project(joinContextSections(sections), sections)
          return Promise.resolve<PreStepDecision>({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
          })
        },
      )
      signal.throwIfAborted()
      if (decision.kind === 'reject') {
        // 拒绝：释放工具准入。
        toolSet.dispose()
        return decision
      }
      // 进入：携带组装结果、选择与工具集。
      return { ...decision, assembly, selection, toolSet }
    } catch (error: unknown) {
      // 任何失败都要释放准入再抛。
      toolSet.dispose()
      throw error
    }
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  // 判断组装出的工具 schema 是否与已记录的请求头部不一致。
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    // 无基线头部：无变化可言。
    const baseline = this.session.requestHeader()
    if (baseline === undefined) return false
    // 以工具列表替换后规范化再比较。
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  // 打开一轮：追加 turn/start，逐步推进直到轮次终结；返回是否还有下一轮。
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      // 无驱动器预约却开轮：结构化上报并抛出。
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    // 轮号 +1。
    const turn = phase.turn + 1
    try {
      // 追加轮次开始事件。
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    // 轮次结束原因（最终写入 turn/end）。
    let turnEnds: TurnEndReason | null = null
    // 下一输入的目标（首轮 next-turn，其后 next-step）。
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        // 步号 +1 并提议一步。
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          // 步前决议拒绝：本轮以 blocked 收场。
          turnEnds = { kind: 'blocked' }
          return false
        }
        try {
          // 轮次已决定终结且没有新消息：退出循环。
          if (turnEnds && decision.messages.length === 0) break
          // A removed waking message or an enter decision rewritten to empty
          // still owns the initial turn boundary, but it spends no model call.
          // 被移除的唤醒消息或被改写为空的进入决议仍拥有轮次首边界，
          // 但不再花费模型调用。
          if (phase.step === 0 && decision.messages.length === 0) {
            turnEnds = { kind: 'completed' }
            return false
          }
          signal.throwIfAborted()
          // 追加步开始事件并推进步号。
          this.session.append('step/start', { turn, step })
          phase.step = step
          // 工具调用恢复观察器：步失败时兜底补记 pending 的工具结果。
          const toolRecovery = new ToolCallRecovery()
          const stopRecovery = this.ctx.on('session/event', (session, event) => {
            if (session === this.session) toolRecovery.observe(event)
          })
          try {
            // max-tokens is sticky: once any step hits the ceiling, later steps
            // that complete normally must not downgrade the turn outcome.
            // max-tokens 具有粘性：任一步触顶后，后续正常完成的步
            // 不得降级本轮的结局。
            const stepEnd = await this.step(decision)
            // max-tokens stays sticky: a later completed step must not
            // downgrade the turn outcome.
            // 粘性保证：已有 max-tokens 结局时不被覆盖。
            if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
          } catch (error: unknown) {
            try {
              // 步失败：把恢复观察器记录的 pending 工具结果补记进日志。
              for (const event of toolRecovery.results()) {
                this.session.append('tool/result', event.data, {
                  surfaceOp: 'append',
                  ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
                })
              }
            } catch (recoveryError: unknown) {
              // 补记也失败：聚合两个错误（原始失败为主因）。
              throw new AggregateError([error, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: error })
            }
            // 原样抛出原始失败。
            throw error
          } finally {
            // 停止恢复观察并追加步结束事件。
            stopRecovery()
            this.session.append('step/end', { turn, step })
          }
        } finally {
          // Admission closes once the step's tool batch settles or no step opens.
          // 步的工具批次落定（或根本没开步）后立即关闭准入。
          decision.toolSet.dispose()
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          // 轮次将止且无下一步输入：跑串行的 agent/turn-stopping 通知。
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        // 继续本轮的下一步。
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      // 有原因恰好等价于信号被中止：本轮以 aborted 收场并原样抛出。
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, a tool
      // activation failure keeps its code, and anything else flattens to
      // `errorChain` text under the `UNKNOWN` code.
      // 一切失败都结构化：LlmError 保留事实，工具激活失败保留错误码，
      // 其余压平为 errorChain 文本并挂 UNKNOWN 码。
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: error instanceof ToolActivationError ? error.code : 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        // 每条退出路径都已赋值 turnEnds：落盘轮次结束事件。
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    // 无排队输入：驱动器结束。
    if (!this.inbox.hasPending) return false
    // 还有排队输入：换新取消信号继续下一轮。
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    // 新控制器让旧控制器上设置的闩失效：存活驱动器自己认领队列。
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    // 取轮号、步号与取消信号。
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const { assembly } = decision
    // 渲染最终提示词文本。
    const renderedPrompt = renderPrompt(assembly)
    // 是否为本步的首次尝试。
    let firstAttempt = true
    // 请求尝试循环：错误可重试时从头再来。
    while (true) {
      // 解析请求配置（可能绑定适配器）。
      const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal)
      // 刷新并投影运行期上下文消息。
      const currentContext = this.loopCtx.systemPrompt.refreshContext(assembly, {
        ...assembleContextFor(this, signal), modelSelection: decision.selection,
      })
      const sections = renderContextSections(currentContext)
      const context = this.runtimeContext.project(joinContextSections(sections), sections)
      signal.throwIfAborted()
      // 是否开启新的请求系列（仅首尝试）。
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
      // 计算系统提示词的落盘提交（何时进历史、何时开新系列）。
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === 'in-history',
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools)),
      })
      // 按意图落盘系统消息。
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      // 运行期上下文消息是否已入场。
      let contextAdmitted = false
      if (firstAttempt) {
        // 首尝试：落盘认领的用户消息；运行期来源的消息由投影内容顶替。
        for (const message of decision.messages) {
          if (message.source.kind === 'runtime-context') {
            if (context !== undefined && !contextAdmitted) {
              this.session.append('user/message', context, { surfaceOp: 'append' })
              contextAdmitted = true
            }
          } else {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
        }
      }
      // 尚未入场的上下文消息补记一次（重试尝试也会刷新上下文）。
      if (context !== undefined && !contextAdmitted) {
        this.session.append('user/message', context, { surfaceOp: 'append' })
      }
      // 此后不再是首尝试。
      firstAttempt = false
      // 落盘请求信封并构建冻结的请求。
      const request = this.buildRequest(config, preparedCall, assembly.tools, { turn, step }, startsRequestSeries, signal)
      // 建立本次助手流的尝试记录（含修订号推进与帧分发）。
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      // 流是否已启动（决定错误结算路径）。
      let started = false
      try {
        // 优先用预处理调用的流（带适配器上下文），否则直接走 LLM 流。
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        // 消费流分块；每个分块前检查取消。
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        // 未启动就失败：无结算负担，直接抛。
        if (!started) throw error
        try {
          if (signal.aborted) {
            // 中断：已收到的内容块作为 interrupted 消息落盘（半轮不丢）。
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              // 无内容块：只落盘尝试记录。
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            // 非取消失败：落盘尝试记录。
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          // 结算也失败：聚合两个错误。
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        // 原样抛出流错误。
        throw error
      }
      try {
        // 取流结束状态。
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          // 失败/中止：落盘尝试记录。
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          // 跑 agent/request-error 瀑布决定重试策略。
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            // 不重试：抛结构化 LLM 错误。
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          // 重试：回到尝试循环开头。
          continue
        }

        // 成功：构造助手消息并落盘。
        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        // 触顶：本轮以 max-tokens 结束。
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        // 抽取工具调用块。
        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        // 读取当前并行工具调用上限。
        const maxParallelToolCalls = this.loopCtx.agentLoop.config.maxParallelToolCalls.get()
        try {
          // 经工具管线执行整批调用。
          const result = await this.loopCtx.tools.execute({
            calls: toolCalls, signal, agent: this, log: { turn, step },
            maxParallelToolCalls, toolSet: decision.toolSet,
          })
          // 附加上下文并进下一步队列。
          for (const context of result.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          // 批次声明轮次终结则完成，否则 null（等待下一步输入）。
          return result.concluded ? { kind: 'completed' } : null
        } catch (error: unknown) {
          // 批量执行失败：先保留部分结果的附加上下文，再抛出根因。
          if (!(error instanceof ToolBatchExecutionError)) throw error
          for (const context of error.partial.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          throw error.cause
        }
      } catch (error: unknown) {
        // 任何未结束的流尝试都要放弃（清理订阅）。
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** Resolve request config for the step's selection and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    selection: Readonly<ModelSelection>,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance seeds output controls from its options until it logs its
    // own header; later steps re-resolve marked defaults.
    // 循环实例在记下自己的请求头之前，先用 options 播种输出控制；
    // 之后的步会从头部重新解析被标记为适配器默认的项。
    const maxTokens = this.options.maxTokens
    const persisted: Partial<LlmCallConfig> = this.requestHeaderLogged
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
      ? requestProposal(session.requestHeader()!)
      : maxTokens === undefined ? {} : { maxTokens }
    // 路由三项已在 selection 里固定，从持久配置中剔除。
    const { provider: _provider, model: _model, reasoningEffort: _effort, ...controls } = persisted
    // 播种配置：控制项 + 固定的选择，深拷贝后冻结。
    const seedConfig = deepFreeze(structuredClone({ ...controls, ...selection }))
    // 跑 agent/request 瀑布让插件提议配置。
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    // 插案不得改动步准备时已固定的路由。
    if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
      throw new Error(`agent "${this.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`)
    }
    // 推理力度同样不得事后改动。
    if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
      throw new Error(`agent "${this.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`)
    }
    // 最终配置与可选的预处理调用。
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      // 让 LLM 层预处理调用（绑定适配器、推导上下文窗口等）。
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      // 中间件可能服务未注册路由；只有 NO_ADAPTER 才容住（终局分发仍需适配器）。
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    // 返回配置与（若有）预处理调用。
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Log the resolved envelope and derive a frozen request from the admitted surface. */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    position: { turn: number; step: number },
    startsRequestSeries: boolean,
    signal: AbortSignal,
  ): GenerateOptions {
    const { session } = this
    // 当前的 surface 世代。
    const surfaceGeneration = session.surface.contentGeneration
    // 规范化请求头部（配置 + 适配器默认标记 + 工具列表）。
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    // 上一条已记录的头部基线。
    const baseline = this.session.requestHeader()
    // 是否开启新请求系列：显式标记或 surface 世代变化。
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    // 头部事件的序号（用于工具变更消息关联）。
    let headerSeq: SessionSeq | undefined
    if (!this.requestHeaderLogged) {
      // Compaction during the first resumed pre-step must still mark a new series.
      // 首次记录：initial（全新）或 resume（恢复）；恢复首步期间的压缩仍要标记新系列。
      headerSeq = this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      // 头部变化：以 change 记录。
      headerSeq = this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
    } else if (startsSeries) {
      // 头部未变但开启新系列：以 series 记录。
      this.session.append('request/header', { header, reason: 'series' })
    }
    if (baseline !== undefined && headerSeq !== undefined) {
      // 对比新旧工具名集合，推导增删清单。
      const previousNames = new Set(baseline.tools?.map(tool => tool.name))
      const currentNames = new Set(tools.map(tool => tool.name))
      const additions = tools.filter(tool => !previousNames.has(tool.name))
        .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
      const removals = (baseline.tools ?? []).filter(tool => !currentNames.has(tool.name))
        .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
      if (additions.length > 0 || removals.length > 0) {
        // 有增删：落盘开发者消息告知模型（新增时关联头部序号）。
        session.append('developer/message', {
          ...position,
          message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          ...additions.length > 0 ? { headerSeq } : {},
        }, { surfaceOp: 'append' })
      }
    }
    // 推进 surface 世代记录。
    this.requestSurfaceGeneration = surfaceGeneration

    // 组装请求上下文（提供方/模型/上下文窗口/系统提示词更新策略）。
    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    // 与上一条请求上下文不同才落盘。
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    // canonicalHeader 是浅层的；append 记录的是分离快照，这里冻结本地值只为防御。
    deepFreeze(header)
    // 从会话 surface 推导边界消息（模型可见输入）。
    const boundaryMessages = session.deriveMessages()
    for (const message of boundaryMessages) {
      // 已冻结过的消息跳过（弱集合不保留被替换的旧历史）。
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    // 冻结消息数组本身。
    Object.freeze(boundaryMessages)
    // 组装最终请求：头部配置 + 边界消息 + 工具历史 + 工具列表 + 会话 id + 信号。
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      toolHistory: session.toolHistory(),
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return request
  }
}
