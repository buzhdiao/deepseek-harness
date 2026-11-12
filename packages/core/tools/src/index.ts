// 模块说明：工具定义注册表与"按作用域分发到插件所有的执行器"——工具子系统的
// 门面服务（ctx.tools）。关键设计：
// 1. 作用域遮蔽：agent 作用域注册的工具遮蔽全局同名工具；restrict 过滤器
//    沿作用域链相交，但观察作用域自己的注册豁免于继承的过滤；
// 2. 步进准入（toolSet）：每个模型步经 resolve 把"when 条件"一次性解析成
//    冻结集合，注册在步中途消失也不会复活已准入的工具；
// 3. 保留名 run_code：无条件保留给 PTC 模式传输工具——任何 agent 都可以
//    自选代码模式，注册它迟早变成冲突；
// 4. 执行器选择：就近作用域优先，缺省回退部署默认；卸载后保持"不可用"
//    而不是悄悄落到另一个执行器。
/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
// cordis 的 Context 与 Service。
import { Context, Service } from '@deepseek-ai/cordis'
// schemastery 的 z：配置 schema（用于声明已迁移的配置键）。
import z from '@deepseek-ai/schemastery'
// 作用域原语：匿名/具名条目、作用域分层、作用域读取与链。
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
// 执行器不可用错误与执行器接口。
import { ToolExecutorUnavailableError } from './executor.ts'
import type { ToolExecutor, ToolBatchInput, ToolBatchResult } from './executor.ts'
// 副作用导入：引入 events.ts 的模块扩充。
import './events.ts'
// 线上工具 schema 类型。
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
// schema 投影与强制子集断言。
import { projectToolSchema } from './schema.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
// 保留工具名与激活失败错误。
import { RUN_CODE_NAME, ToolActivationError } from './contracts.ts'
// 工具契约类型全集。
import type {
  ToolDefinition, ToolRestriction, ToolExecution, ToolGuard, ToolGuardDenial,
  ResolvedToolSet, ToolActivationContext, ToolRegistrationOptions,
} from './contracts.ts'

// 模块扩充：给系统提示词装配上下文加 toolSet 字段。
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Step-owned tool selection; absent when inspecting registered definitions. */
    // 本步持有的工具准入集合；检查已注册定义时缺席。
    toolSet?: ResolvedToolSet
  }
}

// 模块扩充：给消息来源映射注册 tool-registry 来源。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tool availability changes supplied by the tool registry. */
    // 工具注册表提供的工具可用性变化消息来源。
    'tool-registry': { kind: 'tool-registry' }
  }
}

// 模块扩充：把 tools 服务挂到 cordis Context 上。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // tools 服务实例。
    tools: ToolsService
  }
}

/** One restriction compiled at registration for repeated live-global lookup. */
// 注册时编译好的过滤器：供反复的活全局查找复用。
interface CompiledToolRestriction {
  // allow 白名单（仅保留这些）。
  readonly allow?: ReadonlySet<string>
  // deny 黑名单（移除这些）。
  readonly deny?: ReadonlySet<string>
}

/** One registered definition and its step-time activation condition. */
// 一个已注册定义及其步时激活条件。
interface ToolRegistration {
  // 工具定义。
  readonly definition: ToolDefinition
  // 步时激活条件（可选）。
  readonly when: ToolRegistrationOptions['when']
}

/** One scope's complete registry view, derived in a single layer traversal. */
// 一次作用域的完整注册表视图（单次层遍历推导）。
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and inherited restrictions. */
  // 经过滤、作用域遮蔽与继承过滤后的可见定义。
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Registrations behind {@link visible}, keyed by the same names. */
  // visible 背后的注册条目（同名键）。
  readonly registrations: ReadonlyMap<string, ToolRegistration>
  /** Pre-restriction capability names used by prompt-order validation. */
  // 受限前的能力名全集（提示词顺序校验用）。
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  // 作用域 restrict 可以点名的当前全局工具名。
  readonly restrictableNames: ReadonlySet<string>
}

