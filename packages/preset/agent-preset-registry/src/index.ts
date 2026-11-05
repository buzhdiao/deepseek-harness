/** Declarative Agent capability sets, activation and session binding. */
// 【中文逐行注释 · DSH 核心包 5：preset/agent-preset-registry/index.ts —— 预设注册表】
// agent-preset 是「给一个 agent 一套声明式能力组合」的机制：一个 preset id
// 对应一组插件行（tools、llm 适配、prompt 片段……），在独立的 Cordis 隔离
// 作用域（isolate realm）中挂载——不同 preset 的同名服务互不串扰。
// 本类（ctx.agentPresets）负责：注册/激活定义、按作用域把 agent 绑定到
// 「代（generation）」——即一次具体挂载的修订版、引用计数回收、远程 RPC 导出。
// 它是「一切皆插件」组合能力的最高层表达：整棵插件子树作为一个可热换的单元。
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bindScopeParent, createScope, scopeOf, scopeParentOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the optional `settings` service this registry keeps off the generated pages.
// 上游注释：仅类型导入——settings 是可选服务，注册表不把它带进生成的配置页。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentPresetDocument, AgentPresetRoster } from './types.ts'
import { entryListProblem, type PresetDefinition } from './definition.ts'
import type { AgentPreset, Config } from './preset.ts'
import { agentPresetProjectionDefinition } from './session.ts'
import { auditRows, leakedServices, mountPreset, serviceForMount, type PresetMount } from './mount.ts'
import { activeCompositionModules, definitionComposition, mountedCompositionRows, type AgentPresetComposition, type AgentPresetInspection } from './composition-inventory.ts'

// 出口：投影定义、定义校验、挂载审计、检视类型等。
export { agentPresetProjectionDefinition } from './session.ts'
export { entryListProblem, type PresetDefinition } from './definition.ts'
export { auditRows, leakedServices, type PresetMount, type RowAudit } from './mount.ts'
export type { AgentPresetInspection } from './composition-inventory.ts'
export type { AgentPreset, Config } from './preset.ts'

// 声明合并：把 agentPresets 服务挂上 Context（ctx.agentPresets）。
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresetRegistry
  }
}

// Generation：一次具体挂载的「代」——作用域 + 挂载产物 + 引用计数 + 退役标记。
// preset 定义更新后新代生效，旧代等最后一个使用者离开才销毁（修订保持语义）。
interface Generation {
  scope: Scope
  key: ScopeKey
  mount: PresetMount
  users: number
  retired: boolean
}
// Definition：一个已注册的 preset 定义——配置、声明上下文、激活 Promise、
// 当前代与失败诊断。
interface Definition {
  config: PresetDefinition
  context: Context
  ready: Promise<void>
  generation?: Generation
  /** Mount failure; unset while a tree is mounted, whose rows {@link AgentPresetRegistry.diagnostic} re-audits on read. */
  // broken（上游注释）：挂载失败的诊断；挂载成功时未设值（行级问题由 diagnostic 现场重审）。
  broken?: string
}
// Binding：agent 作用域键 → 代的绑定（含改父链接的特权句柄）。
interface Binding {
  parent: ScopeParentBinding
  generation: Generation
}

