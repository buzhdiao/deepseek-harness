/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes persistent harness sessions to trusted programmatic
 * clients. It carries standard configuration, MCP mounts, prompt content,
 * committed semantic updates, cancellation, and one-shot permission decisions;
 * presentation and human-interaction features stay with the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */
// 基于JSON-RPC stdio 的仅自动化（automation-only）Agent Client Protocol 服务器（详见
// 上方英文说明）：把持久 harness 会话暴露给受信任的编程客户端，承载标准配置、MCP
// 挂载、提示内容、已提交语义更新、取消与一次性权限决定；展示与人际交互特性留在
// harness 的 UI 模块。

import type { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context 类型。
import { Buffer } from 'node:buffer'
// 导入 Buffer：用于游标（cursor）的 base64url 编解码与字节比较。
import { randomUUID } from 'node:crypto'
// 导入 randomUUID：为新建会话生成随机 id。
import { realpath } from 'node:fs/promises'
// 导入 realpath：解析物理路径以比较目录同一性。
import { isAbsolute, resolve } from 'node:path'
// 导入路径工具：绝对路径判断与规范化。
import { Readable, Writable } from 'node:stream'
// 导入流工具：把进程 stdin/stdout 转为 Web 流。
import Schema from '@deepseek-ai/schemastery'
// 导入 Schemastery：声明插件配置模式。
import { brandString } from '@deepseek-ai/dsh-brand'
// 导入 brandString：为字符串附加品牌类型（如 SessionId）。
import { errorChain } from '@deepseek-ai/dsh-llm'
// 导入 errorChain：把错误及其原因链展开为一条诊断字符串。
import {
  agent as createAcpAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
// 导入 ACP SDK：agent 应用工厂、方法表、NDJSON 流、协议版本、请求错误，以及各请求/响应类型。
import type { SessionId } from '@deepseek-ai/dsh-session'
// 导入品牌化的会话 id 类型。
import type {} from '@deepseek-ai/dsh-session-persistence'
// 纯类型副作用导入：合并会话持久化的声明。
// Side-effect type import: declaration-merges the approval waterfall answered below.
// 纯类型副作用导入：合并下方要应答的审批（approval）瀑布声明。
import type {} from '@deepseek-ai/dsh-user-approval'
// 导入同包内容模块：图片能力判定。
import { supportsAcpImagePrompts } from './content.ts'
// 导入 MCP 配置错误类型。
import { AcpMcpConfigError } from './mcp.ts'
// 导入模型配置错误类型。
import { AcpModelConfigError } from './model-control.ts'
// 导入单个 ACP 会话的封装。
import { AcpSession } from './session.ts'

// 会话列表每页默认返回的最大摘要数。
const DEFAULT_SESSION_LIST_PAGE_SIZE = 100

// 插件名。
export const name = 'acp'
/** Core services required by the standard automation controls. */
// 标准自动化控制所需的核心服务：agent 工厂、llm、会话持久化与会话表。
export const inject = ['agents', 'llm', 'sessionPersistence', 'sessions']

/** Preserve invalid-parameter detail in the SDK wire error message. */
// 构造 invalid params 线上错误，把细节保留在 SDK 错误消息里。
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
// 构造 internal error 线上错误并保留失败细节；否则普通错误会变成泛化的内部错误。
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
// 插件配置：每个由 ACP 创建的 agent 所用的 provider/model 选择。
export interface AcpConfig {
  /** Provider route for created agents. */
  // 创建 agent 使用的 provider 路由。
  provider?: string
  /** Model name for created agents. */
  // 创建 agent 使用的模型名。
  model?: string
  /** Maximum summaries returned by one session/list page. */
  // session/list 单页返回的最大摘要数。
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  // 仅运行时使用的传输覆盖（测试注入用）；生产环境使用 stdio。
  stream?: Stream
}

// 配置模式：声明各字段类型与默认值。
export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  sessionListPageSize: Schema.natural().min(1).default(DEFAULT_SESSION_LIST_PAGE_SIZE),
})

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
// 挂载仅自动化的 ACP 服务器（插件入口）。
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  // ACP 处理器在本插件注入作用域之外执行，因此必须在 apply 期间捕获注入服务，
  // 而不是在回调里延迟读取。
  const persistence = ctx.sessionPersistence
  const logger = ctx.logger
  // 解析并校验会话列表页大小。
  const sessionListPageSize = resolveSessionListPageSize(config.sessionListPageSize)
  // 桥接持有的活动会话表：会话 id -> AcpSession 记录。
  const sessions = new Map<SessionId, AcpSession>()
  // 正在恢复（激活中）的会话 id 集合，防止并发 resume。
  const activating = new Set<SessionId>()
  // 桥接是否已关闭（进入静默流程）。
  let closed = false
  // 初始化时探测并缓存的图片提示能力。
  let imagePromptEnabled = false

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  // 返回该 agent 对应的桥接记录；同 id 的冒名 agent 一律拒绝。
  const ownedRecord = (agent: Parameters<AcpSession['owns']>[0]): AcpSession | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.owns(agent) === true ? record : undefined
  }

  // 断言桥接仍在服务；已处置则抛内部错误。
  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  // 按会话 id 取记录；不存在则按参数非法报错。
  const requireSession = (sessionId: SessionId): AcpSession => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  // 发送一条有序协议更新；仅吞掉传输层失败（记录警告，不上抛）。
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.notify(methods.client.session.update, notification)
    /* v8 ignore start -- the ACP SDK contains notification-handler failures; only a transport write failure reaches this guard. */
    } catch (error: unknown) {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    }
    /* v8 ignore stop */
  }

  // 订阅会话事件：仅转发给本桥接拥有的会话记录。
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record?.ownsSession(session) === true) record.onSessionEvent(session, event)
  })

  // 订阅收件箱领取事件，转发给拥有该 agent 的记录。
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    ownedRecord(agent)?.onInboxClaimed(message, turn)
  })

  // 订阅 agent 错误事件，转发给拥有该 agent 的记录。
  ctx.on('agent/error', ({ agent, error }) => {
    ownedRecord(agent)?.onAgentError(error)
  })

  // 订阅 agent 状态事件，转发给拥有该 agent 的记录。
  ctx.on('agent/status', ({ agent, status }) => {
    ownedRecord(agent)?.onAgentStatus(status)
  })

  // 订阅 llm 适配器更新：拓扑变化时通知所有活动会话刷新配置项。
  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) record.topologyChanged()
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  // 权限请求是面向 ACP 客户端（如 dsh-subagent-acp）的机器策略通道。
  // 桥接只提供一次性选项，绝不从未知客户端响应推断持久授权。
  ctx.on('approval/request', (request, next) => {
    // 仅处理本桥接拥有且带工具调用 id 的请求，其余交给下游。
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const callId = request.callId
    // 先排空该会话的待发更新，再向客户端发起权限请求。
    return record.drainUpdates().then(() => {
      // 构造 ACP requestPermission 参数：仅“允许一次”与“拒绝”两个一次性选项。
      const params: RequestPermissionRequest = {
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
      // 向客户端发送权限请求。
      return conn.request(methods.client.session.requestPermission, params)
    }).then(({ outcome }) => {
      // 客户端取消映射为 cancelled。
      if (outcome.outcome === 'cancelled') return 'cancelled'
      // 选项 id 映射回 harness 的一次性决定。
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  // ACP 方法实现表。
  const implementation = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else
      // the latest supported" both resolve to this server's one version.
      // 单版本 agent：规范中“支持则同版本，否则最新支持版本”都解析为本服务器唯一版本。
      // 探测并缓存图片提示能力。
      imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          // 声明支持 HTTP 型 MCP 服务器。
          mcpCapabilities: { http: true },
          // 提示能力：图片视探测结果；音频与内嵌上下文不支持。
          promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
          // 会话能力：支持关闭、列表与恢复。
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        // 不提供认证方法。
        authMethods: [],
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      // 无认证需求，直接成功。
      return Promise.resolve()
    },

    async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // 校验工作区参数（cwd 绝对路径、不接受 additionalDirectories）。
      validateWorkspaceParams(params)
      // 生成新的品牌化会话 id。
      const sessionId = brandString<SessionId>(randomUUID())
      // No preset composition: the ACP bundle keeps the model-facing rows in
      // the host plane, so this agent reads them from the global layer. A
      // deployment that configures a roster has to join one here first
      // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
      // 不做预设组合：ACP bundle 把模型相关行放在宿主平面，本 agent 从全局层读取；
      // 需要名册的部署必须先在此加入预设。
      let record: AcpSession
      try {
        // 创建底层会话与 agent。
        record = await AcpSession.create(ctx, {
          sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          agentOptions: agentOptions(config),
          signal,
          notify,
        })
      } catch (error: unknown) {
        // MCP 配置错误透传为参数非法。
        if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
        throw error
      }
      // 创建期间连接可能已关闭：关闭刚创建的会话并报内部错误。
      /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
      if (closed) {
        await record.close('connection closed during session/new')
        throw internalError('connection closed during session/new')
      }
      // 登记到活动会话表。
      sessions.set(sessionId, record)
      try {
        // 枚举该会话可用的配置选项。
        const configOptions = await record.configOptions(signal)
        assertOpen()
        // The attached log writer's flush materializes an empty session durably.
        // 附加日志写入器的 flush 会把空会话持久化落盘。
        await ctx.sessions.flush(record.agent.session)
        assertOpen()
        // 返回会话 id 与配置选项。
        return { sessionId, configOptions }
      } catch (error: unknown) {
        // 激活失败：移出会话表并关闭记录，再上抛原始错误。
        sessions.delete(sessionId)
        await record.close('session/new activation failed')
        throw error
      }
    },

    async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // 校验工作区参数。
      validateWorkspaceParams(params)
      // 目标会话 id。
      const sessionId = brandString<SessionId>(params.sessionId)
      // 已活动、正在激活或已在宿主会话表中的会话不可再次恢复。
      if (sessions.has(sessionId) || activating.has(sessionId) || ctx.sessions.get(sessionId) !== undefined) {
        throw invalidParams(`session is already active: ${sessionId}`)
      }
      // 标记为激活中，防止并发。
      activating.add(sessionId)
      return (async (): Promise<ResumeSessionResponse> => {
        // 查询持久化会话的头信息。
        const persisted = (await persistence.stat(sessionId, { signal }))?.header
        // 不存在或属于子代理的会话不可恢复。
        if (persisted === undefined || persisted.origin === 'subagent') {
          throw invalidParams(`session is not resumable: ${sessionId}`)
        }
        // 工作目录不一致则拒绝恢复。
        if (!await sameDirectory(persisted.cwd, params.cwd)) {
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        let record: AcpSession
        try {
          // 恢复底层会话与 agent。
          record = await AcpSession.resume(ctx, {
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            agentOptions: agentOptions(config),
            signal,
            notify,
          })
        } catch (error: unknown) {
          // MCP 配置错误透传为参数非法。
          if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
          throw error
        }
        /* v8 ignore start -- the persisted header was checked before resume; the factory restores that exact header. */
        // 恢复后再次核对 cwd（持久头已在前面校验过，工厂恢复的就是该头）。
        if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {
          await record.close('session/resume cwd mismatch')
          throw invalidParams(`session cwd does not match: ${params.cwd}`)
        }
        /* v8 ignore stop */
        // 恢复期间连接可能已关闭：关闭刚恢复的会话并报内部错误。
        /* v8 ignore next 4 -- a real stdio close can race an in-flight resume. */
        if (closed) {
          await record.close('connection closed during session/resume')
          throw internalError('connection closed during session/resume')
        }
        // 登记到活动会话表。
        sessions.set(sessionId, record)
        try {
          // 枚举恢复会话的配置选项并返回。
          return { configOptions: await record.configOptions(signal) }
        } catch (error: unknown) {
          // 选项发现失败：移出会话表并关闭记录，再上抛。
          sessions.delete(sessionId)
          await record.close('session/resume option discovery failed')
          throw error
        }
      })().finally(() => { activating.delete(sessionId) })
    },

    async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // cwd 若提供必须是绝对路径。
      if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      }
      // 解码分页游标；非法游标按参数非法报错。
      let cursor: SessionListCursor | undefined
      try {
        cursor = decodeSessionListCursor(params.cursor)
      } catch (error: unknown) {
        throw invalidParams((error as Error).message)
      }
      // 列出全部持久化会话。
      const listed = await persistence.list({ signal })
      // 并发过滤每个会话头。
      const filtered = await Promise.all(listed.map(async ({ header }) => {
        if (
          // 排除：已被本桥接或宿主持有、正在激活、子代理会话、无 cwd 或 cwd 非绝对路径。
          sessions.has(header.id)
            || activating.has(header.id)
            || ctx.sessions.get(header.id) !== undefined
            || header.origin === 'subagent'
            || header.cwd === undefined
            || !isAbsolute(header.cwd)
        ) return undefined
        // 指定 cwd 过滤时目录不一致的排除。
        if (params.cwd !== undefined && params.cwd !== null && !await sameDirectory(header.cwd, params.cwd)) {
          return undefined
        }
        // 保留的列表条目。
        return { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
      }))
      // 剔除 undefined 后按创建时间倒序，稳定平局用会话 id 字节序。
      const entries = filtered
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((left, right) => right.createdAt - left.createdAt || compareSessionIds(left.sessionId, right.sessionId))
      // 游标之后（更新）的剩余条目。
      const remaining = cursor === undefined
        ? entries
        : entries.filter(entry => isAfterSessionListCursor(entry, cursor))
      // 截取一页。
      const page = remaining.slice(0, sessionListPageSize)
      // 还有剩余时用页尾条目生成续页游标。
      const next = remaining.length > page.length ? page.at(-1) : undefined
      return {
        sessions: page.map(({ sessionId, cwd }) => ({ sessionId, cwd })),
        ...next === undefined ? {} : { nextCursor: encodeSessionListCursor(next) },
      }
    },

    async setSessionConfigOption(
      params: SetSessionConfigOptionRequest,
      signal: AbortSignal,
    ): Promise<SetSessionConfigOptionResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // 找到目标会话记录。
      const record = requireSession(brandString<SessionId>(params.sessionId))
      try {
        // 应用配置项并返回最新选项列表。
        return { configOptions: await record.setConfig(params.configId, params.value, signal) }
      } catch (error: unknown) {
        // 模型配置错误透传为参数非法。
        if (error instanceof AcpModelConfigError) throw invalidParams(error.message)
        throw error
      }
    },

    async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // 目标会话 id 与记录。
      const sessionId = brandString<SessionId>(params.sessionId)
      const record = requireSession(sessionId)
      try {
        // 关闭会话。
        await record.close('ACP session closed')
      } catch (error: unknown) {
        // 关闭失败归为内部错误并携带错误链。
        throw internalError(`session close failed: ${errorChain(error)}`)
      } finally {
        // 无论成败都从会话表移除（仅当仍是该记录）。
        if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      }
      return {}
    },

    async prompt(params: PromptRequest, requestSignal: AbortSignal): Promise<PromptResponse> {
      // 桥接已关闭则拒绝。
      assertOpen()
      // 找到目标会话记录并转发提示。
      const record = requireSession(brandString<SessionId>(params.sessionId))
      return record.prompt(params, imagePromptEnabled, requestSignal)
    },

    cancel(params: CancelNotification): Promise<void> {
      // 找到目标会话并请求取消；不存在的会话静默忽略。
      sessions.get(brandString<SessionId>(params.sessionId))?.cancel()
      return Promise.resolve()
    },
  }

  // 生产环境用进程 stdin/stdout 构造 NDJSON 流；测试可注入 config.stream 覆盖。
  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  // 创建 ACP agent 应用并逐一登记请求/通知处理器，转发到实现表。
  const app = createAcpAgentApp({ name: 'deepseek-harness-acp' })
    .onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params))
    .onRequest(methods.agent.authenticate, async ({ params }) => {
      await implementation.authenticate(params)
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params))
  // 把应用连接到流。
  const connection = app.connect(stream)
  // 客户端方向上下文：用于向客户端发通知与请求。
  const conn: AgentContext = connection.client

  // 静默（quiesce）Promise 缓存，保证只执行一次。
  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    // 已在静默中则复用同一 Promise。
    if (quiescing !== undefined) return quiescing
    // 标记关闭：后续请求都会被拒绝。
    closed = true
    // 捕获当前全部会话记录。
    const records = [...sessions.values()]
    // AcpSession.close cancels synchronously before its first await, so every owned
    // prompt stops before any descendant or persistence drain can block.
    // AcpSession.close 在首个 await 前同步取消，因此所有被持有的提示在任何
    // 后代或持久化排空可能阻塞之前就已停止。
    quiescing = (async () => {
      // 并发关闭全部会话（各自成败互不影响）。
      const disposals = await Promise.allSettled(records.map(record => record.close('ACP bridge disposed')))
      for (const record of records) {
        // 仅当会话表仍映射到该记录时才移除。
        /* v8 ignore next -- closed blocks concurrent handlers; each captured record remains mapped until this loop. */
        if (sessions.get(record.agent.session.id) === record) sessions.delete(record.agent.session.id)
      }
      // 收集关闭失败的会话。
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        // 生产消费方用 `String` 打印该 AggregateError（只显示 message），因此把每个
        // 会话的诊断（含嵌套原因与聚合成员）全部嵌入消息中。
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  // 监听连接关闭：传输层出错仅记录警告，随后触发静默；静默失败也只记录警告。
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  // 注册插件清理效果：宿主释放时静默全部会话。
  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
// 从插件配置构造 per-agent 选项；未配置的可选字段保持缺席（不写 undefined）。
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

// 会话列表游标：排序键（创建时间 + 会话 id）。
interface SessionListCursor {
  createdAt: number
  sessionId: string
}

/** Resolve and validate the deployment-owned session page limit. */
// 解析并校验部署方持有的会话页大小。
function resolveSessionListPageSize(value: number | undefined): number {
  // 未配置时使用默认值。
  const resolved = value ?? DEFAULT_SESSION_LIST_PAGE_SIZE
  /* v8 ignore start -- Cordis applies the positive-integer Config schema; this protects direct apply callers. */
  // Cordis 已用 Config 模式校验；这里是保护直接调用 apply 的调用方。
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('acp: sessionListPageSize must be a positive safe integer')
  }
  /* v8 ignore stop */
  return resolved
}

/** Decode an opaque keyset cursor without assigning meaning to client metadata. */
// 解码不透明的键集（keyset）分页游标；不赋予客户端元数据任何语义。
function decodeSessionListCursor(value: string | null | undefined): SessionListCursor | undefined {
  // 缺省视为第一页。
  if (value === undefined || value === null) return undefined
  // 字符集白名单（base64url 字母表）先行校验。
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('session/list cursor is invalid')
  try {
    // base64url 解码后按 JSON 解析。
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    // 期望形如 [createdAt, sessionId] 的二元数组。
    const createdAt: unknown = Array.isArray(decoded) ? decoded[0] : undefined
    const sessionId: unknown = Array.isArray(decoded) ? decoded[1] : undefined
    if (
      // 结构校验：数组、长度 2、非负安全整数时间戳、非空字符串 id。
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof sessionId !== 'string'
      || sessionId.length === 0
    ) throw new Error('invalid cursor fields')
    // 规范化校验：重新编码必须与输入完全一致，拒绝任何非规范形式。
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== value) throw new Error('non-canonical cursor')
    // 返回游标键。
    return { createdAt, sessionId }
  } catch (_invalidCursor) {
    // 任何解析失败统一报游标非法。
    throw new Error('session/list cursor is invalid')
  }
}

