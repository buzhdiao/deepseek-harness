// 模块说明：系统提示词注册表——harness 的"话术装配台"。有序系统段落（sections）、
// 动态运行期上下文（contexts）、工具 schema 提供方与提示词变量都登记于此，
// 每个模型步之前由 assemble 按作用域合并成一次完整装配。
// 关键设计：
// 1. 作用域遮蔽：智能体作用域内注册的同名段落/变量遮蔽全局版本，支持逐 agent 定制；
// 2. 严格变量插值：{{variable}} 引用在渲染时才解析，畸形/未注册/无值一律报错，
//    保证提示词文本永不携带未解析占位符；
// 3. complete 段落与瀑布：组装后跑 system-prompt/assemble 展示瀑布，
//    但"完整段落"（complete）在瀑布后原样恢复，工具声明始终归提供方所有。
/**
 * Registry for ordered system sections, dynamic context, tool schemas, and prompt variables.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

// cordis 的 Context 与 Service：服务基类与上下文类型。
import { Context, Service } from '@deepseek-ai/cordis'
// schemastery 的 z：声明服务配置 schema。
import z from '@deepseek-ai/schemastery'
// 作用域原语：匿名/具名条目、作用域分层、按作用域圈定监听目标。
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
// 作用域类型：作用域键、作用域层接口、Scoped this 标记。
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
// LLM 类型：上下文快照段落与工具 schema。
import type { ContextSnapshotSection, ToolSchema } from '@deepseek-ai/dsh-llm'

// 模块扩充：把 systemPrompt 服务挂到 cordis Context 上。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // systemPrompt 服务实例。
    systemPrompt: SystemPrompt
  }

  interface Events {
    /**
     * Presentation waterfall over assembled sections, contexts, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. The returned text is authoritative; tool declarations remain provider-owned.
     * A supplied signal controls only this explicit assembly request and must not
     * be retained to control later turns. A registered complete section is
     * restored after this waterfall, so listeners cannot add to or replace
     * that scope's system prompt.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - the caller's per-assembly context.
     * @mode waterfall
     */
    // 装配展示瀑布事件：对段落/上下文/变量的最终文本有权威权；
    // 作用域过滤分发——作用域内监听器只收到本作用域的装配。
    // 传入的信号只控制本次显式装配请求，不得留存控制后续轮次。
    // 已注册的 complete 段落在瀑布后恢复，监听器无法增删或替换
    // 该作用域的系统提示词。
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptPresentation, context: AssembleContext, next: () => Promise<PromptPresentation>): Promise<PromptPresentation>
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    // 任一提示词提供方变化时发出：全局变化影响所有作用域，故不过滤。
    'system-prompt/change'(): void
  }
}

/** Merge-extensible context for one prompt assembly. */
// 一次提示词装配的上下文（可合并扩展）。
export interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  // 参与装配的作用域；缺省时只有全局提供方与无主体监听器参与。
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  // 请求本次装配的轮次的显式控制信号（可选）。
  signal?: AbortSignal
}

/** One contributed section of the system prompt (registry input). */
// 系统提示词的一个段落贡献（注册表输入）。
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  // 唯一名字——重复注册会抛错。
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  // 段落按 order 升序拼接；同序时按码元名字序。
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}, unless `interpolate` is false.
   */
  // 静态文本或在每次装配时求值的提供方。文本可引用 {{variable}}——
  // 稍后由 renderPrompt 插值（除非 interpolate 为 false）。
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  // 是否插值提示词变量；缺省 true，false 保留字面文本。
  readonly interpolate?: boolean
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  // 把本贡献当作"完整系统提示词"：装配仍跑协作瀑布（解析工具/上下文/变量），
  // 然后把该段落原样恢复为唯一提示段落；多个生效的 complete 段落让装配失败。
  readonly complete?: boolean
}

