// 模块说明：共享的工具调用策略、取消与结果定稿管线。它是工具管线的"宪法"：
// 把一次工具调用拆成 prepare（快照入参 + 预执行策略/守卫）→ dispatch
// （around 分发 + 工具体）→ complete（post-execute 策略 + 内容定稿 + 结果发布）
// 三个有序阶段；batch 调度器与 PTC 程序调度器都按这套阶段推进，prepare/complete
// 严格有序、dispatch 允许并发。关键设计：
// 1. 取消优先但绝不遗弃：已启动的工具体必须跑到静止，之后才把成功结果
//    替换为规范的 ABORTED 结果（区分"分发前中止"与"体启动后中止"两个错误码）；
// 2. 规范化与冻结：每个结果在进入观察者前都做无损 JSON 快照 + 深冻结，
//    canonicalResults 记录"哪个结果由哪次 dispatch 校验"以防包装层伪造；
// 3. 容错边界：策略/监听器失败一律转为错误结果，绝不向上冒泡成崩溃。
/** Shared tool invocation policy, cancellation, and result settlement. @module */
// cordis 的 Context 类型。
import type { Context } from '@deepseek-ai/cordis'
// 作用域键与作用域目标解析（按智能体圈定监听范围）。
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// 内容块类型与 HarnessError（带 name/code 的结构化错误）。
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
// 用户消息类型（工具体延迟注入的上下文）。
import type { UserMessage } from '@deepseek-ai/dsh-session'
// 副作用导入：引入 user-approval 的类型环境。
import type {} from '@deepseek-ai/dsh-user-approval'
// 值工具：穷尽断言、深冻结、无损 JSON 快照与 JsonValue 类型。
import { assertNever, deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
// 契约常量与错误类：中止错误码（两种）、工具未找到、工具输出非法。
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, ToolNotFoundError, ToolOutputError } from './contracts.ts'
// 输出 schema 值校验器。
import { validateJsonSchemaValue } from './json-schema.ts'
// 工具服务类型。
import type { ToolsService } from './index.ts'
// 工具契约类型全集：定义、输入、模式、执行对象、结果、错误信息、令牌、决策等。
import type { ResolvedToolSet, ToolDefinition, ToolExecutionInput, ToolExecutionMode, ToolExecution, ToolRunContext, ToolExecutionResult, ToolExecutionSuccess, ToolErrorInfo, ToolExecutionToken, PreToolDecision, PostToolDecision } from './contracts.ts'

/** Executor-owned lookup and restrictions applied before extensible execution policy. */
export interface ToolExecutionSource {
  /**
   * Override registry lookup for executor-owned capabilities; omitted uses the
   * retained registry's executable lookup, which applies the call's step admission.
   */
  // 执行器自有能力对注册表查找的覆盖；缺省时走保留注册表的可执行查找
  // （其中应用了调用的步进准入）。
  get?(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined
  /** Reject an otherwise visible invocation before policy; omitted permits it. */
  // 在可扩展策略之前拒绝一次本已可见的调用；缺省即放行。
  reject?(name: string, nested: boolean): Error | undefined
}

/** Prepared invocation; immediate results carry their post-execute requirement. */
// prepare 阶段的产出：待分发的调用；立即结果则标注其是否还需要 post-execute。
export type ScheduledToolPreparation =
  // 正常路径：进入 dispatch。
  | { kind: 'dispatch'; exec: ToolRunContext }
  // 立即结果路径：附分发分类。
  | ({ exec: ToolRunContext } & ScheduledToolDispatch)

/** A `post-result` receives post-execute; a `final-result` bypasses it. */
// post-result 仍要过 post-execute；final-result 直接绕过它。
export type ScheduledToolDispatch =
  | { kind: 'post-result'; result: ToolExecutionResult }
  | { kind: 'final-result'; result: ToolExecutionResult }

/** Registry-owned live execution object; public pipeline views stay readonly. */
// 注册表持有的可变执行对象（signal 槽位可换）；对外视图保持只读。
type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }

