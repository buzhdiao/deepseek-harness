// 模块说明：远端贡献装配的 Host BFF（后端即前端）入口与 Loader 壳。
/** Host BFF entry and Loader shell for the Remote contribution assembly. */

// 读取用户主目录：注册远端事件源时作为 home 提示传入。
import { homedir } from 'node:os'
// Cordis 的 Context（上下文）类型。
import type { Context } from '@deepseek-ai/cordis'
// Agent（代理）类型：瀑布转发时校验请求携带的 Agent。
import type { Agent } from '@deepseek-ai/dsh-agent'
// 网关的远端事件源契约类型：分发帧、调用描述、结果与源本身。
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
// Deque（双端队列）：事件队列的底层缓冲。
import { Deque } from '@deepseek-ai/dsh-deque'
// carrierKeyOf：从监听器 this 上提取载体（carrier）对应的 Agent。
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
// JSON 值判定与类型：校验事件实参是否为无损 JSON 数据。
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
// 本应用的转发事件白名单常量。
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The owner packages' client-safe `./types` exports carry the cordis `Events`
// declarations for every allowlisted event. Pulling them into this face is what
// makes the shape assertion below judge real signatures rather than an empty
// event vocabulary.
// 以下空类型导入把各拥有包的客户端安全 `./types` 引入本编译面，
// 它们携带白名单内每个事件的 cordis `Events` 声明，使下方的形状断言
// 判定的是真实签名而不是空的事件词汇表。
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-web/types'
// 会话控制器的事件类型面同时作为导出，供消费方引用。
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

// 转发事件白名单常量与其类型投影的对外导出。
export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

// 所需的 Host 服务：物理远端流复用器（mux）由网关（Gateway）拥有。
/** Required Host service: the Gateway owns the physical Remote stream mux. */
export const inject = ['typertGateway']

// Host 插件主体：登记本应用选定的 Cordis 事件源。
/** Host plugin body registering this application's selected Cordis event source. */
export function apply(ctx: Context): void {
  // 注册效果：把远端事件源登记到 Typert 网关，并随纤程卸载自动注销。
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }),
    // 效果标签：用于诊断。
    'api-remotes: forwarded Cordis event source',
  )
}