/** Encode the last returned ordering key as an opaque continuation token. */
// 把最后返回的排序键编码为不透明的续页令牌。
function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.createdAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** Test whether an entry follows the cursor in newest-first list order. */
// 判断条目在“最新在前”的列表顺序中是否排在游标之后。
function isAfterSessionListCursor(entry: SessionListCursor, cursor: SessionListCursor): boolean {
  return entry.createdAt < cursor.createdAt
    || (entry.createdAt === cursor.createdAt && compareSessionIds(entry.sessionId, cursor.sessionId) > 0)
}

/** Compare opaque session ids by stable UTF-8 bytes, independent of process locale. */
// 按 UTF-8 字节稳定比较不透明会话 id，不受进程区域设置影响。
function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Reject workspace features outside the automation contract. */
// 拒绝自动化契约之外的工作区特性：cwd 必须绝对路径、不支持附加目录。
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] | null }): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined
    && params.additionalDirectories !== null
    && params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** Compare existing directories by physical identity and missing paths lexically. */
// 比较目录：存在者按物理同一性（realpath），缺失者按规范化路径字面比较。
async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  // 左侧缺失视为不同。
  if (left === undefined) return false
  try {
    // 双方解析物理路径后比较。
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch (_unresolvablePath) {
    // 无法解析（路径不存在等）时退回规范化字符串比较。
    return resolve(left) === resolve(right)
  }
}