/** Approval decision plus whether the approval channel reported cancellation. */
// 审批决议 + 审批通道是否报告了取消。
interface ToolAskResolution {
  // 允许/拒绝决议。
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  // 审批通道被取消（用于区分"策略取消"与"调用方取消"的语义）。
  readonly approvalCancelled: boolean
}

/** Caller cancellation and dispatch state kept outside the around-wrapper view. */
// 调用方取消与分发状态：放在包装可变的执行对象之外保管。
interface ToolCancellationState {
  // 最初调用方的取消信号（权威来源）。
  readonly callerSignal: AbortSignal
  // 工具体是否已启动（决定中止结果的分类）。
  bodyInvoked: boolean
}

/** One dispatch-scoped fused signal plus listener cleanup after the body settles. */
// 一次分发范围的融合信号，及工具体落定后的监听器清理。
interface FusedToolSignal {
  // 融合后的信号。
  readonly signal: AbortSignal
  // 清理监听器。
  dispose(): void
}

/**
 * Shared invocation stages for batch and program schedulers. Schedulers order
 * prepare and complete calls while dispatch may overlap. Use executeToolBatch
 * for complete calls, including a single-call batch.
 */
export class ToolExecutionPipeline {
  // 提前保留的工具服务引用。
  private readonly tools: ToolsService

  // 构造：记录上下文与可选的查找/拒绝覆盖。
  constructor(private readonly ctx: Context, private readonly source: ToolExecutionSource = {}) {
    // Accepted calls retain their event subject while the service is withdrawn during shutdown.
    // 已受理的调用要在服务被撤走（关机中）时仍保留事件主体。
    this.tools = ctx.tools
  }

  // 工具查找：优先执行器覆盖，否则走注册表的可执行查找。
  private get(name: string, scope: ScopeKey | undefined, toolSet: ResolvedToolSet | undefined): ToolDefinition | undefined {
    return this.source.get === undefined
      ? this.tools.executable(name, scope, toolSet)
      : this.source.get(name, scope, toolSet)
  }

  // 解析"可执行"的工具定义：查得到且未被拒绝覆盖才返回。
  private resolveExecution(
    name: string, scope: ScopeKey | undefined, nested: boolean, toolSet: ResolvedToolSet | undefined,
  ): ToolDefinition | undefined {
    const tool = this.get(name, scope, toolSet)
    return tool !== undefined && this.source.reject?.(name, nested) === undefined ? tool : undefined
  }

  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  // 运行中的工具体延迟注入的上下文，按调度器持有的执行对象键存。
  private deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()

  /** Executions whose tool body declared the current turn complete. */
  // 工具体声明"当前轮次已终结"的执行对象集合。
  private concludingExecutions = new WeakSet<ToolExecution>()

  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  // 最初的调用方取消状态：放在包装可变的执行对象之外。
  private cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()

  /** Definition-owned final content transform snapshotted before policy begins. */
  // 定义所有的最终内容变换：在策略开始前快照捕获。
  private contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()

