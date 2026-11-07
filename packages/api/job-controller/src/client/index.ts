// Job Controller 的客户端(client)半边：在生成的 `job` Remote 命名空间之上安装 `ctx.jobs`（名册(roster)、观测(observations)与人工终止(kill)）。
// 插件必须在自己上下文仍处于当前态时解析它驱动的两个 Remote 面，因为流的(重新)打开运行在调用方栈上——React 事件、载体(carrier)重试——
// 而那些栈的动态上下文未必声明过 `remote.job`。
/**
 * Job Controller client half: installs `ctx.jobs` (rosters, observations, and
 * the human kill) over the generated `job` Remote namespace. The plugin resolves both Remote faces it drives while its
 * own context is current, because stream (re)opens run on caller stacks — a
 * React event, a carrier retry — whose dynamic context has not declared
 * `remote.job`.
 * @module @deepseek-ai/dsh-api-job-controller/client
 */

// 引入 Cordis 的 Context 类型，作为 apply 的根上下文参数。
import type { Context } from '@deepseek-ai/cordis'
// 仅类型的副作用导入：把生成的 `job` Remote 命名空间声明并入编译，`remote.job` 的类型由此可用。
import type {} from '@deepseek-ai/dsh-api-job-controller/remote'
// 引入客户端任务状态模型：纯数据与订阅，不含传输接线。
import { ClientJobsModel } from './model.ts'
// 引入客户端任务服务：负责传输与流的生命周期接线。
import { ClientJobs } from './service.ts'

// 透出模型的两个视图类型：整体快照(snapshot)与单个被观测任务的实时视图。
export type { JobsSnapshot, ObservedJob } from './model.ts'
// `ctx.jobs` 的契约类型。其所在模块还带有声明 `ctx.jobs` 的 Context 类型扩充，
// 消费者只能经由这个导出拿到它：声明产物(d.ts)会丢弃上面的值导入。
// The `ctx.jobs` contract. Its module also carries the Context augmentation
// that declares `ctx.jobs`, which reaches consumers only through this export:
// declaration emit drops the value import above.
export type { IJobs } from './service.ts'
// 透出线上帧与请求等传输层类型，供 UI 组件与宿主代码使用。
export type {
  JobChunk, JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest, JobView,
} from '../types.ts'

/** Required Client Remote services. */
// 声明插件依赖：客户端 Remote 服务本体，以及生成的 `job` 命名空间。
export const inject = ['remote', 'remote.job']

/**
 * Install the client jobs service.
 * @param ctx - Client root Context.
 */
// 安装客户端任务服务。
export function apply(ctx: Context): void {
  // Read the namespace now, not inside `open`: see the module JSDoc.
  // 现在就读取命名空间，而不是推迟到 `open` 内部：原因见模块头部的 JSDoc。
  const { remote } = ctx
  // 取出 `job` 命名空间引用，随后与服务一起交给 ClientJobs。
  const { job } = remote
  // 创建服务实例：接入 Remote 流工厂（经 `remote.$stream`）、`job` 命名空间与状态模型；随 ctx 生命周期自动启停。
  new ClientJobs(ctx, { $stream: options => remote.$stream(options), job }, new ClientJobsModel())
}