/** One scope's complete tool-registry contribution. */
// 一个作用域的完整工具注册贡献。
class ToolLayer implements ScopeLayer {
  // 具名工具注册条目。
  readonly tools: NamedEntries<ToolRegistration>
  // 匿名 restriction 过滤器（可叠加）。
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()

  // 构造：重名错误按作用域定制诊断。
  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    // 工具与过滤器都为空才算空层。
    return this.tools.isEmpty() && this.restrictions.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  // 本层所有过滤器是否放行某个全局工具名。
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      // 白名单外或黑名单内：不放行。
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

}

// 一个作用域的执行器登记（executor 槽位可被卸载清空）。
interface Registration {
  executor: ToolExecutor | undefined
}

// 守卫层：匿名守卫集合。
class GuardLayer {
  readonly guards = new AnonymousEntries<ToolGuard>()
  isEmpty(): boolean { return this.guards.isEmpty() }
}

/** Concrete tool registry and scoped executor dispatcher. */
// 具体的工具注册表兼按作用域的执行器分发器。
export class ToolsService extends Service {
  // 依赖：系统提示词服务（注册工具提供方）。
  static inject = ['systemPrompt']
  // 配置：两个历史键都被移除，显式拒绝（z.never 使配置报错并提示迁移）。
  static Config = z.object({
    mode: z.never().description('Removed. Mount a native or PTC tool executor instead.'),
    maxParallelSubCalls: z.never().description('Moved to the PTC tool executor configuration.'),
  })

  // 作用域分层的工具层（变化时发出 tools/change）。
  private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
  // 作用域执行器登记。
  private readonly scoped = new WeakMap<ScopeKey, Registration>()
  // 全局（根）执行器登记。
  private root: Registration | undefined
  // 作用域分层的守卫层。
  private readonly guards = new ScopedLayers(() => new GuardLayer(), () => {})