/** Dynamic model context materialized as a durable user-role snapshot. */
// 动态模型上下文：物化为持久的 user 角色快照。
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  // 唯一名字——重复注册抛错。
  readonly name: string
  /** Contexts are joined in ascending order. */
  // 上下文按 order 升序合并。
  readonly order: number
  /** Static text or a provider evaluated at assembly and admission refresh. Empty text contributes nothing. */
  // 静态文本或在装配与准入刷新时求值的提供方；空文本不贡献。
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  // 是否插值变量；缺省 true。
  readonly interpolate?: boolean
  /** Keep this operational context when optional runtime context is disabled. */
  // 可选运行期上下文被禁用时仍保留本运维上下文。
  readonly required?: boolean
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
// 装配中的一个段落：文本已解析的 PromptSection。
export interface AssembledSection {
  /** The contributing section's unique name. */
  // 贡献段落的唯一名。
  name: string
  /** The resolved (but not yet interpolated) section text. */
  // 已解析（尚未插值）的段落文本。
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  // 是否插值变量；缺省 true。
  interpolate?: boolean
}

/** One resolved dynamic context contribution. */
// 一个已解析的动态上下文贡献。
export interface AssembledContext {
  /** The contributing context's unique name. */
  // 贡献上下文的唯一名。
  name: string
  /** The resolved text before variable interpolation. */
  // 插值前已解析的文本。
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  // 是否插值变量；缺省 true。
  interpolate?: boolean
}

/** Tool schemas visible in one assembly and their pre-restriction name set. */
// 一次装配中可见的工具 schema 及其"受限前"名字全集。
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  // 本提供方贡献给"本次装配"的 schema。
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  // 用于配置校验的受限前名字全集（缺省即 schemas 的名字）。
  readonly knownNames?: readonly string[]
}

/**
 * Prompt text contributions that the assembly waterfall may transform.
 * Sections and contexts remain uninterpolated until rendered; tool
 * declarations are owned by their providers.
 */
// 装配瀑布可改写的提示词文本贡献：段落/上下文在渲染前保持未插值；
// 工具声明归其提供方所有。
export interface PromptPresentation {
  // 已解析段落列表。
  sections: AssembledSection[]
  // 已解析上下文列表。
  contexts: AssembledContext[]
  // 已解析变量表。
  variables: Record<string, string | undefined>
}

/** Completed model inputs: the presentation plus tool declarations in canonical order. */
// 完成的模型输入：展示部分 + 规范排序后的工具声明。
export interface PromptAssembly extends PromptPresentation {
  // 本装配的工具声明。
  tools: ToolSchema[]
}

