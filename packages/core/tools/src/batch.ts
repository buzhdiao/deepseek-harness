// 模块说明：一个助手步的工具调用批次调度器——模型给出的一批工具调用在这里
// 排队执行。关键设计：
// 1. 独占调用形成屏障；并行调用使用有界滚动池，启动前重新分类
//    （注册表变化可以随时把并行调用翻转为屏障）；
// 2. 只有 dispatch/工具体可以并发，策略、结果与结果上下文保持模型顺序提交
//    （队首游标逐格推进）；
// 3. 取消语义：abort 停止补池、排空已启动调用，并为跳过的调用记录合成错误
//    结果（保证日志重放有效）；调度器自身失败在排空后拒绝，
//    由属主步记录保守恢复结果。
/**
 * Schedules one assistant step's tool calls. Exclusive calls form barriers;
 * parallel calls use a bounded rolling pool and are reclassified before start.
 * Dispatch may overlap, while policy, results, and result context remain
 * model-ordered. Abort or an internal scheduler failure stops replenishment
 * and drains started calls.
 *
 * Abort records synthetic error results for skipped calls so replay stays
 * valid. A terminal scheduler failure rejects after draining; the owning step
 * records conservative recovery results before closing.
 * @module dsh-tools/batch
 */

// 批量执行错误与输入/结果/调用结果类型。
import { ToolBatchExecutionError } from './executor.ts'
// "分发前中止"错误码（跳过调用的合成结果用）。
import { TOOL_ABORTED_BEFORE_DISPATCH } from './contracts.ts'
import type { ToolBatchInput, ToolBatchResult, ToolCallResult } from './executor.ts'
// 工具结果消息构造器与工具调用块类型。
import { createToolResultMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
// 会话序号与用户消息类型。
import type { SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
// 调度器需要的契约类型。
import type { ToolExecutionInput, ToolExecutionMode, ToolExecutionResult, ToolRunContext } from './contracts.ts'
// 分发产出与共享管线。
import type { ScheduledToolDispatch, ToolExecutionPipeline } from './pipeline.ts'
// 穷尽断言。
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** One tool call after argument parsing, ready to schedule. */
// 参数解析后的单条调用，随时可调度。
interface PlannedCall {
  // 原始调用块（id/名/参数文本）。
  block: ToolCallBlock
  // 组装好的执行输入。
  exec: ToolExecutionInput
}

/** Settled dispatch awaiting model-order finalization. */
// 已落定的分发：等待按模型顺序收尾。
type Slot = ScheduledToolDispatch & { exec: ToolRunContext }

/** One scheduler group outcome, including a drained cancellation. */
// 一个调度组的结局（含被排空的取消）。
interface GroupOutcome {
  // 消耗掉的调用数（被本组提交的）。
  consumed: number
  // 是否因取消而中止。
  aborted: boolean
  /** Whether any committed result carried {@link ToolExecutionResult.concludesTurn}. */
  // 是否有已提交结果携带 concludesTurn。
  concluded: boolean
}

/**
 * Execute raw calls with ordered policy and results around overlapping tool bodies.
 * Abort drains started calls and synthesizes results for skipped calls. Internal
 * failures drain before rejecting with the already committed results and context.
 * @param input - raw calls, optional concurrency override, and optional Session owner.
 * @param pipeline - executor-owned invocation implementation.
 * @param maxParallel - reads the executor's current validated limit when input has no override.
 * @returns model-ordered outcomes after every started body has settled.
 * @throws RangeError when the explicit concurrency override is not a positive integer.
 */
export async function executeToolBatch(
  input: ToolBatchInput,
  pipeline: ToolExecutionPipeline,
  maxParallel: () => number,
): Promise<ToolBatchResult> {
  // 解构输入：调用列表、信号、属主、步准入与并行度覆盖。
  const { calls: toolCalls, signal, agent, toolSet, maxParallelToolCalls } = input
  if (maxParallelToolCalls !== undefined && (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1)) {
    // 显式并行度覆盖必须是正整数。
    throw new RangeError('maxParallelToolCalls must be a positive integer')
  }
  // 落账器：收集结果与上下文。
  const settlement = new BatchSettlement(input)
  try {
    // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
    // 每条调用独立组输入（tools/execute 包装层可能替换 exec.signal）。
    const planned: PlannedCall[] = toolCalls.map(block => ({
      block,
      exec: {
        callId: block.id,
        name: block.name,
        // 参数文本解析（畸形 JSON 原样保留给工具自己报错）。
        arguments: parseArguments(block.arguments),
        ...agent === undefined ? {} : { agent },
        ...toolSet === undefined ? {} : { toolSet },
        signal,
      },
    }))

    // 组游标。
    let next = 0
    // 是否有结果声明轮次终结。
    let concluded = false
    while (next < planned.length) {
      // Commit before classifying again so registry changes affect unstarted calls.
      // 先提交再重新分类：注册表变化能影响未启动的调用。
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const first = planned[next]!
      // 队首分类决定本组形态。
      const mode = pipeline.executionMode(first.exec).kind
      // 并行组收下剩余全部候选（组内启动前还会再分类），独占组只收队首。
      const group = mode === 'parallel' ? planned.slice(next) : [first]
      // 跑这一组。
      const outcome = await runGroup(
        pipeline, settlement, maxParallelToolCalls ?? maxParallel(), group, mode, signal,
      )
      // 推进游标并合并终结标记。
      next += outcome.consumed
      concluded ||= outcome.concluded
      if (outcome.aborted) {
        // 取消：剩余调用记合成跳过结果并结束。
        for (const call of planned.slice(next)) settlement.skip(call.block)
        return settlement.result(concluded)
      }
    }
    // 全部提交完毕。
    return settlement.result(concluded)
  } catch (error: unknown) {
    // 内部失败：携带已提交结果包装为批量执行错误。
    throw new ToolBatchExecutionError(error, settlement.result())
  }
}

/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
// 解析模型参数：空输入映射为 {}；非法 JSON 原样保留为文本。
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch (_error: unknown) {
    // Preserve malformed model input for tool-owned argument diagnostics.
    // 保留畸形的模型输入，交给工具自己的参数诊断处理。
    return raw
  }
}

/**
 * Run one exclusive barrier or parallel pool. Later calls are reclassified
 * before start; an exclusive reclassification waits for the current pool to
 * drain and remains for the caller's next barrier. Results and contexts commit
 * in model order. Abort stops starts, drains and commits started calls, accepts
 * their contexts into the owning batch, records results for skipped calls, and
 * returns an aborted outcome. Scheduler failure drains dispatches and rejects
 * for the owning step to record recovery results.
 */
async function runGroup(
  pipeline: ToolExecutionPipeline,
  settlement: BatchSettlement,
  maxParallelToolCalls: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
): Promise<GroupOutcome> {
  // 每个组员的落定槽位。
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // Started slots retain their `tool/call` seq so the result can cite it.
  // 已启动槽位保留其 tool/call 事件序号，结果用它作源引用。
  const callSeqs: Array<SessionSeq | undefined> = group.map(() => undefined)
  // 下一个待启动下标。
  let nextToStart = 0
  // 队首游标：只沿连续的模型顺序槽位推进。
  let committed = 0
  // 已启动数。
  let started = 0
  // 取消标记（初始读一次信号）。
  let aborted: boolean = signal.aborted
  // 终结标记。
  let concluded = false
  // 调度器失败槽位（首个错误保留）。
  let schedulerFailure: { error: unknown } | undefined
  // 有失败就抛出。
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // `committed` advances only across contiguous model-order slots.
  // `committed` 只沿连续的模型顺序槽位推进。
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      // 队首槽位未落定：停下。
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      // 按序执行完成管线（post-execute 等）。
      const result = await pipeline.complete(slot.exec, slot)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      // 落账结果（携带源调用序号）。
      settlement.commit(call!.block, result, callSeqs[committed])
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  // 在途分发池：下标 -> 完成 promise。
  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    // 记录 tool/call 事件并推进已启动数。
    callSeqs[index] = settlement.start(call.block)
    started++
    // 有序 prepare（预执行/守卫/审批）。
    const prepared = await pipeline.prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        // 正常分发：dispatch 允许并发；落定写入槽位，失败记调度器失败。
        const promise = pipeline.dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { ...outcome, exec: prepared.exec }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        // 加入在途池。
        inFlight.set(index, promise)
        break
      }
      // 立即结果：直接占槽。
      case 'post-result':
      case 'final-result':
        slots[index] = prepared
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  // 补池：在并行度上限内尽量启动组内后续调用。
  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // Re-read later modes after ordered commits so registry changes can create a barrier.
      // 在有序提交之后重读后续分类：注册表变化可以随时造出屏障。
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && pipeline.executionMode(nextCall.exec).kind !== 'parallel') break
      // 启动下一个调用。
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      // 每次启动后尝试推进队首提交。
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while pre-execute awaits.
      // 预执行 await 期间可能到达取消。
      if (signal.aborted) aborted = true
    }
  }

  // Ordered pre-execute may await; only dispatch/body overlaps. A scheduler
  // failure stops new dispatches and reaches the turn boundary after every
  // already-started dispatch settles.
  // 有序预执行可以 await；只有 dispatch/工具体并发。
  // 调度器失败会停止新分发，并在每个已启动分发落定后才到达轮次边界。
  try {
    // 先补满池。
    await fillPool()
    while (inFlight.size > 0) {
      // 等任意一个在途分发落定。
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      // 每次落定后尝试推进提交。
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while a tool or ordered commit awaits.

      // 工具体或有序提交 await 期间也可能到达取消。
      if (signal.aborted) aborted = true
      // 补池继续。
      await fillPool()
    }
  } catch (error: unknown) {
    // 失败：记录、等全部在途落定、再抛出（排空后拒绝）。
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // Started calls and accepted context settle first; every remaining model
    // call then receives an ordered synthetic result before the turn aborts.
    // 已启动调用与接受的上下文先落定；随后每个剩余模型调用
    // 在轮次中止前拿到有序的合成结果。
    for (const call of group.slice(started)) settlement.skip(call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  // 正常结束：消耗已启动数（全部已提交）。
  return { consumed: started, aborted: false, concluded }
}

/** Collect committed results and optionally append their durable Session events. */
// 落账器：收集已提交结果，并按需追加持久的会话事件。
class BatchSettlement {
  // 已提交结果。
  private readonly results: ToolCallResult[] = []
  // 接受的附加上下文。
  private readonly contexts: UserMessage[] = []

  // 构造：保存批次输入（含可选的日志位置）。
  constructor(private readonly input: ToolBatchInput) {}

  start(block: ToolCallBlock): SessionSeq | undefined {
    // 未要求日志：不落盘。
    if (this.input.log === undefined) return undefined
    const { agent, log: { turn, step } } = this.input
    // oxlint-disable-next-line typescript/no-non-null-assertion -- ToolBatchInput requires agent whenever log is provided
    // 追加 tool/call 事件并返回其序号。
    return agent!.session.append('tool/call', {
      turn, step, callId: block.id, name: block.name, arguments: block.arguments,
    }).seq
  }

  commit(block: ToolCallBlock, result: ToolExecutionResult, callSeq: SessionSeq | undefined): void {
    if (this.input.log !== undefined) {
      const { agent, log: { turn, step } } = this.input
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ToolBatchInput requires agent whenever log is provided
      // 追加 tool/result 事件（引用源 tool/call 序号）。
      agent!.session.append('tool/result', {
        turn, step,
        message: createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError }),
        ...result.error?.info ? { error: result.error.info } : {},
        ...result.meta !== undefined ? { meta: result.meta } : {},
      }, {
        surfaceOp: 'append',
        // oxlint-disable-next-line typescript/no-non-null-assertion -- start records a call seq whenever this batch logs results
        sourceEventSeqs: [callSeq!],
      })
    }
    // 结果与上下文入账。
    this.results.push({ callId: block.id, result })
    this.contexts.push(...result.additionalContexts ?? [])
  }

  skip(block: ToolCallBlock): void {
    // 跳过：以"分发前中止"合成错误结果落账。
    this.commit(block, {
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
      error: {
        message: 'tool call aborted before dispatch',
        info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    }, this.start(block))
  }

  result(concluded = this.results.some(({ result }) => result.concludesTurn === true)): ToolBatchResult {
    // 汇总批次结果（终结标记缺省从结果推导）。
    return { results: this.results, additionalContexts: this.contexts, concluded }
  }
}
