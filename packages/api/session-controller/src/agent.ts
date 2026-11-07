// 模块说明：由 API Session 拥有的 Agent 激活（activation）、组装（composition）
// 与初始模型路由。
/** Agent activation, composition, and initial model route owned by API Session. */

// 生成随机会话 id（铸造新 Session 时使用）。
import { randomUUID } from 'node:crypto'
// 创建目录（确保项目目录存在）。
import { mkdir } from 'node:fs/promises'
// Cordis 的 Context（上下文）类型。
import type { Context } from '@deepseek-ai/cordis'
// Agent（代理）、AgentOptions（代理选项）与 AgentSetup（发布前装配回调）类型。
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
// 空类型导入：引入默认模型服务的模块扩充（ctx.agentDefaultModel）。
import type {} from '@deepseek-ai/dsh-agent-default-model'
// installModelSelection：把模型选择安装到 Agent 上下文。
import { installModelSelection } from '@deepseek-ai/dsh-agent'
// 空类型导入：引入 Agent 预设注册表的模块扩充（ctx.get('agentPresets')）。
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// brandString：把普通字符串品牌化为 SessionId。
import { brandString } from '@deepseek-ai/dsh-brand'
// Session（会话）与 SessionId（会话 id）类型。
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// 会话查询：错误类型与精确观察（SessionObservation）。
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
// Typert 协议：远端错误与其提取工具。
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// 空类型导入：引入 Typert 注册表的模块扩充（lookups / contexts 配置）。
import type {} from '@deepseek-ai/dsh-typert-registry'

// 持久化中不存在的冷会话（cold Session）身份。
/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

// 其生命周期归属于子代理（subagent）路由的会话身份。
/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  // 构造：记录被保留给子代理路由的会话 id。
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

// 显式 id 创建试图以另一个 cwd 收养（adopt）会话时的冲突。
/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  // 构造：记录会话 id、请求的目录与既有目录（可能未记录）。
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    // 按既有目录是否存在给出不同的冲突说明。
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

// 部署未组装任何预设名册（roster）时，复用指名 Agent 预设的会话即冲突。
/** Reuse of a Session named an Agent preset while the deployment composes no preset roster. */
export class ApiSessionPresetConflict extends Error {
  // 构造：记录会话 id 与被请求的预设名。
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
  ) {
    super(`the deployment composes no agent preset roster, so session "${sessionId}" cannot run preset "${requestedPreset}"`)
  }
}

// 被选中复用的空白会话在本 Host 取得写入者之前已经开始了一轮对话。
/** A blank Session chosen for reuse started a turn before this Host acquired its writer. */
class ApiSessionStartedSinceObserved extends Error {}

// 为新对话创建的某个会话的放置（placement）与 Agent 预设。
/** Placement and Agent preset for one Session created for a new conversation. */
export interface ApiSessionCreateRequest {
  // 要复用的空白会话；其下没有存储任何会话时，作为新会话的身份。
  /** Blank Session to reuse, or the identity of a new Session when none is stored under it. */
  readonly sessionId?: SessionId
  // 会话拥有的目录。
  /** Directory the Session owns. */
  readonly cwd: string
  // 会话运行的预设；缺省时使用配置的默认值。
  /** Preset the Session runs; the configured default when omitted. */
  readonly agentPreset?: string
  // 调用方拥有的放置规则，例如 Workspace 成员关系与归档状态。
  /**
   * Placement rule the caller owns, such as Workspace membership and archive state.
   * @param sessionId - existing Session named by the request.
   * @returns whether that Session may be reused.
   */
  readonly reusable: (sessionId: SessionId) => boolean
}

// 一次创建请求所创建或复用的会话。
/** The Session one creation request created or reused. */
export interface ApiSessionCreated {
  // 该会话的活跃 Agent。
  /** Live Agent of the Session. */
  readonly agent: Agent
  // 本请求结束时该会话运行的预设（同一身份的后续请求之前）；无名册时缺省。
  /** Preset the Session ran when the request finished, before a later request for the same identity; absent without a roster. */
  readonly agentPreset: string | undefined
}

// 一次创建或恢复所解析出的预设与发布前 Agent 装配。
/** Resolved preset and pre-publication Agent setup for one create or resume. */
interface ApiSessionComposition {
  // 解析出的预设 id（无名册时缺省）。
  readonly agentPreset?: string
  // 发布前的 Agent 装配回调。
  readonly setup: AgentSetup
}

// 把普通会话身份解析到其活跃 Agent 时可能产生的失败。
/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

