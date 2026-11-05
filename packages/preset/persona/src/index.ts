/**
 * A per-agent persona as a composable row.
 *
 * `dsh-system-prompt` owns the global persona as its own config, and registers
 * that section unconditionally — so this row is **scope-only**. Mounted inside
 * an agent preset it shadows the deployment persona for that one session,
 * exactly like the per-child persona `dsh-subagent` installs; mounted globally
 * it collides with the registry's own registration and fails loud.
 *
 * That constraint is the reason the row exists. An agent preset cannot mount
 * the prompt registry itself, so without a row of its own a preset could
 * change an agent's tools but never its identity.
 * @module @deepseek-ai/dsh-persona
 */

// 【中文逐行注释 · DSH 核心包 7：preset/persona —— 每代理人设（组合行插件）】
// 上游模块文档（中文）：这是一个「每 agent 人设」组合行插件。
// dsh-system-prompt 把全局人设作为自己的配置并无条件注册同名 section——
// 因此本行只允许在作用域内（scope-only）挂载：在 agent preset 内挂载时，
// 它为本会话遮蔽部署级人设（与 dsh-subagent 为子代理安装的 per-child persona
// 一样）；全局挂载会与注册表自身的注册冲突并大声失败（fail loud）。
// 这个约束正是本行存在的理由：agent preset 无法挂载 prompt 注册表本身，
// 没有这一行，preset 只能换工具、永远换不了「身份」——
// 这体现了 capability seam 的角色拆分：prompt 注册是 Service Definition，
// 本行是 Provider，agent preset 是消费者。
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'

// 转发 section 名常量（前缀/后缀人设槽位）。
export { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION }

/** Cordis plugin name. */
// Cordis 插件名。
export const name = 'persona'

/** The prompt registry this row contributes to. */
// 依赖注入：本行向 systemPrompt 注册表贡献 section。
export const inject = ['systemPrompt']

/** Plugin config: the persona text this composition contributes. */
// 插件配置：本组合贡献的人设文本。
export interface Config {
  /**
   * Persona prose rendered as the `deployment:persona-prefix` section. A template:
   * complete `{{…}}` groups interpolate strictly against registered prompt
   * variables. Empty text drops the section at render, matching the registry.
   */
  // prefix（上游注释）：渲染为 deployment:persona-prefix 的人设正文——模板；
  // 完整的 {{…}} 组严格按注册的提示词变量插值；空文本在渲染时丢弃该 section。
  prefix: string
  /**
   * Persona suffix template rendered after first-party guidance. Omitted or empty
   * text shadows the deployment suffix away; interpolation is strict.
   */
  // suffix（上游注释）：渲染在第一方指引之后的人设后缀模板——
  // 缺席或空文本会把部署级后缀遮蔽掉；插值同样是严格的。
  suffix?: string
  /** Make the prefix the complete system prompt, suppressing the suffix and every other section. */
  // complete：让 prefix 成为完整系统提示词——压制后缀与其余全部 section。
  complete?: boolean
  /** Suppress dynamic runtime-context snapshots for this persona's agent scope. */
  // includeRuntimeContext：为这个人设的 agent 作用域压制动态运行时上下文快照。
  includeRuntimeContext?: boolean
}

/** Runtime schema for the persona row. */
// 人设行的运行时 schema（prefix 必填；其余有默认）。
export const Config: z<Config> = z.object({
  prefix: z.string().required(),
  suffix: z.string().default(''),
  complete: z.boolean().default(false),
  includeRuntimeContext: z.boolean().default(true),
})

/**
 * Register the persona prefix and suffix sections for the mounting context's scope.
 * @param ctx - an agent scope context; an unscoped context collides with the
 * prompt registry's own persona registration and rejects.
 * @param config - the prefix, suffix, and complete-prompt policy.
 */
// apply（上游注释）：为挂载上下文的作用域注册人设前/后缀 section——
// ctx 必须是 agent 作用域上下文；未加作用域的 ctx 会与 prompt 注册表自身的
// 人设注册冲突并被拒绝（fail loud 的边界就在这里）。
export function apply(ctx: Context, config: Config): void {
  // 前缀 section：order 取注册表中同名槽位的既有顺序（替换而非另立）；
  // complete 时声明「这是完整提示词」。
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.prefix,
    ...(config.complete ? { complete: true } : {}),
  }), 'persona.section()')
  // 后缀 section：文本缺省为空（空即遮蔽部署级后缀）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: config.suffix ?? '',
  }), 'persona.suffix()')
  // 可选：压制运行时上下文快照（includeRuntimeContext 缺省视为 true——不压制）。
  if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext()
}