// 仓库段落 centrally 分配的位置表：负数放身份，0 放部署人格前缀，
// 500-3000 依次放各类指引与工具说明，3100 放 MCP 服务器，5000 放 PTC SDK，
// 9000+ 放交付物引用、结构化输出与本地路径等"跟随可复用指引之后"的段。
const SECTION_ORDERS = {
  // harness 身份段。
  HARNESS_IDENTITY: -1000,
  // 部署人格前缀段。
  DEPLOYMENT_PERSONA_PREFIX: 0,
  // 计划政策段。
  PLAN_POLICY: 500,
  // 团队政策段。
  TEAM_POLICY: 600,
  // 仅 PTC 模式段。
  PTC_ONLY: 800,
  // 文件引用段。
  FILE_REFERENCE: 900,
  // 各内置工具的说明段（按工具家族排布）。
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_APPLY_PATCH: 1350,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_SCHEDULE: 2500,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  // MCP 服务器清单段。
  MCP_SERVERS: 3100,
  // PTC 工具 SDK 段。
  TOOLS_SDK: 5000,
  // 交付物文件引用段。
  DELIVERABLE_FILE_REFERENCES: 9000,
  // 结构化输出段。
  STRUCTURED_OUTPUT: 9900,
  // Local paths and endpoints follow reusable instructions.
  // 本地路径与端点段：跟随可复用指引之后。
  HARNESS_SOURCE: 10000,
  // Web 呈现层段。
  WEB_SURFACE: 10100,
  // 部署人格后缀段。
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const

/** Name of a centrally allocated prompt-section position. */
// centrally 分配的段落位置名（SECTION_ORDERS 的键）。
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS

// 运行期上下文 centrally 分配的位置表。
const CONTEXT_ORDERS = {
  // 工作目录。
  WORKING_DIRECTORY: 100,
  // 沙箱政策。
  SANDBOX_POLICY: 110,
  // 审批政策。
  APPROVAL_POLICY: 115,
  // 子代理委派信息。
  SUBAGENT_DELEGATION: 120,
  // Process-specific paths and endpoints stay out of the cached system prompt.
  // 进程相关的路径与端点不进入缓存系统提示词（作为运行期上下文注入）。
  HARNESS_SOURCE: 200,
  // Web 呈现层信息。
  WEB_SURFACE: 210,
} as const

/** Name of a centrally allocated runtime-context position. */
// centrally 分配的运行期上下文位置名。
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS

/**
 * The deployment persona prefix's section name. Exported because a
 * composition can replace this slot — an agent preset shadows the
 * deployment's persona with its own — and both sides naming the same section
 * is what makes the replacement work rather than duplicate.
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Deployment persona suffix section name shared by global and scoped contributions. */
// 部署人格后缀段名：全局与作用域贡献共用（同名即遮蔽）。
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** Valid variable names: how they are written between the braces. */
// 合法变量名模式：即花括号之间的书写形式。
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A complete `{{...}}` reference group at the scan position (validated after). */
// 扫描位置处的完整 {{...}} 引用组（之后才做名字校验）。
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Reserved {@link Config.toolOrder} marker for unlisted tools. */
// toolOrder 里为未列出工具保留的占位标记。
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * Validate duplicate names and the required {@link TOOL_ORDER_REST} marker.
 * Registered names are checked later because plugins have not loaded yet.
 */
// 校验 toolOrder 的重复名与必需的 REST 标记；已注册名字到装配时再查
// （加载时插件尚未装载）。
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  // 未配置：直接返回。
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    // 重复列出：报错。
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    // 缺少 REST 标记：报错（它是未列出工具的插入点）。
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * Apply configured tool order, inserting unlisted tools lexicographically at
 * {@link TOOL_ORDER_REST}. Unknown configured names fail; known but restricted
 * names may be absent.
 */
// 应用配置的工具顺序：未列出的工具按字典序插入 REST 标记处。
// 配置了未知名字直接失败；已知但被限制的名字允许缺席。
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  // 提供方不得使用保留名。
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  // 未配置顺序：按名字字典序排序。
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  // 找出配置里不在已知名字全集中的项。
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  // 已列出的名字集合。
  const listed = new Set(toolOrder)
  // 未列出的工具：字典序插入 REST 位置。
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  // 按配置顺序展开；REST 处替换为 rest 列表。
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
// 码元名字比较：与 locale 无关，所有机器上的顺序完全一致。
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Order prompt sections by their explicit placement, then deterministically by name. */
// 段落排序：先按显式位置，再按名字做确定性次序。
function comparePromptSections(a: PromptSection, b: PromptSection): number {
  return a.order - b.order || compareNames(a.name, b.name)
}

/** Order tool schemas lexicographically by name. */
// 工具 schema 按名字字典序排序。
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return compareNames(a.name, b.name)
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /** Include optional runtime-context snapshots in model history (default true); required context remains. */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide persona prefix template before first-party guidance. A scoped section named
   * `deployment:persona-prefix` shadows it; `{{variable}}` references are strict.
   */
  personaPrefix?: string
  /**
   * Persona suffix template after first-party guidance. A scoped `deployment:persona-suffix`
   * section shadows it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * Interpolate strict `{{variable}}` references, drop empty sections, and join
 * the rest with blank lines. Sections with `interpolate: false` retain literal
 * text. Malformed, unknown, or undefined references in other sections throw;
 * a lone `{{` without any later `}}` is literal prose, and substituted values
 * are not scanned again.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the rendered prompt, or `''` when all sections are empty.
 */
export function renderPrompt(assembly: PromptAssembly): string {
  // 逐段插值（interpolate: false 保留字面文本），丢弃空段后以空行拼接。
  return assembly.sections
    .map(section => section.interpolate === false ? section.text : interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * Render the complete dynamic context snapshot, preserving literal contributions.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns the current full snapshot, or `''` when no context is active.
 */
// 渲染完整动态上下文快照（保留字面贡献）。
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly))
}

