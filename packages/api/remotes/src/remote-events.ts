// 模块说明：本应用“转发 Host 事件白名单”（forwarded-Host-event allowlist）的唯一定义处。
// 两个编译面（Host 转发循环与消费端 `ctx.remote.$on` 的键面）都引用本文件，
// 从而共享同一份声明而不是两份可能漂移的副本；`./types.ts` 由此派生类型投影并保持纯类型。
/**
 * The one home of this application's forwarded-Host-event allowlist. Both
 * compiler faces list this file, so the Host forwarding loop and the consumer
 * `ctx.remote.$on` key face read one declaration instead of two copies that
 * could drift; `./types.ts` derives the type projection from it and stays
 * type-only.
 */

// 引入会话控制器的远端事件声明，确保其模块扩充（事件名类型）参与联合推断。
import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
// 引入 SessionId（会话 id）类型，供下面资源提取函数的返回值标注使用。
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 以下空类型导入（import type {}）只为把对应包的模块扩充纳入类型检查，
// 让其各自转发的 Host 事件名进入本文件可引用的事件键面。
import type {} from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-schedule/client'
// 引入 Typert 协议的“可转发事件条目”类型，用于下方数组结构的编译期校验。
import type { TypertForwardableEventEntry } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-web/types'

// 转发白名单本体：数组各行为 `{ event, mode, resources? }` 条目，
// 整体以 as const 收窄字面量并用 satisfies 校验其符合 TypertForwardableEventEntry 结构。
/**
 * Host events this application forwards without renaming. The explicit mode is
 * both the Host dispatch strategy and the legal key set of `ctx.remote.$on`.
 * An `emit` entry declares readers of the resources its payload carries, or
 * none to touch the built-in `global` resource; it reaches a non-owner Peer
 * only when access control allows it. Each notification names one resource
 * identity or none, and collection changes travel on follow streams instead.
 */
export const API_REMOTE_FORWARDED_EVENTS = [
  // Agent 预设被选中：emit 模式，Host 端更名为原名直发。
  { event: 'agent-preset/selected', mode: 'emit' },
  // 审批请求：waterfall（瀑布）模式，需要逐级向下请求决策。
  { event: 'approval/request', mode: 'waterfall' },
  // API 会话活动：emit；resources 声明事件载荷触及的会话资源（直接以参数作会话 id）。
  { event: 'api-session/activity', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  // 新增 API 会话：emit；会话资源从摘要（summary）中提取。
  { event: 'api-session/added', mode: 'emit', resources: { session: (summary): SessionId => summary.sessionId } },
  // API 会话出错：emit；资源为出错会话 id。
  { event: 'api-session/error', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  // 移除 API 会话：emit；资源为被移除的会话 id。
  { event: 'api-session/removed', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  // API 会话状态变化：emit；资源为状态变化的会话 id。
  { event: 'api-session/status', mode: 'emit', resources: { session: (sessionId): SessionId => sessionId } },
  // 命令（commands）集合变化：emit，不声明资源，触及内建 global 资源。
  { event: 'commands/change', mode: 'emit' },
  // DeepSeek 账号会话过期：emit。
  { event: 'deepseek-account/session-expired', mode: 'emit' },
  // DeepSeek 账号需要模型登录：emit。
  { event: 'deepseek-account/model-sign-in-required', mode: 'emit' },
  // 凭据记录更新：emit。
  { event: 'credentials/record-updated', mode: 'emit' },
  // 凭据引用更新：emit。
  { event: 'credentials/reference-updated', mode: 'emit' },
  // 目标（goal）激活状态变化：emit。
  { event: 'goal/activation-changed', mode: 'emit' },
  // Cordis 请求运行：emit。
  { event: 'cordis/request-run', mode: 'emit' },
  // Cordis 请求运行已裁决：emit。
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  // Cordis 动态包装载：emit。
  { event: 'cordis/dynamic-package', mode: 'emit' },
  // Cordis 动态包撤回：emit。
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  // Cordis 检查查询：emit。
  { event: 'cordis/inspect-query', mode: 'emit' },
  // Cordis 检查查询应答：emit。
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  // LLM 适配器集合更新：emit。
  { event: 'llm/adapters-updated', mode: 'emit' },
  // LLM 模型集合更新：emit。
  { event: 'llm/models-updated', mode: 'emit' },
  // 权限预设目录变化：emit。
  { event: 'permission-presets/catalog-changed', mode: 'emit' },
  // 插件管理器变化：emit。
  { event: 'plugin-manager/changed', mode: 'emit' },
  // 插件安装日志：emit。
  { event: 'plugin-manager/install-log', mode: 'emit' },
  // 插件安装状态：emit。
  { event: 'plugin-manager/install-state', mode: 'emit' },
  // 插件更新状态：emit。
  { event: 'plugin-manager/update-state', mode: 'emit' },
  // 插件市场变化：emit。
  { event: 'plugin-market/changed', mode: 'emit' },
  // 设置文档更新：emit。
  { event: 'settings/document-updated', mode: 'emit' },
  // 计划任务（schedule）变化：emit。
  { event: 'schedule/changed', mode: 'emit' },
  // 用户提问请求：waterfall 模式，需要逐级向下征求回答。
  { event: 'user-questions/request', mode: 'waterfall' },
  // Web 提供方变化：emit。
  { event: 'web/providers-changed', mode: 'emit' },
] as const satisfies readonly TypertForwardableEventEntry[]