/** Registry of YAML-declared presets and the revisions live Agents retain. */
// AgentPresetRegistry：YAML 声明的预设注册表 + 活 agent 持有的修订版登记处。
export class AgentPresetRegistry extends TypertRemoteService {
  // 依赖注入：loader（插件装载）、sessionProjections（会话投影）、agents（代理注册表）。
  static inject = ['loader', 'sessionProjections', 'agents']
  // 配置 schema：默认预设 id（必填）+ 用户选择过的默认（volatile——改它不重启插件）。
  static Config = z.object({
    default: z.string().required(),
    selectedDefault: z.string().volatile(),
  })
  // 会话 → 已选预设 的投影句柄（从 session/event 折叠而来）。
  private agentPresetProjectionHandle!: ProjectionHandle<string | null>
  private readonly owner: Context
  // 预设 id → 定义。
  private readonly definitions = new Map<string, Definition>()
  // 作用域键 → 活代。
  private readonly generations = new Map<ScopeKey, Generation>()
  // agent 作用域键 → 绑定（弱映射：agent 卸载自动消失）。
  private readonly bindings = new WeakMap<ScopeKey, Binding>()
  // 串行化切换的 per-agent Promise 链。
  private readonly switches = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    // 注册为 ctx.agentPresets 服务。
    super(ctx, 'agentPresets')
    this.owner = ctx
  }

  // Service.init：构造后初始化（依赖就绪后执行）。
  protected async [Service.init](): Promise<void> {
    const ctx = this.owner
    // 注册「会话已选预设」投影：把 agent-preset/selected 事件折叠成每会话状态。
    this.agentPresetProjectionHandle = await ctx.sessionProjections.register(agentPresetProjectionDefinition)
    // settings 服务存在时：关闭其自动配置（本注册表自己管理配置节奏）。
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    // 转发会话事件：日志里的 agent-preset/selected 落盘事件 → 运行时同名事件
    //（让 UI/插件无需读日志即可观察选择变化）。
    ctx.on('session/event', (session, event) => {
      if (event.type === 'agent-preset/selected') ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /** Default preset for a subsequently created session. */
  // defaultId：后续新建会话的默认预设——用户显式选择优先，否则配置默认。
  get defaultId(): string { return this.config.selectedDefault.get() ?? this.config.default }

  /**
   * Read the preset recorded for a Session, including selections no longer in the roster.
   * @param session - Session whose committed preset selection is read.
   * @returns the recorded preset, or null when none was selected.
   */
  // presetForSession：读某会话已记录的预设选择（含已从名册消失的选择）。
  presetForSession(session: Session): string | null {
    return this.agentPresetProjectionHandle.stateOf(session)
  }

  /** Register and eagerly load a definition; activation failure remains visible in the roster.
   * @param definition Parsed configuration supplied by the declaring plugin.
   * @returns Definition disposer after activation or its diagnostic settles; the declaring plugin owns it.
   */
  // register：注册并立即激活一个定义（上游注释：激活失败仍留在名册中可见）。
  // 返回的反注册函数由声明插件持有（随插件卸载）。
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    const context = this.ctx
    // id 非空且唯一。
    if (!definition.id.trim()) throw new Error('Preset id must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    // 先登记（ready 置为已解决的 Promise，激活异步跟进）。
    const record: Definition = { config: definition, context, ready: Promise.resolve() }
    this.definitions.set(definition.id, record)
    let disposed = false
    // 反注册：标记退役并回收当前代（等待激活/使用者结束）。
    const unregister = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      this.definitions.delete(definition.id)
      await record.ready
      if (record.generation !== undefined) {
        record.generation.retired = true
        await this.collect(record.generation)
      }
    }
    // 启动激活并等待其完成（或落定诊断）。
    record.ready = this.activate(record)
    await record.ready
    return unregister
  }

  // activate：激活一个定义——铸造隔离作用域、校验插件行列表、挂载插件子树、
  // 登记为当前代（随作用域 effect 自动清理）；失败则记录诊断并释放作用域。
  private async activate(record: Definition): Promise<void> {
    // 新代的不透明作用域键。
    const key = {}
    const scope = createScope(this.owner, key)
    try {
      // 先静态校验插件行列表（格式问题立即失败）。
      const problem = entryListProblem(record.config.plugins)
      if (problem !== undefined) throw new Error(problem)
      // 在作用域上下文上扩展 baseUrl（相对插件说明符按声明处解析）。
      const context = scope.ctx.extend({ baseUrl: record.context.baseUrl })
      // 挂载整棵插件子树（隔离 realm 内）。
      const mount = await mountPreset(context, record.config.id, record.config.plugins)
      // 建立新代：引用计数 0、未退役。
      const generation: Generation = { scope, key, mount, users: 0, retired: false }
      // 代登记是作用域 effect：作用域卸载时自动摘除。
      context.effect(() => {
        this.generations.set(key, generation)
        return () => { this.generations.delete(key) }
      }, 'agent-preset.mount')
      record.generation = generation
    } catch (error) {
      // 失败：记录诊断、告警、释放作用域（名册中保留 broken 状态可见）。
      record.broken = (error as Error).message
      this.owner.logger.warn(`agent preset ${record.config.id}: ${record.broken}`)
      await scope.dispose()
    }
  }

  /**
   * Current activation diagnostic of a definition.
   *
   * A mount failure is final. A mounted tree is re-audited on every read: a
   * row waiting for a Host service activates by itself once that provider
   * finishes, so the audit waits for the Host Loader tree to settle before
   * reporting the row as unusable. Callers therefore must not run inside a
   * Host row's own activation, which the settlement would wait on.
   * @param record - the definition to audit.
   * @returns one line per unusable row, or undefined when the definition is usable.
   */
  // diagnostic（上游注释）：定义的当前激活诊断——挂载失败是终态；
  // 挂载成功的树每次读取重审（等待 Host 服务就绪的行会自行激活，
  // 故先等 Host Loader 树稳定再判行不可用）。
  private async diagnostic(record: Definition): Promise<string | undefined> {
    await record.ready
    // 没有活代：返回挂载失败的终态诊断。
    if (record.generation === undefined) return record.broken
    const tree = record.generation.mount.tree
    let audit = await auditRows(tree)
    // 有等待中的行：等 Host 树稳定后重审一次。
    if (audit.pending.length > 0) {
      await this.owner.loader.await()
      audit = await auditRows(tree)
    }
    const lines = [...audit.failed, ...audit.pending]
    return lines.length === 0 ? undefined : lines.join('\n')
  }

  // collect：回收一个代——仅当已退役且无人使用；释放其隔离作用域。
  private async collect(generation: Generation): Promise<void> {
    if (!generation.retired || generation.users !== 0) return
    this.generations.delete(generation.key)
    await generation.scope.dispose()
  }

  // generationFor：由上下文作用域键的「父键」查代——
  // agent 的作用域键通过 bindScopeParent 挂到代键上，所以查父即查绑定。
  private generationFor(ctx: Context): Generation | undefined {
    const key = scopeOf(ctx)
    const parent = key === undefined ? undefined : scopeParentOf(key)
    return parent === undefined ? undefined : this.generations.get(parent)
  }

  /** Inspect retained revisions, or the exact revision an Agent joined.
   * @param ctx - optional Agent context; omission includes all retained revisions.
   * @returns detached module references and isolation diagnostics; no match returns an empty list.
   */
  // inspectCompositions：检视保管的修订（或某 agent 精确加入的修订）——
  // 模块引用与隔离诊断（leakedServices 找出漏进全局作用域的服务）。
  inspectCompositions(ctx?: Context): AgentPresetInspection[] {
    const joined = ctx === undefined ? undefined : this.generationFor(ctx)
    const generations = ctx === undefined ? [...this.generations.values()] : joined === undefined ? [] : [joined]
    return generations.map(({ mount }) => ({
      id: mount.presetId,
      modules: activeCompositionModules(mount.tree),
      leakedServices: leakedServices(this.owner, mount.fiber),
    }))
  }

  /** Read every declared preset, including activation failures.
   * @returns Display metadata and loading diagnostics.
   */
  // list：读全部声明预设（含激活失败诊断），按 order 再按 id 排序。
  async list(): Promise<AgentPreset[]> {
    const rows = await Promise.all([...this.definitions.values()].map(async (record) => {
      const broken = await this.diagnostic(record)
      // 可选字段缺席时不设键（canonical 缺省 = 字段不存在）。
      return {
        id: record.config.id,
        ...(record.config.name === undefined ? {} : { name: record.config.name }),
        ...(record.config.description === undefined ? {} : { description: record.config.description }),
        ...(record.config.order === undefined ? {} : { order: record.config.order }),
        ...(broken === undefined ? {} : { broken }),
      }
    }))
    return rows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id))
  }

  /** Read the selection roster.
   * @returns Current presets, each marked when it is the default.
   */
  // remoteExportList：远程导出「选择名册」——每个预设带 isDefault 标记。
  @Remote('list')
  async remoteExportList(): Promise<AgentPresetRoster> {
    const defaultId = this.defaultId
    return { presets: (await this.list()).map(row => ({ ...row, isDefault: row.id === defaultId })) }
  }

  /** Resolve an identity without starting an Agent.
   * @param id Explicit preset or the current default.
   * @returns Current metadata, including failure when activation failed.
   */
  // resolve：只解析身份不启动 agent——未知 id 抛远程错误（带可用列表）。
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const record = this.definitions.get(wanted)
    if (record === undefined) throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`,
      { agentPreset: wanted, available: [...this.definitions.keys()] })
    const broken = await this.diagnostic(record)
    return { id: wanted, ...(broken === undefined ? {} : { broken }) }
  }

  /** Read one declaration's child plugin list as YAML, for viewing only.
   * @param agentPreset Preset identity.
   * @returns The declared composition beside its published metadata.
   */
  // readDocument：把声明中的插件行以 YAML 文本读出（仅供查看）。
  @Remote('read')
  readDocument(agentPreset: string): Promise<AgentPresetDocument> {
    const record = this.definitions.get(agentPreset)
    if (record === undefined) {
      return Promise.reject(new RemoteError('agent-preset/not-found', `Unknown agent preset: ${agentPreset}`,
        { agentPreset, available: [...this.definitions.keys()] }))
    }
    const { id, name, description, plugins } = record.config
    // The Loader's own dialect, so `!!js` conditions read as declared rather than as expression objects.
    // 上游注释：使用 Loader 自己的 schema 序列化——`!!js` 条件按声明原样读出，
    // 而不是变成普通表达式对象。
    const content = dump(plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
    return Promise.resolve({
      agentPreset: id, content, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
    })
  }

  // retain：按 id（缺省取默认）取一个代并引用计数 +1——
  // 循环重读定义（注册/注销可能在诊断 await 期间变化）；激活失败抛远程错误。
  private async retain(id?: string): Promise<Generation> {
    const wanted = id ?? this.defaultId
    while (true) {
      const record = this.definitions.get(wanted)
      if (record === undefined) throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`,
        { agentPreset: wanted, available: [...this.definitions.keys()] })
      const broken = await this.diagnostic(record)
      // 诊断等待期间定义被替换：重试。
      if (this.definitions.get(wanted) !== record) continue
      const generation = record.generation
      if (broken !== undefined || generation === undefined) {
        const reason = broken as string
        throw new RemoteError('agent-preset/invalid', reason, { agentPreset: wanted, reason })
      }
      generation.users++
      return generation
    }
  }

  // bind：把 agent 上下文的作用域键绑到一个代上——
  // 已绑定同代：无事；已绑定别的代：用特权句柄 rebind 父链接并转移引用计数；
  // 未绑定：建立新绑定（join）。
  private async bind(ctx: Context, generation: Generation): Promise<void> {
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Agent preset binding requires a scoped context')
    const binding = this.bindings.get(key)
    if (binding?.generation === generation) return
    if (binding !== undefined) {
      // 换绑：改父链接、引用计数从旧代转移到新代、回收旧代。
      binding.parent.rebind(generation.key)
      const old = binding.generation
      generation.users++
      binding.generation = generation
      old.users--
      await this.collect(old)
    } else this.join(ctx, key, generation)
  }

  // join：建立新绑定——bindScopeParent 把 agent 键挂到代键上（事件沿链向上）；
  // 绑定作为 ctx effect：agent 卸载时自动解绑并回收代。
  private join(ctx: Context, key: ScopeKey, generation: Generation): void {
    const binding = { parent: bindScopeParent(key, generation.key), generation }
    generation.users++
    this.bindings.set(key, binding)
    ctx.effect(() => async () => {
      this.bindings.delete(key)
      binding.generation.users--
      await this.collect(binding.generation)
    }, 'agent-preset.binding')
  }

  /** Bind an unpublished Agent to the current preset revision.
   * @param ctx Agent context from its setup callback.
   * @param id Requested preset, or the default.
   * @returns Bound preset identity.
   */
  // mount：把未发布的 agent 绑定到当前预设修订——retain + bind，
  // finally 里释放 retain 的临时引用（绑定自身已持有长期引用）。
  async mount(ctx: Context, id?: string): Promise<AgentPreset> {
    const generation = await this.retain(id)
    try {
      await this.bind(ctx, generation)
      return { id: generation.mount.presetId }
    } finally {
      generation.users--
      await this.collect(generation)
    }
  }

  /** Join a child to the exact revision retained by its parent.
   * @param ctx Child Agent context.
   * @param parent Parent Agent context.
   * @returns Inherited preset id, or undefined in a preset-free composition.
   */
  // composeFrom：子 agent 加入父 agent 持有的精确修订——
  // 父无代：若父有其他 composedPreset 则报错，否则返回 undefined（无预设组合）。
  composeFrom(ctx: Context, parent: Context): string | undefined {
    const generation = this.generationFor(parent)
    if (generation === undefined) {
      // 父声明过预设但修订不可用：报错（防止静默丢失能力集）。
      if (parent.get('agentPresets')?.composedPreset(parent) !== undefined) {
        throw new Error('Parent preset revision is unavailable')
      }
      return undefined
    }
    // A child has no existing binding, so this path has no asynchronous cleanup.
    // 上游注释：子代没有既有绑定，此路径无异步清理。
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Child preset binding requires a scope')
    if (this.bindings.has(key)) throw new Error('Child already joined a preset')
    this.join(ctx, key, generation)
    return generation.mount.presetId
  }

  /** Read the preset a live Agent uses.
   * @param ctx Agent context.
   * @returns Its preset id, if bound.
   */
  // composedPreset：读活 agent 当前使用的预设 id。
  composedPreset(ctx: Context): string | undefined { return this.generationFor(ctx)?.mount.presetId }

  /** Read a service supplied inside an Agent's isolated preset group.
   * @param agent Agent whose composition is queried.
   * @param name Cordis service name.
   * @returns The service, or undefined.
   */
  // serviceFor：读 agent 隔离预设组内提供的服务——跨插件引用的受控通道：
  // 服务在 preset 的 isolate realm 里，普通 ctx 读不到，必须经此解析。
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    const mount = this.generationFor(agent.ctx)?.mount
    return mount === undefined ? undefined : serviceForMount(this.owner, mount, name)
  }

  /** Rebind a blank Agent; the caller owns the blank-session check.
   * @param ctx Agent context.
   * @param id Requested preset.
   * @returns The bound identity.
   */
  // recompose：给空白 agent 换绑预设（空白会话检查由调用方负责）；
  // 换绑后广播 tools/change 让工具观察者刷新。
  async recompose(ctx: Context, id: string): Promise<AgentPreset> {
    const preset = await this.mount(ctx, id)
    try { this.owner.emit('tools/change') }
    catch (error) { this.owner.logger.warn(`Preset tools observer: ${String(error)}`) }
    return preset
  }

  /** Select a preset before a session starts its first turn. A Session whose
   * log records the preset and whose Agent runs its current revision keeps its
   * composition; nothing is logged or announced.
   * @param agent Target Agent.
   * @param agentPreset Requested identity.
   * @returns Committed preset identity.
   */
  // select（上游注释）：在会话首个回合开始前选择预设——
  // 已开回合的会话锁定（agent-preset/locked）；已是当前组合且日志一致时静默返回；
  // 否则换绑并把选择写入会话日志（agent-preset/selected 事件——持久）。
  // per-agent 的 switches 链把并发切换串行化。
  @Remote('select')
  async select(agent: Agent, agentPreset: string): Promise<string> {
    // 排队到该 agent 的前一次切换之后。
    const turn = (this.switches.get(agent.id) ?? Promise.resolve()).then(async () => {
      // 回合边界检查：已开回合或有历史回合 → 拒绝。
      const boundary = this.owner.agents.turnBoundaryOf(agent.session)
      if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
        throw new RemoteError('agent-preset/locked', 'This session has already started', { sessionId: agent.id, agentPreset })
      }
      // 已经是目标组合且投影状态一致：无需改动。
      const current = this.definitions.get(agentPreset)?.generation
      if (current !== undefined && this.generationFor(agent.ctx) === current
        && this.agentPresetProjectionHandle.stateOf(agent.session) === agentPreset) return agentPreset
      // 换绑并落盘选择（Model-visible ⟺ logged 的姊妹原则：选择必须持久）。
      const preset = await this.recompose(agent.ctx, agentPreset)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      return preset.id
    })
    // 失败不阻塞后续切换（guard 吞错），但原 turn 保留错误给本次调用者。
    const guard = turn.catch(() => undefined)
    this.switches.set(agent.id, guard)
    try { return await turn } finally {
      if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id)
    }
  }

  /** Read current registrations for cold transcript presentation.
   * @param id Preset identity or the default.
   * @returns A revision lease; dispose it after the scoped read completes.
   */
  // acquireScope：为冷转录展示取一个「修订租约」——读完后 dispose 释放引用。
  // （AsyncDisposable：可用 await using 语法自动释放。）
  async acquireScope(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable> {
    const generation = await this.retain(id)
    let disposed = false
    return { key: generation.key, [Symbol.asyncDispose]: async () => {
      if (disposed) return
      disposed = true
      generation.users--
      await this.collect(generation)
    } }
  }

  /** Read plugin rows without creating an Agent.
   * @returns Current declaration metadata and activation states.
   */
  // compositionInventory：不创建 agent 读插件行——声明元数据 + 激活状态
  //（活代用挂载树的实际行；死定义用静态声明的行）。
  compositionInventory(): Promise<AgentPresetComposition[]> {
    return Promise.all([...this.definitions.values()].map(async (record) => {
      const { id, name, description } = record.config
      const broken = await this.diagnostic(record)
      const read = definitionComposition(record.config.plugins, () => { throw new Error('Inactive definition') })
      return { id, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
        isDefault: id === this.defaultId,
        ...(broken === undefined ? {} : { broken }),
        rows: record.generation === undefined ? ('rows' in read ? read.rows : []) : mountedCompositionRows(record.generation.mount.tree) }
    }))
  }
}
export default AgentPresetRegistry