/**
 * The model-facing snapshot text for an already-rendered section list.
 *
 * A caller that also needs the sections renders them once and joins here, so a
 * request does not interpolate every context twice.
 * @param sections - sections from {@link renderContextSections}.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  // 拼接各段文本。
  const body = sections.map(section => section.text).join('\n\n')
  // 空主体：无上下文。
  if (body.length === 0) return ''
  // 带固定前言（声明本快照取代此前快照）。
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/**
 * The same snapshot, kept as the named contributions it was assembled from.
 *
 * {@link renderContextSnapshot} joins these for the model; a consumer that
 * presents the snapshot uses them to attribute each part to the subsystem that
 * contributed it, without re-splitting the joined prose. Contributions with
 * `interpolate: false` preserve literal text instead of resolving prompt variables.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns one entry per contributing context that rendered to non-empty text.
 */
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  // 逐条插值并保留命名归属，过滤空文本。
  return assembly.contexts
    .map(context => ({
      name: context.name,
      text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, 'context'),
    }))
    .filter(section => section.text.length > 0)
}

/** Interpolate one section or context and attribute diagnostics to its owning input. */
// 插值一个段落或上下文；诊断信息归属到其所属输入。
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  // 输出累积器与扫描游标。
  let result = ''
  let last = 0
  // 逐个 {{ 引用扫描。
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    // 尝试匹配完整引用组。
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // A later closing brace makes this malformed; otherwise it is literal prose.
      // 后面还有闭合双括号则视为畸形；否则它是字面散文。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      // 字面文本：原样保留两个 {。
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` yields an empty name and follows the malformed-reference path.
    // 提取名字；`{{}}` 得到空名，走畸形路径。
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Do not resolve unregistered names through Object.prototype.
    // 未注册的名字不得经 Object.prototype 解析（严格未知报错）。
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      // 注册了但本次装配无值：同样报错。
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    // 替换为值并推进游标。
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  // 拼回剩余文本。
  return result + text.slice(last)
}

/** Resolve one registered runtime fact without assembling sections or tools. */
// 只解析一个已注册的运行期事实，不组装段落或工具。
function resolveContext(entry: PromptContext, context: AssembleContext): AssembledContext {
  return {
    name: entry.name,
    // 函数型文本现场求值。
    text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
    ...entry.interpolate !== undefined ? { interpolate: entry.interpolate } : {},
  }
}

/** One tool-schema provider stored in a prompt layer. */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** One prompt-variable provider stored in a prompt layer. */
type VariableProvider = (context: AssembleContext) => string | undefined

/** All prompt registrations owned by one global or scoped layer. */
// 一个全局或作用域层拥有的全部提示词注册。
class PromptLayer implements ScopeLayer {
  // 具名段落条目（重名冲突带作用域诊断）。
  readonly sections: NamedEntries<PromptSection>
  // 具名上下文条目。
  readonly contexts: NamedEntries<PromptContext>
  // 运行期上下文抑制器（匿名可重复）。
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  // 工具 schema 提供方（匿名可重复）。
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  // 具名变量条目。
  readonly variables: NamedEntries<VariableProvider>

  /**
   * Create one prompt layer with diagnostics specific to its ownership scope.
   * @param scope - the scoped owner, or `undefined` for global registrations.
   */
  // 创建一个提示词层：重名错误信息按所有权作用域定制。
  constructor(scope: ScopeKey | undefined) {
    // 全局层报错时提示"逐 agent 覆盖请经 agent.ctx 注册"。
    this.sections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt section "${name}" is already registered in this scope`))
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
  }

  /** @returns whether this layer owns no prompt registrations. */
  isEmpty(): boolean {
    // 五类注册全空才算空层。
    return this.sections.isEmpty()
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.toolProviders.isEmpty()
      && this.variables.isEmpty()
  }
}

/** Registry service for the prompt inputs assembled before each model step. */
// 提示词注册表服务：每个模型步之前装配的提示词输入都在这里登记。
export class SystemPrompt extends Service {
  // 配置 schema：身份开关、运行期上下文开关、人格前后缀模板与工具顺序。
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
    // 保留"未配置"语义：显式空顺序缺少 REST 标记，必须区别于未配置。
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  // 作用域分层注册表：层变化时发出 system-prompt/change。
  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  // 校验过的工具顺序。
  private readonly toolOrder: string[] | undefined