// 创建注册到网关的唯一队列与监听器集合。
/** Create the sole queue and listener set consumed by the registered Gateway. */
function remoteEventSource(ctx: Context): TypertRemoteEventSource {
  // 返回事件源工厂：网关以信号调用它获取事件迭代器。
  return (signal) => {
    // 本世代的事件队列。
    const queue = new RemoteEventQueue()
    // 为白名单内每个事件订阅 Cordis 监听器，收集各自的注销函数。
    const disposers = API_REMOTE_FORWARDED_EVENTS.map((entry) => {
      // 取出事件名与转发模式。
      const { event, mode } = entry
      // emit 模式：直发通知，无需逐级裁决。
      if (mode === 'emit') {
        // 白名单条目声明的资源提取函数（若有）。
        const resources = 'resources' in entry ? entry.resources : undefined
        // 订阅普通监听器：实参经 JSON 校验后入队，附带资源信息。
        return ctx.on(event as never, ((...args: unknown[]) => {
          queue.push({ event, args: assertJsonArgs(event, args), ...resources === undefined ? {} : { resources } })
        }) as never)
      }
      // waterfall 模式：订阅带 next 的逐级监听器，需要把请求转发到远端并等待结果。
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        // 从监听器 this 上提取载体对应的 Agent。
        const carrierAgent = carrierKeyOf(this)
        // 没有 Agent 载体：本地直接放行到下一级。
        if (carrierAgent === undefined) return next()
        // 取请求中携带的 Agent。
        const agent = (request as { readonly agent?: Agent }).agent
        // 请求必须直接携带与载体一致的 Agent，否则转发无法继续。
        if (agent === undefined || agent !== carrierAgent) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`)
        }
        // 通过网关把瀑布请求转发出去，等待远端结果或本地 next。
        return forwardWaterfall(
          queue,
          event,
          request,
          // 调用上下文：携带代理的值、主体与 id。
          { value: agent.ctx, subject: agent, agentId: agent.id },
          next,
        )
      }) as never)
    })
    // 返回队列迭代器：中止信号到来时注销全部监听器。
    return queue.iterate(signal, () => {
      for (const dispose of disposers) dispose()
    })
  }
}

// 拉取驱动（pull-driven）队列：把同步的 Cordis 监听器桥接成 AsyncIterable。
/** One pull-driven queue bridging synchronous Cordis listeners to an AsyncIterable. */
class RemoteEventQueue {
  // 待分发的事件缓冲。
  private readonly buffer = new Deque<TypertRemoteEventDispatch>()
  // 等待新事件的迭代器的唤醒回调。
  private waiter: (() => void) | undefined
  // 队列是否已终结：终结后不再接受新事件。
  private done = false

  // 推入一帧待分发事件；已终结则丢弃并返回 false。
  push(frame: TypertRemoteEventDispatch): boolean {
    // 已终结：不再接受。
    if (this.done) return false
    // 入队尾部。
    this.buffer.pushBack(frame)
    // 唤醒等待中的迭代器。
    this.waiter?.()
    // 接受成功。
    return true
  }

  // 以给定原因终结队列：拒绝所有仍挂起的瀑布调用并唤醒等待者。
  private end(reason: unknown): void {
    // 幂等：已终结则返回。
    if (this.done) return
    // 标记终结。
    this.done = true
    // 排空缓冲：带 context 的是瀑布调用，逐个以原因拒绝。
    while (this.buffer.size > 0) {
      const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
      if ('context' in dispatch) dispatch.reject(reason)
    }
    // 唤醒等待中的迭代器使其退出。
    this.waiter?.()
  }

  // 迭代器主体：产出队列中的事件，直到终结或取消。
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<TypertRemoteEventDispatch> {
    // 中止处理器：以信号原因终结队列。
    const abort = (): void => { this.end(remoteEventSourceEndReason(signal)) }
    // 注册一次性 abort 监听。
    signal.addEventListener('abort', abort, { once: true })
    try {
      // 主循环：缓冲有货就产出，没有就挂起等待。
      while (true) {
        // 已终结或已取消：结束迭代。
        if (this.done || signal.aborted) return
        // 先排空缓冲。
        while (this.buffer.size > 0) yield this.buffer.popFront() as TypertRemoteEventDispatch
        // 挂起等待下一次 push 唤醒。
        await new Promise<void>((resolve) => { this.waiter = resolve })
        // 唤醒后清空登记，避免悬挂引用。
        this.waiter = undefined
      }
    } finally {
      // 收尾：移除监听、终结队列（拒绝残留调用）并执行监听器清理。
      signal.removeEventListener('abort', abort)
      this.end(remoteEventSourceEndReason(signal))
      cleanup()
    }
  }
}

// 把事件源的关闭归一化为待决 Host 瀑布调用的终结原因。
/**
 * Normalize an event-source shutdown for pending Host waterfalls.
 * @param signal - source lifetime whose reason wins after cancellation.
 * @returns the cancellation reason or an unexpected-end failure.
 */
function remoteEventSourceEndReason(signal: AbortSignal): unknown {
  // 因取消而关闭：采用信号携带的原因。
  if (signal.aborted) return signal.reason
  // 非取消的意外结束：包装为错误。
  return new Error('api-remotes: forwarded Remote event source ended')
}

// 把一个 Cordis 瀑布监听器桥接到网关持有的待决事件上。
/** Bridge one Cordis waterfall listener through the Gateway-owned pending event. */
function forwardWaterfall(
  queue: RemoteEventQueue,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  // 创建可手动裁决的 Promise：等待远端结果或本地 next。
  const settled = Promise.withResolvers<unknown>()
  // 组装网关调用描述：事件、请求、上下文与裁决回调。
  const dispatch: TypertRemoteEventInvocation = {
    // 事件名。
    event,
    // 原始请求对象。
    request,
    // 调用上下文（Agent 信息）。
    context,
    // 远端结果回调：result 直接裁决；非 result（如 pass）则在本地继续 next。
    resolve: (outcome: TypertRemoteEventOutcome) => {
      // 远端已给出结果：直接裁决。
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      // 远端未裁决：异步执行本地 next，以其结果裁决。
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    // 远端拒绝：原样传导。
    reject: settled.reject,
  }
  // 入队失败（队列已终结）：立即回退到本地 next。
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  // 返回挂起的裁决 Promise。
  return settled.promise
}

// 校验白名单事件的运行时实参全部是无损 JSON 数据，否则拒绝转发。
/** Reject an allowlisted event whose runtime arguments are not lossless JSON data. */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  // 逐个实参检查。
  for (const [index, arg] of args.entries()) {
    // 不是无损 JSON：报错并指出事件与实参位置。
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  // 全部通过：以 JSON 值类型返回。
  return args as JsonValue[]
}