  /** Execution-prepared content installed before post-execute policy. */
  // 执行阶段准备的内容投影：在 post-execute 策略之前安装。
  private contentProjectors = new WeakMap<ToolRunContext, ToolDefinition['projectContent']>()

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    // 先解析可见且未被拒绝的工具定义。
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet)
    // 无定义或未声明并发安全：一律 exclusive（fail-closed）。
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      // 询问定义的分类器。
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      // 只有精确的 true 才算 parallel。
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      // 分类器抛错也 fail-closed 为 exclusive。
      return { kind: 'exclusive' }
    }
  }

  // 创建执行对象：快照参数、分配关联令牌、登记各槽位；被拒绝的调用在这里直接出最终结果。
  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    // 延迟上下文收集器。
    const deferredContexts: UserMessage[] = []
    // 铸造同进程关联令牌。
    const token = createExecutionToken()
    // 调用 id 与根调用 id（缺省为自身）。
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    // 工具名、智能体、父令牌、取消信号。
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // Executor refusals precede extensible policy; unknown tools retain dispatch-stage handling.
    // 执行器拒绝先于可扩展策略；未知工具保留到分发阶段的既有处理。
    const visible = this.get(name, agent, exec.toolSet)
    // 对可见工具应用拒绝覆盖。
    const rejection = visible === undefined ? undefined : this.source.reject?.(name, parent !== undefined)
    const rejected = rejection !== undefined
    // 就地引用终结集合（base 里的方法要用）。
    const concludingExecutions = this.concludingExecutions
    // 组装执行对象的公共字段与两个特权方法。
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {},
      ...parent !== undefined ? { parent } : {},
      ...exec.schema !== undefined ? { schema: exec.schema } : {},
      // 工具体延迟注入上下文消息。
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      // 工具体声明当前轮次终结。
      concludeTurn(this: ToolExecution): void {
        concludingExecutions.add(this)
      },
    }
    // Capture callbacks before argument getters run; rejected calls retain finalization only when aborted.
    // 在参数 getter 运行之前捕获回调；被拒绝的调用只有在中止时才保留定稿回调。
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const capturedProjector = visible?.projectContent?.bind(visible)
    // 依据拒绝与取消状态决定最终化回调是否可用。
    const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
      rejected && !signal.aborted ? undefined : capturedFinalizer
    try {
      // 参数必须可无损 JSON 序列化：先快照分离。
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      // 组装执行对象：参数深冻结，防止工具体改写。
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      // 登记各槽位。
      this.deferredContexts.set(execution, deferredContexts)
      this.contentFinalizers.set(execution, finalizerFor())
      // 被拒绝的调用不安装内容投影器。
      if (!rejected) this.contentProjectors.set(execution, capturedProjector)
      // 登记取消状态（体未启动）。
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false,
      })
      if (rejected) {
        // Cancellation takes precedence over an executor refusal.
        // 取消优先于执行器拒绝：已取消就直接给"分发前中止"结果。
        if (signal.aborted) {
          return { kind: 'final-result', exec: execution, result: toolAbortedBeforeDispatchResult() }
        }
        // 未取消：把拒绝包装成错误结果。
        return {
          kind: 'final-result',
          exec: execution,
          result: toolErrorResult(rejection),
        }
      }
      // 正常就绪：进入 prepare 的策略阶段。
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      // 参数快照失败：组装无参数的执行对象并输出错误结果。
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.contentFinalizers.set(execution, finalizerFor())
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * Snapshot input, assign its correlation token, and run ordered pre-execute
   * policy and guards. Cancellation skips a body that has not started.
   * @param input - the caller-supplied execution input.
   * @returns the prepared execution plus the next scheduler stage.
   */
  async prepare(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    // 先创建执行对象（含拒绝快速路径）。
    const created = this.createExecution(input)
    // 非就绪（已是最终结果）：原样返回。
    if (created.kind !== 'ready') return created
    const exec = created.exec
    // 调用方已取消：跳过尚未启动的工具体。
    if (this.callerCancelled(exec)) {
      return { kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() }
    }
    try {
      // 按智能体圈定预执行瀑布的主体。
      const carrier = scopeTarget(this.tools, exec.agent)
      // 跑 tools/pre-execute 瀑布：缺省决议为 allow。
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      // ask 决议经审批通道解析；其余决议直接通过。
      const askResolution = gate.kind === 'ask'
        ? await this.serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      // 调用方取消叠加审批通道被取消：以中止收场。
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      // 策略决议为 cancel：同样中止。
      if (decision.kind === 'cancel') {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      // 允许时再跑注册表守卫；拒绝时用策略给的理由。
      const denialReason = decision.kind === 'allow' ? this.tools.checkGuards(exec) : decision.reason
      const denialInfo = decision.kind === 'deny' ? decision.info : undefined
      if (denialReason !== undefined) {
        // 守卫/策略拒绝：组装错误结果（post-result 仍走 post-execute）。
        return {
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: `Error: ${denialReason}` }],
            isError: true,
            error: { message: denialReason, ...denialInfo === undefined ? {} : { info: denialInfo } },
          }),
        }
      }
      // 决议允许但此刻已被取消：不再启动工具体。
      if (this.callerCancelled(exec)) {
        return { kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() }
      }
      // 一路绿灯：进入分发阶段。
      return { kind: 'dispatch', exec }
    } catch (error: unknown) {
      // 策略阶段抛错：转为最终错误结果。
      return { kind: 'final-result', exec, result: toolErrorResult(error) }
    }
  }

  /** Whether the original caller signal is currently aborted. */
  private callerCancelled(exec: ToolRunContext): boolean {
    // 取回取消状态。
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    // 经函数调用读取，避免控制流分析把 await 后的状态收窄掉。
    return state.callerSignal.aborted
  }

  /** Canonical cancellation outcome selected by whether the tool body started. */
  // 按工具体是否已启动选择规范的中止结果。
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    // 已启动 -> 体启动后中止；未启动 -> 分发前中止。
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * Dispatch the registered body with the original caller signal fused back
   * into any around-wrapper replacement. Cancellation never abandons the body:
   * a started promise reaches quiescence before its outcome becomes `ABORTED`.
   */
  private async dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    // 取回取消状态。
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    // 包装层当前使用的信号。
    const wrapperSignal = exec.signal
    // 把最初的调用方信号融合回（可能被 around 包装替换过的）信号。
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    // 分发前已中止：清理监听并返回"分发前中止"。
    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    // 替换执行对象上的信号为融合信号（工具体拿到的是它）。
    exec.signal = signal
    try {
      // 分发时刻再解析一次工具定义。
      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet)
      if (!tool) throw new ToolNotFoundError(exec.name)
      // 标记工具体已启动（中止分类的关键）。
      state.bodyInvoked = true
      // 真正执行工具体。
      const returned = await tool.execute(exec.arguments, exec)
      // 组装成功结果（校验/渲染/物化）。
      const result = this.createSuccessResult(exec, tool, returned)
      // 已启动的体必须跑到静止：若期间发生取消，成功结果被规范的 ABORTED 替换。
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      // 工具或未知工具失败：转为错误结果（仍会走 post-execute）。
      return toolErrorResult(error)
    } finally {
      // 清理融合监听并还原信号槽位。
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * Run around-dispatch and the tool body. Tool and unknown-tool failures still
   * receive post-execute; pipeline failures are already final. Started bodies
   * drain on cancellation before a successful outcome becomes `ABORTED`.
   * @param exec - the execution returned by this pipeline's prepare stage.
   * @returns whether the result still needs post-execute.
   */
  async dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      // 解开只读视图得到可变执行对象。
      const mutableExec = exec as MutableToolRunContext
      // 按智能体圈定执行瀑布主体。
      const carrier = scopeTarget(this.tools, exec.agent)
      // 跑 tools/execute 瀑布：around 包装层包住真正的工具体。
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      // 把包装层写的结果经所属输出契约规范化。
      const normalized = this.normalizeDispatchResult(exec, result)
      // 取出工具体延迟注入的上下文。
      const deferredContexts = this.deferredContexts.get(exec)
      /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
      if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
      // 延迟上下文并到结果头部（保持 FIFO：工具体在前）。
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      // 分发结果一律是 post-result：成功但调用方已取消时替换为规范中止。
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      // 管线自身失败（如工具未找到）：已是最终结果，不再走 post-execute。
      return { kind: 'final-result', result: toolErrorResult(error) }
    }
  }

  /**
   * Run post-execute when required, apply definition-owned content finalization,
   * and publish the lossless, frozen result. Policy and finalization failures
   * become error results. Cancellation replaces a successful outcome before
   * final materialization; tool-owned errors remain intact.
   * @param exec - the execution returned by this pipeline's prepare stage.
   * @param outcome - the preparation or dispatch result awaiting completion.
   * @returns the same materialized result delivered to final observers.
   */
  async complete(exec: ToolRunContext, outcome: ScheduledToolDispatch): Promise<ToolExecutionResult> {
    // 按分发分类收尾。
    switch (outcome.kind) {
      // 最终结果：跳过 post-execute 直接定稿。
      case 'final-result':
        return this.finish(exec, outcome.result)
      // post-result：继续走下方流程。
      case 'post-result':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(outcome, 'scheduled tool outcome')
    }
    const { result } = outcome
    try {
      // 取出并消费执行阶段安装的内容投影器。
      const project = this.contentProjectors.get(exec)
      this.contentProjectors.delete(exec)
      // 投影内容（定义可在 post-execute 之前调整呈现）。
      const content = project?.(exec, result)
      const projected = content === undefined
        ? result
        : this.markCanonical(exec, this.materializeFinalResult({ ...result, content }))
      // 跑 post-execute 策略。
      const postResult = await this.postExecute(exec, projected)
      // 定稿发布；成功但调用方已取消时替换为规范中止结果。
      return this.finish(
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      // 策略/定稿失败：转为错误结果并定稿。
      return this.finish(exec, toolErrorResult(error))
    }
  }

  /**
   * Materialize the candidate, apply definition-owned content finalization,
   * then materialize and notify the authoritative result.
   * @param exec - the prepared execution.
   * @param result - final result.
   * @returns the materialized final result.
   * @internal
   */
  private finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    // 第一步：物化候选结果（失败则物化为错误结果）。
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    // 第二步：应用定义所有的最终内容变换后再物化（同样容错）。
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    // 第三步：通知观察者并返回最终结果。
    this.notifyResult(exec, finalResult)
    return finalResult
  }

  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  // 应用快照下来的定义所有内容变换；只允许替换 content，不暴露其他结果字段。
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const finalizeContent = this.contentFinalizers.get(exec)
    // 无变换：原样返回。
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    // 变换返回 undefined 表示不替换。
    return content === undefined ? result : { ...result, content }
  }

  /** Notify observers without exposing a mutation or error channel into the outcome. */
  // 通知观察者：不向结果结局暴露任何修改或错误通道。
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // Freeze the registry's live object before observers receive its readonly
    // WeakMap-keyable view.
    // 在观察者拿到注册表活对象的只读视图之前先冻结它。
    Object.freeze(exec)
    // 取工具名与调用 id 用于失败告警。
    const { name: toolName, callId } = exec
    // 观察者失败的统一上报（只告警，不影响结果）。
    const reportFailure = (error: unknown): void => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${toolErrorMessage(error)}`)
    }
    // 以 emit 模式派发 tools/result 事件，收集监听器。
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this.tools, exec.agent), 'tools/result', exec, result,
    ])
    // 逐个调用监听器：同步抛错与异步拒绝都只告警。
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel.
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    // 机会式消费审批接缝：未部署审批服务的退化路径。
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return {
        // 无审批通道：退化为拒绝（保留策略给出的理由）。
        decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
        approvalCancelled: false,
      }
    }
    // 无 Agent 的执行同样退化：没有会话可审计、没有 UI 可路由。
    if (exec.agent === undefined) {
      return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
        approvalCancelled: false,
      }
    }
    // 发起审批请求（携带原因与展示原因，随调用信号取消）。
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      ...ask.displayReason !== undefined ? { displayReason: ask.displayReason } : {},
      signal: exec.signal,
    })
    // 审批结局一比一映射。
    switch (outcome) {
      // 单次允许：放行。
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      // 用户拒绝：以可区分的理由拒绝。
      case 'rejected': return {
        decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
        approvalCancelled: false,
      }
      // 审批被取消：拒绝并标记审批通道取消。
      case 'cancelled': return {
        decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
        approvalCancelled: true,
      }
      // 通道不可用：拒绝。
      case 'unavailable': return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContexts`,
   * which are ferried on the returned result for the loop's active-batch FIFO.
   * Context deferred by the tool body survives an accepted result but is
   * discarded when the outer call is blocked; a block exposes only context the
   * blocking decision explicitly supplied.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    // 跑 tools/post-execute 瀑布：缺省决议为 accept。
    const decision = await this.ctx.waterfall(
      scopeTarget(this.tools, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    // 决议附带的上下文。
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      // 阻断：结果转为错误，内容为纠偏反馈，消息从反馈内容推导。
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    // accept 决议不能同时替换 value 与 content。
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
    }
    // 汇总附加上下文：原结果在前、决议在后。
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      // 失败结果的 value 不可替换。
      if (result.isError) {
        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
      }
      // 替换 value：走完整的成功结果管线（重新校验/渲染/物化）。
      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet)
      if (tool === undefined) throw new ToolNotFoundError(exec.name)
      const replaced = this.createSuccessResult(exec, tool, decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    // 普通 accept：可选替换 content，保留其余字段。
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** Registry-normalized results and the exact dispatch that validated each value. */
  // 注册表规范化结果 -> 校验它的那次 dispatch 令牌（防包装层伪造规范结果）。
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  // 把一个注册表规范化结果标记为"仅对其所属 dispatch 规范"。
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** Snapshot, validate, render, and optionally project one successful body value. */
  // 对工具体的一个成功返回值：快照、校验、渲染，并可选投影展示元数据。
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    // 快照分离返回值（非法即报错）。
    const detached = snapshotToolValue(tool.name, candidate)
    // 按输出 schema 校验。
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    // 校验通过：深冻结规范值。
    const value = deepFreeze(detached)
    // 渲染内容块（失败转为规范输出错误）。
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    // 渲染结果也必须无损 JSON。
    const content = snapshotProjection(tool.name, 'render', rendered)
    // 可选的展示元数据投影。
    let meta: JsonValue | undefined
    if (tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    // 工具体是否声明了本轮终结。
    const concludesTurn = this.concludingExecutions.has(exec)
    // 物化并标记规范。
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  // 把 around 包装层写出的结果经所属输出契约规范化。
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    // 已是本 dispatch 的规范结果：直接返回。
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      // 错误结果：只保留契约承认的字段并重新标记规范。
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    // 成功结果：按工具定义重新走校验/渲染管线。
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined, exec.toolSet)
    if (tool === undefined) throw new ToolNotFoundError(exec.name)
    const normalized = this.createSuccessResult(exec, tool, result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  // 在 tools/result 之前一次性物化权威的提交结局。
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    // 先抽取呈现字段。
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      // 错误结果：快照 + 冻结。
      return materializePresentation({ isError: true as const, error: result.error, ...presentation })
    }
    // 成功结果：先物化除 value 外的部分。
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    // value 原样并入后整体冻结（value 已在 createSuccessResult 冻结过）。
    return deepFreeze({ ...detached, value: result.value })
  }
}

