// 模块说明：控制器的已归档 Session 准入门（admission gate）——已归档的 Session
// 或其子代理后代在恢复之前不得运行模型步骤。Session 仍在运行的工作由其拥有方
// （Agent 注册表 `turn`、任务注册表接缝 `job`、子代理运行时 `subagent`、
// 计划任务插件 `schedule`）经 Workspace 注册表的归档准入事件上报并停止。
// 子代理运行时还会在每一步之前检查其保留的谱系，因此一个已释放的中间 Session
// 无法藏匿一个已归档的祖先。
/**
 * The controller's admission gate for archived Sessions: an archived
 * Session, or a subagent descendant of one, must not run a model step until
 * it is restored. The work a Session still runs is reported and stopped by
 * its owners — the Agent registry (`turn`), the job registry seam (`job`),
 * the Subagent runtime (`subagent`), and the Schedule plugin (`schedule`) —
 * through the Workspace registry's archive-admission events. The Subagent
 * runtime also checks its retained ancestry before each step, so a released
 * intermediate Session cannot hide an archived ancestor.
 */

// Cordis 框架类型：Context（宿主上下文）与 Plugin（插件声明）。
import type { Context, Plugin } from '@deepseek-ai/cordis'
// Agent（代理）类型：提出模型步骤的主体。
import type { Agent } from '@deepseek-ai/dsh-agent'
// SessionId（会话 id）类型：用于已访问集合的元素类型。
import type { SessionId } from '@deepseek-ai/dsh-session'
// 空类型导入：引入 Workspace 注册表的模块扩充（archivedSessionIds 字段与归档准入事件）。
import type {} from '@deepseek-ai/dsh-workspace'

// 归档会话准入门（admission gate），以插件形式挂到 `ctx.plugin(...)`：
// 等 Agent 注册表、Session 存储与 Workspace 注册表就绪后加载，并随插件纤程一起卸载。
// 对已归档 Session 的迟到投递——子代理结算、排队中的后续追问——会提议一个步骤，
// 该门将其拒绝，循环以 `blocked` 结束且不发请求；解除归档即对整个谱系放行。
/**
 * The gate as a plugin for `ctx.plugin(...)`: it loads once the Agent
 * registry, Session store, and Workspace registry are available and unwinds
 * with the plugin's fiber. A late waking delivery to an archived Session — a
 * subagent settlement, a queued follow-up — proposes a step the gate rejects,
 * which the loop ends as `blocked` without a request; unarchiving lifts the
 * gate for the whole lineage.
 */
export const ArchivedSessionGate: Plugin.Object<void> = {
  // 插件名：用于 Cordis 的依赖解析与诊断。
  name: 'archived-session-gate',
  // 声明依赖：agents（Agent 注册表）、sessions（Session 存储）、workspaceRegistry（Workspace 注册表）。
  inject: ['agents', 'sessions', 'workspaceRegistry'],
  // 插件装配入口：在依赖就绪后执行一次。
  apply(ctx: Context): void {
    // 订阅 agent/pre-step（模型步骤前置检查）：若该 Agent 处于已归档会话之下则拒绝（reject），
    // 否则放行调用 next() 进入正常前置流程。
    ctx.on('agent/pre-step', (payload, next) =>
      underArchivedSession(ctx, payload.agent)
        ? Promise.resolve({ kind: 'reject' as const })
        : next())
  },
}

// 判断该 Agent 的会话本身、或其子代理（subagent）谱系上游的任一会话是否已归档。
// 这个仅凭头部（header）的检查只在“源自子代理”的会话上追溯持久化字段：
// 归档会话的一个 fork 是独立对话，不会被连带。当中间会话在本处不可得时，
// 由子代理运行时另行检查其托管谱系。
/**
 * Whether the Agent's Session, or a Session above it in its subagent lineage,
 * is archived. This header-only check follows the durable fields through
 * subagent-origin Sessions only: a fork of an archived Session is an
 * independent conversation. The Subagent runtime separately checks managed
 * ancestry when an intermediate Session is unavailable here.
 * @param ctx - Host context.
 * @param agent - the Agent proposing a step.
 * @returns whether an archived Session owns the step.
 */
export function underArchivedSession(ctx: Context, agent: Agent): boolean {
  // 取当前归档会话 id 列表（Workspace 注册表维护的权威清单）。
  const archived = ctx.workspaceRegistry.archivedSessionIds
  // 从 Agent 当前会话的头部开始向上追溯。
  let header = agent.session.header
  // 已访问集合：防止谱系出现环时死循环。
  const visited = new Set<SessionId>()
  // 逐层向上检查，直到遇到已访问过的会话为止。
  while (!visited.has(header.id)) {
    // 当前会话在归档清单中：整条谱系被门禁拦截。
    if (archived.includes(header.id)) return true
    // 标记当前会话已访问。
    visited.add(header.id)
    // 非子代理来源、或没有父会话：到达谱系顶端仍未命中，返回未归档。
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    // 尝试从 Session 存储中取父会话，继续向上。
    const parent = ctx.sessions.get(header.parentSession)
    // 父会话不在存储中（可能未加载）：退而依据头部记录的父会话 id 是否被归档。
    if (parent === undefined) return archived.includes(header.parentSession)
    // 父会话可用：把游标上移到父会话头部。
    header = parent.header
  }
  // 谱系成环（已被访问集合截断）：按未归档处理。
  return false
}