// 把普通会话身份解析到其活跃 Agent 的结果。
/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  // 成功：活跃 Agent。
  | { readonly agent: Agent }
  // 失败：稳定的会话域错误。
  | { readonly error: ApiSessionAgentError }

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param session - Attached or live Session whose origin is tested.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(session: Pick<Session, 'header'>): boolean {
  // 会话头部来源为 subagent 即归属子代理路由。
  return session.header.origin === 'subagent'
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  // 构造稳定的调用方面拒绝：会话由子代理路由拥有。
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

// 拥有创建、恢复或配置 Web Agent 的全部操作。
/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  // 进行中的恢复去重表：按会话 id 缓存恢复 Promise。
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  // 按会话 id 串行化创建请求的认领（claim）链。
  private readonly claims = new Map<SessionId, Promise<void>>()
  // 按 Agent 串行化图片准入与模型选择的链（弱引用，不阻止回收）。
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  // 构造：持有宿主上下文。
  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(private readonly ctx: Context) {}

  // 为 Typert 配置会话与 Agent 的查找（lookup）。
  /**
   * Configure Session and Agent lookups for Typert.
   */
  initialize(): void {
    // 取宿主上下文。
    const ctx = this.ctx
    // 'agent' 查找：按会话 id 解析到活跃 Agent；失败则抛出错误。
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    // 'session' 查找：解析到活跃 Agent 的会话对象。
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    // 'agent' 宿主上下文：解析到活跃 Agent 的上下文。
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    // 直接委托给内部解析。
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    // 带着已保留的精确观察去解析，避免重复观察。
    return this.resolve(observation.header.id, observation)
  }

  // 内部解析：合并活跃查询、归属检查与去重恢复。
  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    // 已有活跃 Agent：直接按归属策略返回。
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    // 已附着的会话若归属子代理路由：返回稳定的所有权拒绝。
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(attached)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    // 复用进行中的恢复；没有则发起并登记，结束后自动移除。
    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      // 等待共享恢复完成。
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      // 共享的恢复可能在所有等待者感知之前就发布了被子代理路由收养的身份；
      // 因此再次套用活跃所有权策略。
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      // 会话不存在：转换为稳定的 not-found 远端错误。
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      // 子代理所有权：转换为稳定拒绝。
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      // 恢复失败但竞争者已发布活跃 Agent：直接采用。
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      // 竞争者已附着会话且归属子代理：返回所有权拒绝。
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(racedSession)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      // 写入者被他人持有：转换为 writer-held 远端错误。
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      // 其余失败：包装为网关内部错误。
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Create a Session for a new conversation, reusing the named blank Session
   * while it is still reusable. A reused Session runs the requested preset, or
   * the configured default when the request names none; the preset it recorded
   * is not resolved, and a change is logged as `agent-preset/selected` before
   * the Agent is published. A named Session that has started a turn, fails the
   * caller's placement rule, or is written by another owner stays unchanged,
   * and a new Session is created instead. Requests naming one identity run in
   * arrival order, including their preset resolution, and check the named
   * Session's directory and ownership before resolving the preset.
   * @param request - optional Session to reuse, directory, preset, and placement rule.
   * @returns the reused or created Session and the preset it ran when this request finished.
   * @throws ApiSessionCwdConflict when the named Session belongs to another directory.
   * @throws ApiSessionSubagentOwnership when subagent routing owns the named Session.
   * @throws RemoteError `agent-preset/not-found` or `agent-preset/invalid` for the requested or default preset.
   * @throws ApiSessionPresetConflict when no roster is composed and the request names a preset for a reused Session.
   */
  async createSession(request: ApiSessionCreateRequest): Promise<ApiSessionCreated> {
    // 取请求指名的会话 id（可为空）。
    const named = request.sessionId
    // 未指名：直接铸造新会话并组装结果。
    if (named === undefined) return this.created(await this.createMinted(request.cwd, await this.composeAgent(request.agentPreset)))
    // 指名：按到达顺序串行处理认领。
    return this.inOrder(named, async () => this.created(await this.claim(named, request)))
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined without a preset service or recorded selection.
   */
  presetForSession(session: Session): string | undefined {
    // 从预设服务读取会话当前预设；无服务或未记录则 undefined。
    return this.ctx.get('agentPresets')?.presetForSession(session) ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    // 把操作接到该 Agent 的准入链尾部。
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    // 用吞掉结果的 settled 形态更新链尾，避免链持有业务结果。
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    // 返回业务结果 Promise。
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<ApiSessionComposition> {
    // 取 Agent 预设注册表服务。
    const presets = this.ctx.get('agentPresets')
    // 无名册：只安装模型选择，不记录预设。
    if (presets === undefined) {
      return { setup: (agentCtx) => { installModelSelection(agentCtx) } }
    }
    // 解析请求预设（缺省时解析默认预设）的 id。
    const resolvedId = (await presets.resolve(presetId)).id
    // 返回解析后的预设与发布前装配：装模型选择，再挂载预设。
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  // 查询活跃 Agent 并套用所有权策略；无活跃或归属子代理时返回 undefined。
  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    // 取活跃 Agent。
    const agent = this.ctx.agents.get(sessionId)
    // 无活跃 Agent。
    if (agent === undefined) return undefined
    // 归属子代理路由：返回错误结果；否则返回 Agent。
    return hasApiSessionSubagentOwner(agent.session)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  // 恢复会话到活跃 Agent：优先使用调用方提供的观察，否则自行观察。
  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    // 已带精确观察：直接恢复。
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      // 自行观察会话（using 确保观察句柄释放）。
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      // 会话不存在：转换为领域内错误。
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      // 其余错误原样上抛。
      throw error
    }
  }

  // 基于精确观察执行恢复：校验后组装预设并交给 Agent 注册表。
  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    // 观察与请求身份不符或没有 cwd：视为不存在。
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    // 观察显示归属子代理路由：抛所有权错误。
    if (hasApiSessionSubagentOwner({ header: observation.header })) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    // 按观察记录的预设组装装配。
    const composition = await this.composeAgent(this.presetForObservation(observation))
    // 发布前再查一次附着会话的归属。
    const published = this.ctx.sessions.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(published)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    // 交给 Agent 注册表恢复并返回其 Agent。
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  // 按会话 id 把操作串行化到认领链上，保证到达顺序执行。
  private async inOrder<Value>(sessionId: SessionId, operation: () => Promise<Value>): Promise<Value> {
    // 把操作接到该会话的认领链尾部。
    const result = (this.claims.get(sessionId) ?? Promise.resolve()).then(operation)
    // settled 形态用于占住链位（吞掉结果，不阻断后续）。
    const settled = result.then(() => undefined, () => undefined)
    this.claims.set(sessionId, settled)
    try {
      // 等待本操作的业务结果。
      return await result
    } finally {
      // 若链尾仍是本操作，则清理，避免累积。
      if (this.claims.get(sessionId) === settled) this.claims.delete(sessionId)
    }
  }

  /** @returns the reused Session, a new Session under `sessionId` when none is stored, or a new Session under a minted identity. */
  private async claim(sessionId: SessionId, request: ApiSessionCreateRequest): Promise<Agent> {
    // 查看已附着的会话与活跃 Agent。
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    // 附着会话归属子代理路由：抛所有权错误。
    if (attached !== undefined && hasApiSessionSubagentOwner(attached)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    // 有活跃 Agent：校验目录后尝试复用，失败则铸造新会话。
    if (live !== undefined) {
      // 活跃会话目录与请求不符：抛 cwd 冲突。
      if (live.session.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd)
      }
      // 组装请求预设。
      const composition = await this.composeAgent(request.agentPreset)
      // 可复用则复用；否则铸造新会话。
      return await this.reuseLive(live, request, composition) ?? this.createMinted(request.cwd, composition)
    }
    // 观察持久化中的会话。
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      // 仅“会话不存在”时按新会话创建；其余错误上抛。
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      return this.createAgent(sessionId, request.cwd, await this.composeAgent(request.agentPreset))
    }
    // 复用判定占位。
    let reusable: boolean
    {
      // 在观察句柄存续期间完成检查（using 确保释放）。
      using observed = observation
      // 归属子代理路由：抛所有权错误。
      if (hasApiSessionSubagentOwner({ header: observed.header })) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      // 目录不符：抛 cwd 冲突。
      if (observed.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd)
      }
      // 复用条件：放置规则允许且会话尚未开始任何一轮对话。
      reusable = request.reusable(sessionId) && !observed.events.some(event => event.type === 'turn/start')
    }
    // 组装请求预设。
    const composition = await this.composeAgent(request.agentPreset)
    // 不可复用：铸造新会话。
    if (!reusable) return this.createMinted(request.cwd, composition)
    // 无名册时不允许对复用会话指名预设。
    this.assertPresetApplicable(sessionId, request.agentPreset)
    try {
      // 尝试恢复复用会话，装配会重新校验空白性并记录预设变更。
      return (await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: this.reuseSetup(composition),
      })).agent
    } catch (error: unknown) {
      // 观察后、取得写入者前已开始对话：改铸新会话。
      if (error instanceof ApiSessionStartedSinceObserved) return this.createMinted(request.cwd, composition)
      // 非“写入者被持有”错误：上抛。
      if (!(error instanceof Error) || error.name !== 'SessionAlreadyOwnedError') throw error
      // Another resume in this process may hold the writer for the Agent it published.
      // 本进程中的另一个恢复可能正为它发布的 Agent 持有写入者。
      return this.ctx.agents.get(sessionId) === undefined
        ? this.createMinted(request.cwd, composition)
        : this.claim(sessionId, request)
    }
  }

  /** @returns the live blank Session under the requested preset, or undefined when it cannot be reused. */
  private async reuseLive(
    live: Agent,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent | undefined> {
    // 放置规则不允许或会话非空白：不可复用。
    if (!request.reusable(live.id) || !this.isBlank(live.session)) return undefined
    // 无名册时不允许对复用会话指名预设。
    this.assertPresetApplicable(live.id, request.agentPreset)
    // 记录会话当前预设。
    const current = this.presetForSession(live.session)
    // 取预设注册表服务与目标预设。
    const presets = this.ctx.get('agentPresets')
    const target = composition.agentPreset
    // 无名册、未指名目标或目标与当前一致：直接复用现会话。
    if (presets === undefined || target === undefined || target === current) return live
    try {
      // 切换活跃会话的预设。
      await presets.select(live, target)
    } catch (error: unknown) {
      // 预设被锁定：视为不可复用（返回 undefined 让调用方另铸会话）。
      if (remoteErrorOf(error)?.code !== 'agent-preset/locked') throw error
      return undefined
    }
    // 复用现会话。
    return live
  }

  /** Setup that re-checks blankness under the acquired writer, then records a preset change before publication. */
  private reuseSetup(composition: ApiSessionComposition): AgentSetup {
    // 返回装配回调：在取得写入者后运行。
    return async (agentCtx, agent) => {
      // 写入者之下复查空白性：已被开始过的会话拒绝复用。
      if (!this.isBlank(agent.session)) throw new ApiSessionStartedSinceObserved()
      // 执行组装阶段准备好的发布前装配。
      const commit = await composition.setup(agentCtx, agent)
      // 目标预设与会话记录不一致：在发布前把预设变更写入会话。
      const target = composition.agentPreset
      if (target !== undefined && this.presetForSession(agent.session) !== target) {
        agent.session.append('agent-preset/selected', { agentPreset: target })
      }
      // 透传装配提交结果。
      return commit
    }
  }

  /** Whether no turn has started, by the predicate the preset registry's `select` enforces. */
  private isBlank(session: Session): boolean {
    // 取会话的轮次边界信息。
    const boundary = this.ctx.agents.turnBoundaryOf(session)
    // 无开启中的轮次起点且从未有过轮次：视为空白。
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }

  /** Without a roster, reuse cannot apply a named preset. */
  private assertPresetApplicable(sessionId: SessionId, requested: string | undefined): void {
    // 未指名预设或已组装名册：允许。
    if (requested === undefined || this.ctx.get('agentPresets') !== undefined) return
    // 无名册却指名预设：抛冲突。
    throw new ApiSessionPresetConflict(sessionId, requested)
  }

  // 组装创建结果：附带请求结束时该会话运行的预设。
  private created(agent: Agent): ApiSessionCreated {
    return { agent, agentPreset: this.presetForSession(agent.session) }
  }

  // 铸造一个全新身份的会话并创建 Agent。
  private createMinted(cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    return this.createAgent(brandString<SessionId>(`session-${randomUUID()}`), cwd, composition)
  }

  // 以给定身份创建 Agent：先确保目录存在，再交给 Agent 注册表。
  private async createAgent(sessionId: SessionId, cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    try {
      // 递归创建项目目录。
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      // 目录创建失败：包装错误并保留原因。
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    // 创建 Agent：元数据携带 cwd 与可选预设。
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })).agent
  }

  // 构造跟随部署默认模型变化的 Agent 选项。
  private agentOptions(): AgentOptions {
    // 取默认模型服务。
    const defaults = this.ctx.agentDefaultModel
    // A Session that records no selection or request follows default changes.
    // 未记录选择或请求的会话会跟随默认值的变化。
    return {
      // 动态读取默认提供方。
      get provider() { return defaults.currentSelection().provider },
      // 动态读取默认模型。
      get model() { return defaults.currentSelection().model },
      // 动态读取默认推理档位。
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    // 观察缺少投影快照：激活流程无法读取预设，直接报错。
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    // 从投影值中读当前预设；未记录则 undefined。
    return observation.projections.values.agentPreset ?? undefined
  }
}