  // 构造：向系统提示词注册工具 schema 提供方。
  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(({ scope, toolSet }) => {
      // 就近选择执行器并描述可见工具。
      const executor = this.selectExecutor(scope)
      const description = executor.describe(this.definitions(scope, toolSet))
      // 已知名字缺省由注册表视图提供（受限前全集）。
      return { ...description, knownNames: description.knownNames ?? [...this.view(scope).knownNames] }
    })
  }


  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @param options - optional step-time activation condition.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void {
    // 工具名。
    const name = definition.name
    // 注册时即校验 output 声明的形状。
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    // 输出 schema 必须属于强制子集。
    assertSupportedJsonSchema(output.schema)
    // 超时预算校验。
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    // 无条件保留 run_code：任何 agent 都可能自选代码模式，
    // 部署默认下可自由占用的名字在预设挂载的那一刻就会变成冲突。
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
    // 经作用域分层注册；返回精确拆卸器。
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, { definition, when: options.when }),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    // restrict 只允许在作用域上下文中调用。
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      // 空过滤器是 no-op：几乎总是"配置物化为空"的 bug，显式拒绝。
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    // 编译过滤器为集合。
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      // 保留名不可被 restrict 点名。
      throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    // 名字必须命中"可受限的全局工具"全集。
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    // 经作用域分层注册过滤器。
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Resolve visible tools and pre-restriction names. Restrictions across the
   * scope chain intersect over inherited global and ancestor tools; the viewing
   * scope's own registrations remain exempt. Nearer registrations shadow
   * farther ones. Pre-restriction names support restriction and prompt-order validation.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    // 取作用域层链与观察层。
    const layers = this.layers.chainLayers(scope)
    const own = this.layers.peek(scope)
    // 继承视图：全局注册起步，沿祖先层就近覆盖（远处被近处遮蔽）。
    const inherited = new Map(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration)
    }
    // 视图收集器。
    const visible = new Map<string, ToolDefinition>()
    const registrations = new Map<string, ToolRegistration>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, registration] of inherited) {
      // 继承项：全部计入受限前全集。
      knownNames.add(name)
      restrictableNames.add(name)
      // 沿整条层链的过滤器都放行才可见。
      if (layers.every(layer => layer.admits(name))) {
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    if (own !== undefined) {
      // 观察作用域自己的注册：豁免过滤器，直接可见。
      for (const [name, registration] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    // 返回完整视图。
    return { visible, registrations, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    // 有步准入走集合视图；无则按注册表视图。
    return toolSet === undefined ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name)
  }

  /**
   * Resolve the definition a call may execute. With a step's admitted set, the
   * set decides; without one, conditional registrations are unavailable.
   * @param name - the tool name as registered.
   * @param scope - the calling agent; omitted = the global view.
   * @param toolSet - step admission, or omitted for a call outside a model step.
   * @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
   */
  executable(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    // 有步准入：集合说了算。
    if (toolSet !== undefined) return toolSet.view(scope).get(name)
    // 无准入：条件注册不可用（没有解析过 when）。
    const view = this.view(scope)
    return view.registrations.get(name)?.when === undefined ? view.visible.get(name) : undefined
  }

  /**
   * Resolve conditions once for this step without changing shared registrations.
   * Cancellation or a rejected condition publishes no partial selection. Removed
   * registrations cannot be restored by a late condition result.
   * @param context - preparing agent, captured model selection, and cancellation.
   * @returns the complete selection; the caller disposes it after its tool batch settles.
   */
  async resolve(context: ToolActivationContext): Promise<ResolvedToolSet> {
    // 解构准备上下文。
    const { agent, signal } = context
    signal.throwIfAborted()
    // 先取观察作用域的完整视图。
    const view = this.view(agent)
    // 准入集合。
    const admitted = new Map<string, ToolDefinition>()
    for (const [name, definition] of view.visible) {
      // 逐工具解析激活条件。
      const registration = view.registrations.get(name)
      let enabled: boolean
      try {
        // 无条件即启用；有条件现场求值。
        enabled = registration?.when === undefined || await registration.when(context)
      } catch (cause: unknown) {
        // 条件抛错：先检查是否因取消，再包装为激活错误。
        signal.throwIfAborted()
        throw new ToolActivationError(name, cause)
      }
      signal.throwIfAborted()
      // 启用者进入准入集合。
      if (enabled) admitted.set(name, definition)
    }
    // 关闭标记：dispose 后视图立即清空。
    let closed = false
    // 冻结的准入集合。
    return Object.freeze({
      // 调用方在工具批次落定后调用。
      dispose: () => { closed = true },
      view: (scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition> => {
        const visible = new Map<string, ToolDefinition>()
        // 已关闭或作用域不符：空视图。
        if (closed || scope !== agent) return visible
        // 重新取当前视图：注册中途被移除的工具不复活。
        const current = this.view(agent)
        for (const [name, definition] of admitted) {
          // 定义与注册条目双重身份一致才保留。
          if (current.visible.get(name) === definition
            && current.registrations.get(name) === view.registrations.get(name)) {
            visible.set(name, definition)
          }
        }
        return visible
      },
    })
  }

  /**
   * Read the visible capability definitions for descriptions and program bindings.
   * @param scope - viewing Agent or preset; omitted selects the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
   */
  definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[] {
    // 有步准入走集合视图，无则走注册表视图。
    return toolSet === undefined ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()]
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission, or omitted for registered-definition inspection.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[] {
    // 每个可见工具投影出模型可见 schema（参数深拷贝分离）。
    return this.definitions(scope, toolSet).map(definition => projectToolSchema(definition, true))
  }
  /**
   * Provide the executor for the calling scope; an unscoped contribution is the deployment default.
   * Rendering any executor-owned section requires the viewing scope's selection to remain available.
   * @param executor - initialized provider owned by the contributing plugin.
   * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
   */
  setExecutor(executor: ToolExecutor): () => void {
    // 读取登记作用域（无作用域 = 部署默认）。
    const scope = scopeOf(this.ctx)
    const existing = scope === undefined ? this.root : this.scoped.get(scope)
    if (existing?.executor !== undefined) throw new Error('Only one tool executor may be registered in each scope')
    // 组装登记记录。
    const record: Registration = { executor }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    // 组合 effect：注册执行器自带段落 + 登记记录 + 卸载清理。
    return this.ctx.effect(function* (this: ToolsService) {
      for (const section of executor.sections ?? []) {
        // 注册执行器的提示词段落：仅在"本作用域仍选中该执行器"时渲染。
        yield this.ctx.systemPrompt.section({
          name: section.name,
          order: section.order,
          ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
          text: ({ scope, toolSet }) => {
            // 选中者变了：段落渲染为空。
            if (this.selectExecutor(scope) !== executor) return ''
            return typeof section.text === 'function' ? section.text(this.definitions(scope, toolSet)) : section.text
          },
        })
      }
      // 登记执行器（根或作用域）。
      if (scope === undefined) this.root = record
      else this.scoped.set(scope, record)
      yield () => {
        // Keep an unavailable selection so a program cannot fall through to a different executor.
        // 保持"不可用"选择：程序不能落到另一个执行器。
        record.executor = undefined
      }
    }.bind(this), 'tools.setExecutor()')
  }

  /**
   * Resolve the nearest scoped provider, or the deployment default.
   * @param scope - Agent or preset scope; omitted selects only the root contribution.
   * @returns the selected executor; throws when it is missing or unloaded.
   */
  private selectExecutor(scope?: ScopeKey): ToolExecutor {
    // 沿作用域链由近及远找登记。
    let record: Registration | undefined
    for (const key of scopeChainOf(scope)) {
      record = this.scoped.get(key)
      if (record !== undefined) break
    }
    // 回退部署默认（根登记）。
    record ??= this.root
    const executor = record?.executor
    // 缺失或已卸载：报不可用错误。
    if (executor === undefined) throw new ToolExecutorUnavailableError()
    return executor
  }

  /**
   * Delegate a raw call batch to its Agent's provider or the deployment default.
   * Select at dispatch; accepted batches settle through that provider even if it unloads.
   * @param input - original calls, optional owning Agent, and optional logging step.
   * @returns the selected executor's settled batch; unavailable selections reject.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    // 分发时就近选择执行器；已受理的批次即使其卸载也经该执行器落定。
    return this.selectExecutor(input.agent).execute(input)
  }

  /**
   * Register a monotonic denial in the calling scope.
   * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
   * @returns the effect disposer that removes this guard.
   */
  guard(guard: ToolGuard): () => void {
    // 在调用作用域登记单调拒绝守卫。
    return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' })
  }

  /**
   * Check global and inherited guards after pre-execute policy and approval resolve.
   * @param exec - invocation whose guards are checked before dispatch.
   * @returns the first denial with its optional structured identity, or undefined when no guard denies.
   */
  checkGuards(exec: ToolExecution): ToolGuardDenial | undefined {
    for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
      for (const guard of layer.guards.values()) {
        const denial = guard(exec)
        if (denial !== undefined) return typeof denial === 'string' ? { reason: denial } : denial
      }
    }
    // 无守卫拒绝。
    return undefined
  }

}

// 默认导出：ToolsService 服务类。
export default ToolsService

// 原样转发各子模块类型与值导出。
export * from './contracts.ts'
export * from './executor.ts'
export * from './schema.ts'
export * from './json-schema.ts'
export * from './presentation.ts'
// 别名导出：ToolRuntime（历史名）。
export { ToolsService as ToolRuntime }