  // 构造：校验 toolOrder 并注册身份/人格段落。
  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    // 加载期校验工具顺序配置。
    this.toolOrder = validateToolOrder(config.toolOrder)
    // Keep harness-owned openers independent of the selected loop plugin.
    // harness 自有的开场段落独立于所选循环插件。
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: this.getSectionOrder('HARNESS_IDENTITY'),
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    // 注册部署人格前缀段（同名作用域段可遮蔽）。
    this.section({
      name: PERSONA_PREFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      // The fallback narrows the optional input type; the schema already defaults it.
      // 回退只为收窄可选输入类型；schema 已给默认值。
      text: config.personaPrefix ?? '',
    })
    // 注册部署人格后缀段。
    this.section({
      name: PERSONA_SUFFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.personaSuffix ?? '',
    })
    // 配置关闭运行期上下文：注册抑制器。
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void {
    // order 必须是有限数。
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    // 经作用域分层注册；返回精确的 Cordis effect 拆卸器。
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }

  /**
   * Resolve the centrally owned placement of a repository prompt section.
   * @param name - stable section placement name.
   * @returns the section's numeric sort order.
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    // 查 centrally 分配的段落位置。
    return SECTION_ORDERS[name]
  }

  /**
   * Resolve the centrally owned placement of a repository runtime context.
   * @param name - stable context placement name.
   * @returns the context's numeric sort order.
   */
  getContextOrder(name: PromptContextOrderName): number {
    // 查 centrally 分配的上下文位置。
    return CONTEXT_ORDERS[name]
  }

  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void {
    // order 必须是有限数。
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    // 经作用域分层注册；作用域条目遮蔽同名全局条目。
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * Suppress optional dynamic runtime-context contributions in the calling
   * context's scope without changing the services that own or enforce those
   * facts. Multiple suppressors remain independently disposable.
   * @returns the exact Cordis effect disposer.
   */
  suppressRuntimeContext(): () => void {
    // 注册抑制器；多个抑制器可独立拆卸。
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    // 注册工具提供方：全局与匹配作用域的提供方都参与贡献。
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated for each assembly.
   * @returns the exact Cordis effect disposer.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    // 名字必须匹配变量名模式。
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    // 经作用域分层注册；作用域值遮蔽全局。
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * Refresh accepted registered runtime facts for request admission. Contexts
   * added only by the assembly waterfall retain their accepted values. Current
   * suppression removes optional contexts, and missing required registrations
   * are restored in registry order. Sections, tools, and interpolation variables
   * retain the accepted assembly; their providers and waterfall do not rerun.
   * @param assembly - accepted assembly for this scope and step.
   * @param context - the same scope and current plugin-defined assembly fields.
   * @returns the accepted assembly with current runtime-context provider text.
   */
  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {
    // 合并作用域内的上下文提供方。
    const providers = this.layers.merge(context.scope, layer => layer.contexts)
    // 当前是否抑制可选运行期上下文。
    const suppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || this.layers.chainLayers(context.scope).some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // 必需上下文登记表（用于恢复缺失者）。
    const required = new Map([...providers].filter(([, entry]) => entry.required === true))
    // 新上下文列表。
    const contexts: AssembledContext[] = []
    for (const accepted of assembly.contexts) {
      // 取当前提供方并从必需表中移除。
      const provider = providers.get(accepted.name)
      required.delete(accepted.name)
      // 抑制中的可选上下文：丢弃。
      if (suppressed && provider?.required !== true) continue
      // 有当前提供方则重新解析，否则保留装配时已接受的值。
      contexts.push(provider === undefined ? accepted : resolveContext(provider, context))
    }
    for (const provider of required.values()) {
      // 缺失的必需上下文按注册顺序恢复到正确位置。
      const index = contexts.findIndex((entry) => {
        const next = providers.get(entry.name)
        return next !== undefined && next.order > provider.order
      })
      contexts.splice(index < 0 ? contexts.length : index, 0, resolveContext(provider, context))
    }
    // 只替换上下文字段，其余保持装配时的结果。
    return { ...assembly, contexts }
  }

  /**
   * Assemble global and scoped providers, detach tool parameters, apply
   * canonical ordering, then run the presentation waterfall. Scoped sections
   * and variables shadow globals. The waterfall's text is authoritative except
   * that an effective complete section is restored afterwards as the sole
   * prompt section; tool declarations stay provider-owned.
   * @param context - the optional scope, step tool set, and plugin-defined assembly fields.
   * @returns the post-waterfall assembly with ordered tool declarations and any complete prompt enforced.
   */
  // Keep configuration failures on the declared asynchronous error path.
  // 配置错误保持在声明的异步错误路径上（方法本身返回 Promise）。
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    // 解析装配作用域与其层链。
    const scope = context.scope
    const scopeLayers = this.layers.chainLayers(scope)
    // 运行期上下文是否被抑制。
    const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // Scoped variables shadow globals.
    // 变量解析：先全局，后作用域链（后者遮蔽前者）。
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.layers.global.variables.entries()) {
      variables[name] = provider(context)
    }
    // Scope-chain variables, farthest first, so the nearest scope wins a name.
    // 作用域链变量按最远优先遍历，最近的作用域赢得同名。
    for (const layer of scopeLayers) {
      for (const [name, provider] of layer.variables.entries()) {
        variables[name] = provider(context)
      }
    }
    // Scoped sections shadow globals before the deterministic order sort.
    // 段落与上下文按作用域合并（作用域遮蔽全局），之后再做确定性排序。
    const sectionByName = this.layers.merge(scope, layer => layer.sections)
    const contextByName = this.layers.merge(scope, layer => layer.contexts)
    // Validate order against pre-restriction names while collecting visible schemas.
    // 收集所有工具提供方（全局 + 作用域链）。
    const providers = [
      ...this.layers.global.toolProviders.values(),
      ...scopeLayers.flatMap(layer => [...layer.toolProviders.values()]),
    ]
    // 可见 schema 收集器与受限前名字全集。
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      // 现场求值提供方。
      const result = provider(context)
      // 分离工具参数（structuredClone 防止跨装配共享可变结构）。
      const schemas = result.schemas.map(({ name, description, parameters, deferLoading }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
        ...deferLoading === true ? { deferLoading } : {},
      }))
      // 已知名字缺省取 schema 名字。
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    // 段落定义按显式位置 + 名字次序排序。
    const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections)
    // 收集生效的 complete 段落；多于一个即失败。
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    // complete 段落缓存（瀑布后恢复用）。
    let completeSection: AssembledSection | undefined
    const sections = sectionDefinitions
      .map((section) => {
        // 现场解析段落文本。
        const assembled = {
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
          ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
        }
        if (section.complete === true) completeSection = { ...assembled }
        return assembled
      })
    // 应用配置的工具顺序。
    const tools = orderTools(collected, this.toolOrder, knownNames)
    // 组装展示部分（上下文按序解析，抑制时只留必需）。
    const assembly: PromptPresentation = {
      sections,
      contexts: [...contextByName.values()]
        .filter(entry => !runtimeContextSuppressed || entry.required === true)
        .sort((a, b) => a.order - b.order)
        .map(entry => resolveContext(entry, context)),
      variables,
    }
    // 跑 system-prompt/assemble 展示瀑布（作用域过滤）。
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
    if (completeSection === undefined && !runtimeContextSuppressed) return { ...transformed, tools }
    // 需要恢复 complete 段落或过滤被抑制上下文的路径。
    const requiredContexts = new Set([...contextByName.values()].filter(entry => entry.required === true).map(entry => entry.name))
    return {
      ...transformed,
      tools,
      // complete 段落恢复为唯一提示段落（监听器无法增删替换）。
      sections: completeSection === undefined ? transformed.sections : [completeSection],
      // 抑制时上下文只保留必需项。
      contexts: runtimeContextSuppressed ? transformed.contexts.filter(entry => requiredContexts.has(entry.name)) : transformed.contexts,
    }
  }
}

// 默认导出：SystemPrompt 服务类。
export default SystemPrompt
