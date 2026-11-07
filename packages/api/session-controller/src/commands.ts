// Session（会话）命令层：每个 Remote 方法的激活（activation）策略都在调用点显式声明。
/** Session commands whose activation policy is explicit at each Remote method. */

// ProjectionHandle（投影句柄）：会话投影注册后返回的操作句柄。
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
// 续聊投影定义与状态类型。
import { continuationProjectionDefinition, type ContinuationState } from './continuation.ts'

// 模型可用性查询。
import { modelAvailable } from './catalog.ts'
// randomUUID：生成随机会话/请求标识。
import { randomUUID } from 'node:crypto'
// cordis 的 Context 类型：宿主（Host）依赖注入上下文。
import type { Context } from '@deepseek-ai/cordis'
// brandString：把字符串收窄为品牌类型。
import { brandString } from '@deepseek-ai/dsh-brand'
// Agent 与模型选择类型。
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
// AttachmentError（附件错误）：附件子系统的错误类型。
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
// 附件准入部分（admission part）类型。
import type {
  AttachmentAdmissionPart,
} from '@deepseek-ai/dsh-attachment'
// 上传回执 id 与暂存附件类型。
import type { FileUploadReceiptId, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload/types'
// 副作用导入：拉取客户端文件上传的类型环境。
import type {} from '@deepseek-ai/dsh-client-file-upload'
// LLM 工具：推理力度 id、创建用户消息、冻结消息。
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
// 消息 id 与消息来源类型。
import type { MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
// 分叉种子（fork seed）构建器。
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
// 日志偏移与会话序号品牌构造器。
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
// 会话核心类型：实体、事件、头部、id、用户消息。
import type { Session, SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
// 会话查询错误与观察类型。
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
// 会话标题非法错误。
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
// assertNever：闭合联合的穷尽性守卫。
import { assertNever } from '@deepseek-ai/dsh-util-values'
// 远程错误构造与识别工具。
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// Workspace（工作区）类型。
import type { Workspace } from '@deepseek-ai/dsh-workspace'
// Agent 控制器：会话创建/恢复/组合的唯一所有者及其错误类型。
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  type ApiSessionCreated,
} from './agent.ts'
// 本包类型：各 Session 命令的请求/结果形状。
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'

// 提示内容候选：来自提交或队列编辑动作的内容部件联合。
type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

/**
 * Whether prompt content carries non-whitespace text or an attachment.
 * @param content - submitted or edited prompt parts.
 * @returns whether any part supplies ordinary prompt content.
 */
// 判断提示内容是否携带非空白文本或附件。
export function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  // 任一部件非文本、或是带非空白内容的文本，即视为有实质内容。
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
// 解析省略 atSeq 时的默认分叉边界：最近一个已完成回合（turn）的前缀。
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  // 找最后一个 turn/end（回合结束）事件。
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  // 尚无完成回合：无可用默认边界。
  if (lastTurnEnd === undefined) return undefined
  // 初始边界为该回合结束事件的序号。
  let boundary = lastTurnEnd.seq
  // 向后扫过回合结束之后的事件，吞掉下一回合开始前的独立事件。
  for (const next of events.slice(boundary + 1)) {
    // 遇到新回合开始、追加的用户消息或收件箱拼接：停止扩展。
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    // 其余独立事件仍属于已完成前缀，扩展边界。
    boundary = next.seq
  }
  // 返回最终边界序号。
  return boundary
}

// Session 业务命令的实现体：由 Session Controller 远程服务委托调用。
/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  // 按精确 Session 缓存的"首次插入"事实（已见消息 id 与请求 id）；持久日志仍是恢复源头。
  /** First-insertion facts cached per exact Session; the log remains the recovery source. */
  private readonly promptReceipts = new WeakMap<Session, {
    // 已消费到的事件偏移。
    offset: SessionLogOffset
    // 已见过的消息 id 集合。
    messages: Set<MessageId>
    // 已接受的请求 id 集合。
    requests: Set<SessionRequestId>
  }>()

  // 续聊投影句柄：initialize 完成后可用（ definite assignment）。
  private continuation!: ProjectionHandle<ContinuationState>

  // 注册"完整历史上的空提示资格"投影；完成后命令准入才就绪。
  /** Register complete-history empty-prompt eligibility. @returns when command admission is ready. */
  async initialize(): Promise<void> {
    this.continuation = await this.ctx.sessionProjections.register(continuationProjectionDefinition)
  }

  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Agent composition.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create one ordinary Session for a new conversation, reusing the named
   * blank Session while it is an unarchived member of the requested Workspace.
   * @param request - optional blank Session to reuse, location, and Agent preset.
   * @returns the created or reused Session identity and its preset when configured.
   */
  // 创建新会话：允许复用请求工作区内未归档的空白会话。
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    // 工作区 id 与 cwd 不能同时指定。
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    // 解析后的工作区。
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      // 从注册表取指定工作区。
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        // 工作区不存在：拒绝创建。
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    // 工作目录优先级：工作区路径 > 显式 cwd > 默认目录。
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    // 创建结果。
    let created: ApiSessionCreated
    try {
      // 委托 Agent 控制器创建会话；可复用条件：未归档且（无工作区约束或属于该工作区）。
      created = await this.agents.createSession({
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        cwd,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        reusable: sessionId => !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
          && (workspace === undefined || workspace.sessionIds.includes(sessionId)),
      })
    } catch (error) {
      // 把创建失败翻译成对应的远程错误。
      this.rejectCreation(error)
    }
    // 取会话 id（即 Agent id）。
    const sessionId = created.agent.id
    if (workspace !== undefined) {
      try {
        // 把新会话挂载到工作区。
        await workspace.attachSession(sessionId)
      } catch (error) {
        // 挂载失败：会话已创建但不能对外，报专用错误。
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    // 返回会话 id 与可选的 Agent 预设。
    return { sessionId, ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }) }
  }

  /**
   * Validate and record one Session model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection recorded for the Session, without waiting for default persistence.
   */
  // 校验并记录一次模型选择；默认模型在后台异步保存。
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    // 先定位会话对应的 Agent。
    const agent = await this.resolveAgent(request.sessionId)
    // 图片准入串行化：模型切换与图片提示共享临界区。
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        // 校验请求的模型可用。
        await this.requireModel(request)
        // 归一化后的选择。
        const selected: AgentModelSelection = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        }
        // 借 LLM 服务解析调用配置，进一步验证选择合法。
        await this.ctx.llm.resolveCallConfig(selected)
        // 应用到当前 Agent。
        agent.model.select(selected)
        // 后台保存为默认选择；失败只记警告，不影响本次响应。
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
        // 返回选择副本。
        return { selected: { ...selected } }
      } catch (error) {
        // 已是远程错误的原样上抛。
        if (remoteErrorOf(error) !== undefined) throw error
        // 其余错误折叠成"模型不可用"。
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  // 归一化并追加用户提交的会话标题。
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    // 先定位会话对应的 Agent。
    const agent = await this.resolveAgent(request.sessionId)
    // 取标题服务。
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      // 部署未挂载标题服务：改名不可用。
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      // 执行改名并接受归一化标题。
      const accepted = titles.rename(agent.session, request.title)
      // 返回标题与其持久化事件序号。
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      // 标题非法：折叠成业务错误。
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      // 其余错误视为内部失败。
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  // 从源会话的精确事件前缀分叉出新会话；开切口的闭合事件由宿主合成。
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    // 归一化可选的 atSeq。
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      // 序号不合法：请求错误。
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    // 观察源会话。
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      // 源会话不存在：业务错误。
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      // 其他查询失败：内部错误。
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    // using 声明：观察句柄离开作用域时自动释放。
    using source = observed
    // 边界：显式 atSeq 优先，否则取最近完成回合前缀。
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      // 边界不存在（无完成回合或序号越界）：拒绝分叉。
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    // 用边界前缀构建分叉种子。
    const seed = buildForkSeed(source.events, boundary)
    // 解析子会话应归属的工作区。
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      // 工作区解析失败：内部错误。
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    // 生成新的子会话 id。
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    // 按源会话观察组合出子 Agent 的预设与装配。
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      // 读取当前默认模型选择作为子 Agent 的初始模型。
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      // 创建子会话：带种子、继承事件计数与元数据。
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      // 创建失败：内部错误。
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        // 把子会话挂载到工作区。
        await workspace.attachSession(childId)
      } catch (error) {
        // 挂载失败：子会话已分叉但不能入区。
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    // 返回子会话 id。
    return { sessionId: childId }
  }

  /**
   * Admit one prompt after Agent and attachment validation; the Remote method
   * has already validated the content and built the durable message source.
   * @param request - Session identity, prompt content, and delivery mode.
   * @param source - caller metadata recorded on the accepted ordinary or retry user message.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  // 准入一次提示（prompt）：内容校验已由 Remote 层完成，这里做 Agent 与附件校验。
  async prompt(request: SessionPromptRequest, source: MessageSource): Promise<SessionPromptValue> {
    // 定位会话对应的 Agent。
    const agent = await this.resolveAgent(request.sessionId)
    // 幂等：该请求 id 已被接受过，直接确认。
    if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
    // 空内容分支：尝试"生成续聊"（generation continuation）。
    if (request.content.length === 0) {
      try {
        // 在维护窗口内执行：避免与运行中的回合竞争。
        return await agent.runMaintenance(() => {
          // 读取当前收件箱状态。
          const inbox = agent.inbox
          // 非队列模式、无续聊资格、或已有待处理输入：拒绝续聊。
          if (request.mode !== 'queue' || this.continuation.stateOf(agent.session).ending === null
            || inbox.nextTurn.length > 0 || inbox.nextStep.some(message => message.source.kind === 'user')) {
            throw new RemoteError('session/agent-busy', 'generation continuation is unavailable', { reason: 'NO_CONTINUABLE_FAILURE_OR_PENDING_INPUT' })
          }
          // 追加一条空内容用户消息触发续聊回合。
          agent.followup(createUserMessage({ content: [], source }))
          return Promise.resolve({ accepted: true as const })
        })
      } catch (error: unknown) {
        // 已是远程错误的原样上抛。
        if (remoteErrorOf(error) !== undefined) throw error
        // 其余失败折叠成"续聊未接受"。
        throw new RemoteError('session/agent-busy', 'generation continuation was not accepted', { reason: String(error) })
      }
    }
    // 把文件部件解析成暂存附件（或图片），并收集涉及的回执 id。
    const admission = resolvePromptFileReceipts(
      request.content,
      receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
    )
    // Encoded images and image upload receipts both make an image prompt.
    // 编码图片与图片上传回执都构成"图片提示"。
    const hasImage = admission.content.some(part => part.type === 'image')
    // 准入过程：可串行化重入。
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        // 再次幂等检查：等待图片准入串行化期间可能已被接受。
        if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
        if (hasImage) {
          // 图片提示需检查当前模型是否支持图片输入。
          const current = agent.model.current()
          if (current !== undefined) {
            // 解析模型元信息。
            const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
            if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
              // 模型不支持图片输入：拒绝。
              throw new RemoteError(
                'session/attachment-invalid',
                `Model "${current.model}" does not support image input.`,
                { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              )
            }
          }
        }
        // 让附件服务准入提示内容（含文件下载/引用校验）。
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        // 准入完成后再做一次幂等检查。
        if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
        // 构建持久化用户消息。
        const message: UserMessage = createUserMessage({ content, source })
        if (this.ctx.agents.get(agent.id) !== agent) {
          // 准入期间 Agent 被替换/销毁：会话已不存在。
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        // using 声明：提示绑定离开作用域时自动回滚（未提交的回执释放）。
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        // 按模式投递：steer 打断当前回合，其余排入后续回合。
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        // 投递成功：提交回执绑定，阻止回滚。
        binding.commit()
      } catch (error) {
        // 竞态：失败前已被接受则视为成功。
        if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
        // 已是远程错误的原样上抛。
        if (remoteErrorOf(error) !== undefined) throw error
        // 附件错误折叠成附件非法。
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        // 其余失败折叠成"提示被拒"。
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      // 返回接受确认。
      return { accepted: true }
    }
    // 图片提示在串行化临界区内准入，其余直接准入。
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  // 从未消费的日志条目恢复"首次输入接受"事实，包括已被认领或移除的消息。
  /** Recover first input acceptance, including claimed or removed messages, from unseen log entries. */
  private hasPromptRequest(session: Session, requestId: SessionRequestId): boolean {
    // 取该会话的回执缓存。
    let receipts = this.promptReceipts.get(session)
    if (receipts === undefined) {
      // 首次访问：初始化缓存。
      receipts = { offset: SessionLogOffset(0), messages: new Set(), requests: new Set() }
      this.promptReceipts.set(session, receipts)
    }
    if (receipts.offset !== session.seq) {
      // 消费自上次偏移以来的新事件。
      // oxlint-disable-next-line typescript/no-deprecated -- Existing prompt retry history read, retained for acceptance recovery.
      for (const event of session.snapshotEvents(receipts.offset)) {
        // 只关心收件箱拼接与用户消息两类事件。
        if (event.type !== 'agent/inbox/spliced' && event.type !== 'user/message') continue
        // 拼接事件展开为插入的消息列表；用户消息自成一组。
        const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : [event.data]
        for (const message of messages) {
          // 已登记过的消息跳过。
          if (receipts.messages.has(message.id)) continue
          receipts.messages.add(message.id)
          // A copied input is not a new request in the child, even if later reinserted there.
          // 分叉复制进来的输入不算子会话的新请求（即使之后又被重新插入）。
          if (event.seq < session.inheritedEventCount) continue
          // 取消息来源。
          const source = message.source
          // 用户或重试来源且带 rpcId：登记该请求为已接受。
          if ((source.kind === 'user' || source.kind === 'retry') && 'rpcId' in source) receipts.requests.add(source.rpcId)
        }
      }
      // 推进已消费偏移到当前序号。
      receipts.offset = session.seq
    }
    // 返回该请求 id 是否已被记录接受。
    return receipts.requests.has(requestId)
  }

  // 校验模型可用，不可用则抛出专用远程错误。
  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Read one durable image using the supplied reference without consulting Session history.
   * @param request - image reference and gateway permission scope; Session existence is not checked.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  // 按引用读取一张持久化图片（不查询会话历史）。
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    try {
      // 从附件服务读取图片字节。
      const stored = await this.ctx.attachments.readImage(request.attachment)
      return {
        // 回传存储引用。
        attachment: stored.ref,
        // 字节转为 base64 便于线上传输。
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      // 附件错误折叠成附件非法。
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      // 其余错误视为内部失败。
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  // 变更一条待处理的收件箱条目；必要时恢复冷（cold）Agent。
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // 队列编辑只接受文本内容。
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      // 编辑后的内容必须仍有非空白文本。
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    // 先看会话是否有存活 Agent。
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      // 无存活 Agent：尝试从持久层恢复。
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        // 会话不存在时按"队列项不再待处理"处理，其余错误上抛。
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      // 使用恢复出的 Agent。
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(agent.session)) {
      // 子代理会话：校验可续管（continuable）所有权与序号。
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        // 非可续管或不拥有该序号：拒绝越权变更。
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    // 在两个队列中定位目标条目。
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    // 归一化定位结果：next-turn 优先于 next-step。
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      // 找不到条目：已不再待处理。
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    // 取出目标与消息。
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      // 只有运行中 Agent 的下一回合才可转向（steer）。
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    // 按动作类型执行。
    switch (request.action.kind) {
      // 编辑：以新内容替换消息（冻结后写回收件箱）。
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      // 移除：删除条目并退役其上传回执。
      case 'remove': {
        agent.inbox.remove(request.itemId)
        // 取消息来源。
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          // 用户来源且带 rpcId：退役对应的暂存附件。
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      // 转向：从队列移除并立即打断当前回合。
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      // 穷尽性守卫：闭合联合不应到达此处。
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    // 返回应用确认。
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  // 取消存活的普通 Agent，但保留待处理的收件箱工作。
  cancel(request: SessionCancelRequest): SessionCancelValue {
    // 取存活 Agent。
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      // 未挂载即视为会话不存在。
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(agent.session)) {
      // 子代理会话不接受普通取消。
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    // 以用户身份取消，保留收件箱。
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  // 定位会话对应的存活 Agent；失败原样上抛。
  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  // 把会话创建失败翻译成对应的远程错误（never：必然抛出）。
  private rejectCreation(error: unknown): never {
    // 已是远程错误的原样上抛。
    if (remoteErrorOf(error) !== undefined) throw error
    // 预设冲突。
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
      })
    }
    // 工作目录冲突。
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    // 子代理所有权冲突。
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    // 其余折叠成内部错误。
    throw new RemoteError('gateway/internal', `failed to create session: ${String(error)}`, {})
  }

  // 为分叉出的子会话解析工作区：先查直接归属，再沿子代理谱系向上追溯。
  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    // 列出全部工作区。
    const workspaces = this.ctx.workspaceRegistry.list()
    // 源会话直接归属的工作区。
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    // 已找到或非子代理来源：直接返回。
    if (direct !== undefined || source.origin !== 'subagent') return direct
    // 追溯子代理的祖先谱系。
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    // 逐祖先寻找第一个包含它的工作区。
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    // 无工作区归属。
    return undefined
  }
}

// 把内容中的每个文件部件替换为其暂存回执对应的文件或图片。
/** Replace each file part with the file or image its staged receipt names. */
function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  staged: (receiptId: FileUploadReceiptId) => StagedAttachment | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  // 涉及的上传回执 id 集合。
  const receiptIds = new Set<FileUploadReceiptId>()
  // 逐部件解析。
  const resolved = content.map((part): AttachmentAdmissionPart => {
    // 非文件部件原样保留。
    if (part.type !== 'file') return part
    // 解析暂存附件。
    const attachment = staged(part.receiptId)
    if (attachment === undefined) {
      // 回执缺失：文件未上传到本会话。
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    // 登记回执 id。
    receiptIds.add(part.receiptId)
    // 用附件替换文件部件。
    return attachment
  })
  // 返回解析后的内容与回执列表（按首次出现顺序）。
  return { content: resolved, receiptIds: [...receiptIds] }
}
