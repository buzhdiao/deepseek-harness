// 模块说明：sessionSkillCatalog——`ctx.remote.skills` 命名空间的宿主服务：以 Session 为
// 寻址对象，在冷（未激活）状态下列出可由用户调用的技能；cwd 与 Agent 预设决定目录
// 视图，不加载技能正文。
/** Session-addressed, cold-readable skill catalog Remote. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 侧向类型引用：dsh-agent-preset-registry 提供的预设服务类型增强
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
// 导入 Session 查询错误类型，用于识别"Session 不存在"的情况
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
// 导入判断技能是否可被用户手动调用的谓词
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
// 侧向类型引用：dsh-working-directory 提供的工作目录服务类型增强
import type {} from '@deepseek-ai/dsh-working-directory'
// 导入作用域键（ScopeKey）类型
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// 导入 Typert 协议的 Remote 装饰器、RemoteError 与远程服务基类
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 导入本包定义的技能列表请求与返回值类型
import type { SkillListRequest, SkillListValue } from './types.ts'

// 扩充 cordis 的 Context 接口，把 sessionSkillCatalog 登记为宿主上下文上的服务
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 承载以 Session 为寻址对象的 `skills` Remote 命名空间的宿主服务。 */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/**
 * 宿主服务：为 `ctx.remote.skills` 提供后端实现，
 * 列出技能时不需要激活（唤醒）一个冷状态的 Agent。
 */
export class SessionSkillCatalog extends TypertRemoteService {
  // 声明依赖注入：agents（活动 Agent 表）、sessionQuery（Session 查询）、typert（协议）、workingDirectory（工作目录）
  static inject = ['agents', 'sessionQuery', 'typert', 'workingDirectory']

  /** @param ctx - 携带 Session 读取能力与可选技能/预设服务的宿主上下文。 */
  constructor(ctx: Context) {
    // 调用基类构造：以 'sessionSkillCatalog' 为服务名，远程命名空间为 'skills'
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * 列出某个 Session 组合（composition）可见的、可由用户调用的技能。
   * @param request - Session 标识，其 cwd 与预设（preset）决定目录视图。
   * @param signal - 由 Remote 传输层携带的调用方生命周期信号；已被受理的目录读取保持其原有完成语义。
   * @returns 可用户调用的技能元数据，不加载技能正文。
   * @throws 当 Session 无法检查或没有可用的注册表（registry）时抛出 RemoteError。
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    // 从请求中解构出 sessionId
    const { sessionId } = request
    // cwd：用于筛选技能的当前工作目录
    let cwd: string
    // agentPreset：Session 记录的 Agent 预设名（可能为空）
    let agentPreset: string | undefined
    try {
      // 通过 Session 查询服务对该 Session 进行只读观测（observeSession）
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      // 观测结果没有投影（projections）说明 Session 尚未被投影化，技能目录无法工作
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      // 确定 cwd：优先用投影值中的工作目录，其次用观测头部的 cwd，最后回退到宿主默认目录
      cwd = observation.projections.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      // 读取投影中的 Agent 预设（null 转为 undefined）
      agentPreset = observation.projections.values.agentPreset ?? undefined
      // 查看该 Session 是否已有活动（live）Agent
      const live = this.ctx.agents.get(sessionId)
      // 若 Agent 存活，则确保其当前工作目录最新（可能与投影记录不同步）
      if (live !== undefined) cwd = await this.ctx.workingDirectory.ensure(live, signal)
    } catch (error: unknown) {
      // Session 查询服务报告该 Session 不存在：映射为远程 "session/not-found" 错误
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      // 其余检查失败统一包装为网关内部错误，附带原始错误信息
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }

    // 再次获取该 Session 的活动 Agent（若存在）
    const live = this.ctx.agents.get(sessionId)
    // 获取宿主上的 Agent 预设注册服务（可选）
    const presets = this.ctx.get('agentPresets')
    // 活动存在时，按该 Agent 解析出其预设作用域下的技能服务
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    // 优先使用作用域化的技能注册表，否则回退到宿主全局注册的技能服务
    const skillRegistry = scoped ?? this.ctx.get('skills')
    // 没有任何技能注册表可用：说明既没有会话预设也没有宿主挂载技能服务，报内部错误
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    // 冷会话（无活动 Agent）时，按记录的预设获取一个临时的作用域租约（lease），
    // 使用 await using 确保作用域在使用完毕后自动释放
    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    // 实际使用的作用域：活动 Agent 本身，或临时租约的键
    const scope = live ?? lease?.key
    try {
      // 列出该 cwd 与作用域下的技能，并只保留可被用户手动调用的技能
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      // 映射为对外的技能元数据：名称、可选路径、描述、可选用途说明、是否可被模型调用
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          // path 仅在存在时输出（条件展开避免出现显式 undefined 字段）
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          // whenToUse 仅在存在时输出
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      // 技能列举失败统一包装为网关内部错误
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** 在不创建 Agent 的前提下，解析活动或预设对应的作用域（scope）。 */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    // 预设服务不存在时无法解析任何作用域
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      // 按预设名获取（可能为空）的作用域租约，租约带 AsyncDisposable 可自动释放
      return await presets.acquireScope(agentPreset)
    } catch {
      // 未知的或不可用的已记录预设：回退到全局注册表（返回 undefined 表示无作用域限制）
      return undefined
    }
  }
}

// 默认导出该服务类，便于宿主组合时统一引用
export default SessionSkillCatalog