/** Convert one projector exception into the canonical invalid-output failure. */
// 把投影器异常转换成规范的非法输出失败。
function projectionError(toolName: string, projector: 'render' | 'presentationMeta', error: unknown): ToolOutputError {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${toolErrorMessage(error)}`])
}

/** Snapshot one projector result before later durable-result materialization. */
// 在后续持久结果物化之前快照一个投影结果。
function snapshotProjection<T>(toolName: string, projector: 'render' | 'presentationMeta', candidate: T): T {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) {
      // 投影返回了非无损 JSON：报规范错误。
      throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
    }
    return detached
  } catch (error: unknown) {
    // 已是规范错误：原样抛；否则包装为投影错误。
    if (error instanceof ToolOutputError) throw error
    throw projectionError(toolName, projector, error)
  }
}

/** Snapshot one body or policy value into the canonical invalid-output failure class. */
// 把工具体或策略的值快照进规范的非法输出错误类。
function snapshotToolValue(toolName: string, candidate: unknown): JsonValue {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
    return detached as JsonValue
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(toolName, [`value snapshot failed: ${toolErrorMessage(error)}`])
  }
}

/**
 * Best-effort human-readable message from an arbitrary thrown value: Error
 * instances use `.message`; non-Error objects with a string `message`
 * property (e.g. `throw { message: 'denied' }`) use it too; everything else
 * is stringified.
 * @param error - thrown value from a tool or policy callback.
 * @returns a printable failure message, including for hostile thrown values.
 */
export function toolErrorMessage(error: unknown): string {
  try {
    // Error 实例：取 message。
    if (error instanceof Error) return error.message
    // 带 string message 属性的非 Error 对象（如 throw { message: 'denied' }）：同样取用。
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    // 其余：字符串化。
    return String(error)
  } catch {
    // A hostile thrown value can trap `instanceof`, property access, or string
    // coercion. Error normalization is the outermost safety boundary, so its
    // fallback must itself be total.
    // 敌意抛出值可以陷死 instanceof、属性访问或字符串强制转换。
    // 错误规整是最外层安全边界，其回退自身必须全函数化。
    return '<unprintable thrown value>'
  }
}

/** Derive one failure message from policy feedback without changing its rendered blocks. */
// 从策略反馈内容推导失败消息：不改动其渲染块本身。
function failureMessageFromContent(content: ContentBlock[]): string {
  // 文本块取文本，其余块以占位标注。
  const text = content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  // 全空时给固定兜底消息。
  return text.length > 0 ? text : 'tool result blocked by post-execute policy'
}

/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
// 快照并冻结一个持久工具结果投影；有损数据直接拒绝。
function materializePresentation<T>(candidate: T): T {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    throw new TypeError('tool result must be losslessly JSON-serializable')
  }
  return deepFreeze(detached)
}

/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
// HarnessError -> 结构化 { name, code }；其余返回 undefined（连 instanceof 都容住）。
function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof HarnessError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

/** Mint a same-process correlation token whose identity is its value. */
// 铸造同进程关联令牌：符号的身份即其值。
function createExecutionToken(): ToolExecutionToken {
  return Symbol('dsh.tool.execution') as ToolExecutionToken
}

// 任意抛出值 -> 规范错误结果（文本块带 Error: 前缀）。
function toolErrorResult(error: unknown): ToolExecutionResult {
  const info = errorInfo(error)
  const message = toolErrorMessage(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...info ? { info } : {} },
  }
}

/** Read live abort state across an await without treating it as synchronously immutable. */
// 跨 await 读取活的中止状态：经函数调用以避免被当作同步不变量收窄。
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
 * Keeping the relay dispatch-scoped also removes listeners when work settles.
 */
// 融合调用方与包装层取消，不嵌套 AbortSignal.any（避免随分发累积监听器）。
// 中继保持分发作用域：工作落定即移除监听器。
function fuseToolSignals(caller: AbortSignal, wrapper: AbortSignal): FusedToolSignal {
  // 同一信号：无需融合。
  if (caller === wrapper) return { signal: caller, dispose() {} }

  // 融合输出的控制器。
  const controller = new AbortController()
  // 是否正在监听（dispose 幂等的依据）。
  let listening = false
  // 清理：移除两个方向的监听。
  const dispose = (): void => {
    if (!listening) return
    listening = false
    caller.removeEventListener('abort', abortFromCaller)
    wrapper.removeEventListener('abort', abortFromWrapper)
  }
  // 任一来源触发：以该来源的原因中止融合信号并自清理。
  const abortFrom = (source: AbortSignal): void => {
    const reason: unknown = source.reason
    controller.abort(reason)
    dispose()
  }
  const abortFromCaller = (): void => { abortFrom(caller) }
  const abortFromWrapper = (): void => { abortFrom(wrapper) }

  // 已处于中止状态：立即同步触发（先包装层后调用方，保留真实原因）。
  if (wrapper.aborted) abortFromWrapper()
  else if (caller.aborted) abortFromCaller()
  else {
    // 双向注册一次性监听。
    listening = true
    caller.addEventListener('abort', abortFromCaller, { once: true })
    wrapper.addEventListener('abort', abortFromWrapper, { once: true })
  }
  return { signal: controller.signal, dispose }
}

/** Canonical result when cancellation supersedes success after body invocation. */
// 工具体启动之后取消压过成功的规范结果。
function toolAbortedResult(prior?: ToolExecutionResult): ToolExecutionResult {
  // 保留先前的附加上下文。
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    isError: true,
    error: {
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

/** Canonical result when cancellation prevents tool body invocation. */
// 取消阻止工具体启动的规范结果（独立错误码）。
function toolAbortedBeforeDispatchResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

// 原样转发批量执行入口。
export { executeToolBatch } from './batch.ts'
