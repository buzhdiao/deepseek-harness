// 【中文逐行注释 · DSH 核心包 3：core/session/types.ts —— Session 事件词汇与类型】
// Session 是「代理交互的持久真相」：一个只追加（append-only）的事件日志，
// 模型可见的历史全部从它推导（“Model-visible ⟺ logged”原则）。本文件定义：
// 品牌化的 ID/序号类型、格式版本常量、SessionHeader 存储元数据、
// SessionEventMap（可追加事件的判别联合——插件通过声明合并扩展它）、
// 以及表面（surface）操作类型。读懂本文件就读懂了 DSH 的持久化词汇表。
import { brandNumber, brandString, type Branded, type BrandedNumber } from '@deepseek-ai/dsh-brand'
import type {
  AssistantMessage,
  DeveloperMessage,
  AssistantStreamRecord,
  ToolCallId,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  SystemMessage,
  SystemPromptUpdate,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Identifies one session in the store (and its persistence artifacts). */
// SessionId：品牌化字符串（AGENTS.md 约定：跨边界的 id 必须品牌化，不许裸 string）。
export type SessionId = Branded<'SessionId'>

/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string with the session-id brand.
 */
// SessionId()：把普通字符串铸造成 SessionId（运行时零开销，仅类型层）。
export function SessionId(id: string): SessionId {
  return brandString<SessionId>(id)
}

/** Sequence number of one existing event in a Session log. */
// SessionSeq：已存在事件的序号（品牌化数字）。
export type SessionSeq = BrandedNumber<'SessionSeq'>

/**
 * Admit a numeric value as an existing Session event position.
 * @param value - non-negative safe integer admitted by the owning log operation.
 * @returns the same number with the Session-sequence brand.
 */
// SessionSeq()：铸造时做运行时校验——必须是非负安全整数且非 -0
//（信任边界在铸造点：越界的数字根本进不了类型系统）。
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionSeq>(value)
}

/** A Session log gap, prefix length, or read offset, which may equal the event count. */
// SessionLogOffset：日志间隙/前缀长度/读取偏移——允许等于事件总数（越过末尾）。
export type SessionLogOffset = BrandedNumber<'SessionLogOffset'>

/**
 * Admit a numeric value as a Session log offset.
 * @param value - non-negative safe integer used as a gap or prefix length.
 * @returns the same number with the Session-log-offset brand.
 */
// SessionLogOffset()：同 SessionSeq 的校验式铸造。
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionLogOffset>(value)
}

/** Inclusive Session event watermark, or `-1` before any event exists. */
// SessionSeqCursor：水位游标——已见到的最后一个事件序号；尚无事件时为 -1。
export type SessionSeqCursor = SessionSeq | -1

/** One existing Session event position, or explicit absence. */
// OptionalSessionSeq：一个事件位置或显式缺席（null）。
export type OptionalSessionSeq = SessionSeq | null

/**
 * Current logical Session format version, stamped into every newly written
 * {@link SessionHeader}. Current Session and persistence code accept only this
 * value; header-only readers classify supported historical formats, while an
 * event-body read composes the build-static adjacent chain and publishes only
 * this final generation before constructing a Session.
 *
 * The version is a single monotonic integer with no major/minor split. Retain
 * it when older readers resume correctly, preserve safely ignorable records,
 * or refuse required features before execution, mutation, or tail repair.
 * New readers must preserve historical meanings, including logs mixing old
 * and new record representations. Bump when an existing discriminator cannot
 * prevent unsafe interpretation; a structural difference alone is insufficient.
 * Unknown fields and values require evidence of the released reader's actual
 * admission behavior. The per-event {@link SessionEvent.ignorable} marker
 * governs unknown event types, not arbitrary nested payload changes.
 * Same-version readers retain earlier representations: the adjacent migration
 * chain does not run when stored and current versions match. A subsequent
 * migration must account for all supported representations of its source.
 * Compatibility review and the retained migration obligations are recorded in
 * `.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md`.
 */
// SESSION_FORMAT_VERSION（上游注释详尽）：当前逻辑格式版本（写入每个新 header）。
// 单调整数、无主/次拆分。只有现有判别字段挡不住「不安全解读」时才允许升版；
// 同版本读取保留历史表示（相邻迁移链不跑）；每个迁移包负责 vN→vN+1 一步。
export const SESSION_FORMAT_VERSION = 4

/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
// SessionHeader：经校验、不可变的存储元数据（不进事件日志）。
export interface SessionHeader {
  /**
   * Current logical format version, stamped from {@link SESSION_FORMAT_VERSION}.
   * Historical physical headers are translated before entering this interface.
   */
  // 版本：新写入用当前常量；历史物理头先翻译再进入本接口。
  readonly version: typeof SESSION_FORMAT_VERSION
  /** The session's id (mirrors the {@link Session}'s id). */
  // 会话 id（与 Session.id 一致）。
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  // 创建时间（非负安全整数毫秒）。
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  // 创建时的工作目录（绝对路径，若有）。
  readonly cwd?: string
  /**
   * Direct creator of a subagent Session. Ordinary forks omit this field;
   * historical ordinary forks may retain their source id here. Presence alone
   * does not classify a Session as a subagent; use `origin` for that distinction.
   */
  // parentSession：子代理会话的直接创建者。普通 fork 不写；仅凭存在不判定
  // 「是子代理」，判定用 origin。
  readonly parentSession?: SessionId
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  // isSeeded：是否携带 fork 继承的事件前缀（精确长度属于会话状态而非头元数据）。
  readonly isSeeded: boolean
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  // origin：粗粒度产品分类（subagent）——展示元数据，不证明该子会话可续跑。
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  // delegationDepth：委派深度——持久化以让递归预算在重启/恢复后存活
  //（只存运行时的话，恢复的子会话会被错误地重置为顶层）。
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  // agentPreset：本会话 agent 组装所用的预设 id。必须持久化：预设决定工具与
  // 提示词——恢复成不同组合会让模型重放它已无法执行的历史。
  readonly agentPreset?: string
}

/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
// CreateSessionOptions：经 store 创建会话的选项——seed 是重放/fork 的历史，
// meta 是调用方提供的存储字段（store 折叠进 SessionHeader）。
export interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  // 构造时给定的初始重放或 fork 历史。
  readonly seed?: readonly SessionEvent[]
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. The
   * constructor appends the child-owned tagged marker at the cut unless
   * the seed already includes it followed by child-owned fork closers.
   */
  // inheritedEventCount：isSeeded 为真时的精确继承前缀长度；构造器在切点
  // 补上子代自有标记（除非 seed 已含标记及其后的子代收尾事件）。
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  // meta：发布前一次性读取的存储元数据；isSeeded 标记 fork 血统——
  // 只给重放历史不算继承。
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}

/**
 * Aliasing state of an adoptable Session seed. `shared-frozen` permits deeply
 * frozen aliases plus independently owned unfrozen values in the same seed.
 */
// SessionSeedEventState：可接管 seed 的别名状态——'detached' 独占；
// 'shared-frozen' 允许深冻结别名与独立持有的未冻结值共存。
export type SessionSeedEventState = 'detached' | 'shared-frozen'

/**
 * Adoptable storage values transferred to {@link SessionStore.prepare}
 * without another copy or freeze pass.
 */
// RestoredSessionOptions：从存储恢复、可直接交接给 SessionStore.prepare 的值
//（免再拷贝/再冻结）。
export interface RestoredSessionOptions {
  /** Events that are independently owned or already deeply frozen. */
  // 独立持有或已深冻结的事件。
  readonly seed: SessionEvent[]
  /** Independently owned storage metadata to validate and freeze in place. */
  // 独立持有的存储元数据（将就地校验并冻结）。
  readonly meta: SessionHeader
  /** Exact number of fork-inherited leading events decoded from storage. */
  // 从存储解码出的继承前缀精确长度。
  readonly inheritedEventCount: SessionLogOffset
  /** Aliasing state carried from the operation that produced the seed. */
  // 产出 seed 的操作带来的别名状态。
  readonly eventState: SessionSeedEventState
}

/** Inputs accepted while constructing an unpublished Session. */
// PrepareSessionOptions：构造未发布会话的两种合法输入（新建/恢复）。
export type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly eventState?: undefined })
  | RestoredSessionOptions

/** Why an active agent driver was cancelled. */
// AgentCancelCause：活跃驱动被取消的原因（用户/父级/hook/销毁）。
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** Durable cancellation cause, including imports whose original coarse record carried no cause. */
// TurnEndCancelCause：可持久化的取消原因——兼容原始记录未带原因的导入（legacy）。
export type TurnEndCancelCause = AgentCancelCause | { readonly kind: 'legacy' }

/**
 * Why a turn ended. Merge-extensible sum type.
 */
// TurnEndReasonMap：回合结束原因表——可合并扩展（插件可加变体），
// 对应 AGENTS.md「closed unions 用 assertNever，merge-extensible 走文档化 default」。
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  // aborted：取消请求打断了进行中的回合。
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }

  blocked: { kind: 'blocked' }
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code }` flattened from
   * any other error, where `code` is `TOOL_ACTIVATION_FAILED` for a failed
   * tool condition and `UNKNOWN` otherwise.
   */
  // error：回合失败——error 恒为结构化失败（LlmError 原样，或其他错误展平）。
  error: { kind: 'error'; error: LlmFailure }
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  // max-tokens：至少一步触及输出 token 上限（即使插件续跑了回合）。
  'max-tokens': { kind: 'max-tokens' }
  /**
   * A crash-orphaned turn was closed after the fact: agent-loop resume appends
   * this closer for a stored log whose last turn never ended, and session-query
   * synthesizes it on cold reads. The loop never emits this marker live, and
   * the events recorded before the crash remain intact.
   */
  // interrupted：崩溃孤儿回合的事后收尾——恢复路径补记、冷读合成；
  // 循环绝不在运行中发出；崩溃前的事件原样保留。
  interrupted: { kind: 'interrupted' }
  /**
   * Fork-seed construction closed a turn that was still open at the fork
   * boundary in the source session. Only fork seeds carry this marker — the
   * loop never emits it — and the source events before the boundary remain
   * intact in the child.
   */
  // forked：fork 种子构造在边界处关掉了源会话仍开着的回合；
  // 只有 fork 种子携带（循环不发出）。
  forked: { kind: 'forked' }
}

/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
// TurnEndReason：原因并集；插件向 map 合并变体即可扩展。
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * Logged request state outside derived history: call config and tools. The
 * system prompt is derived history — surface node 0, a `system/message` event.
 * The latest full `request/header` snapshot reconstructs the header; canonical
 * empty optional fields are absent.
 */
// EpochHeader：日志中的请求状态（派生历史之外）——调用配置与工具。
// 系统提示词属于派生历史（表面 0 号节点，system/message 事件）。
export interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  // 会话的调用配置（provider、model、推理力度、采样标量）。
  config: LlmCallConfig
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  // adapterDefaults：由具体适配器落地（而非调用方提议）的生效配置字段。
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** Assembled tool schemas; absent for a tool-less request. */
  // tools：组装好的工具 schema；无工具请求时缺席。
  tools?: ToolSchema[]
  /** Retired request text; system prompts belong to system/message events.
   * @persistenceReserved
   */
  // system：已退役字段（系统提示词归 system/message）——持久化保留位。
  system?: never
}

/** Registration-bound metadata for one resolved model route. */
// RequestContext：一条已解析模型路由的注册绑定元数据。
export interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  // 所属的注册 provider 路由。
  provider: string
  /** Provider-owned model id the metadata belongs to. */
  // provider 自有的模型 id。
  model: string
  /** Maximum combined request and response context in tokens, when advertised. */
  // 上下文窗口（请求+响应合计 token 上限，若声明）。
  contextWindow?: number
  /** `'in-history'` when the route reads the latest `system` message at any position as the effective system prompt. */
  // systemPromptUpdate：'in-history' 表示该路由把任意位置的最新 system 消息
  // 当作生效系统提示词。
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header; `'series'` — an unchanged
 * header began an explicitly distinct message series or followed a surface
 * replacement. Other reasons carry `startsSeries` when a new series coincides.
 */
// RequestHeaderReason：request/header 快照的追加原因——
// initial 首个头（新会话）；resume 对已有头的日志首次请求（重启/fork）；
// change 后续请求换了头；series 未换头但开启新消息序列或跟随表面替换。
export type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous. Assistant attempt events embed their exact
 * compact raw streams so persistence stores one durable settlement per attempt.
 */
// SessionEventMap：代理交互的真相源——可合并扩展、只追加的事件日志（上游注释）。
// 消息历史从它推导；每个事件无损 JSON、序号连续；助手尝试事件内嵌精确压缩
// 原始流，使持久化对每次尝试存一个持久 settlement。
export interface SessionEventMap {
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * Rejection, empty input, cancellation, or failure may close it with no
   * step; otherwise the following identified `user/message` event or batch
   * records the messages entering the step.
   */
  // turn/start：回合开始——在循环认领排队输入或跑 pre-step 之前。
  // 拒绝/空输入/取消/失败可能无 step 即关闭。
  'turn/start': { turn: number }
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
   * with no entered step has no `step/start` or `step/end`. The loop does not await a
   * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
   * per-request durability checkpoint, and consumers that read storage after
   * `whenIdle()` flush themselves. Success commits the turn; rejection is
   * reported live and does not prevent later work.
   */
  // turn/end：回合结束（带原因）。无 step 的回合没有 step/start|end。
  // 循环不在回合边界等 flush——检查点策略归 dsh-session-checkpoint-policy。
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  // step/start：步开始——一次模型调用及其请求的工具执行。
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  // step/end：步结束。
  'step/end': { turn: number; step: number }
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  // user/message：模型可见表面上的用户消息——真人提示、agent.inject() 合成上下文
  //（文件变更、子目录 AGENTS.md、技能内容、cron 通知等）或目标续跑轮；
  // 三者 content 原样投影，用 source 区分。
  'user/message': UserMessage
  /** An incremental agent session change admitted at the named turn and step. */
  // developer/message：在指定回合/步被接纳的增量会话变更（开发者消息）。
  'developer/message': {
    turn: number
    step: number
    message: DeveloperMessage
    /** Earlier request/header defining every tool addition; required exactly when additions are present. */
    // headerSeq：定义工具增量的先前 request/header；有增量时必填。
    headerSeq?: SessionSeq
  }
  /**
   * The rendered system prompt on the model-visible surface. The loop appends
   * the first one as surface node 0 before the step's first `user/message`.
   * A prepared in-history route can append nonempty changes in a continuing
   * series. An incapable route, or a new series whose effective text differs,
   * normalizes text to the first system node; a series start whose latest
   * surviving node already holds the rendering leaves it in place.
   * Normalization empties nonempty later nodes, then rewrites the head if
   * needed, through logged per-node replacements. An empty rendering always
   * clears all active system nodes, leaving no older instructions model-visible.
   * Empty later nodes are dormant and project to no message; an empty head with
   * no active later node records "no system prompt". Restored nonempty text follows
   * the same route and series rule; empty nodes never restore older text.
   */
  // system/message：模型可见表面上的系统提示词（上游注释描述归一化规则——
  // 空渲染清空全部活跃系统节点；空后置节点休眠不投影）。
  'system/message': { turn: number; step: number; message: SystemMessage }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none. A turn
   * cancelled mid-stream finalizes its delivered text/reasoning prefix as this
   * event with `interrupted: true`; undispatched tool calls are absent. The
   * marker distinguishes that prefix without re-deriving interruption from turn
   * boundaries. An aborted turn with no such event streamed no visible content.
   */
  // assistant/message：一步的组装助手消息（派生历史用它）——输出与 token 账目
  // 同行（无独立 usage 记录）；流中取消的回合把已送达前缀以 interrupted: true
  // 落此事件；未派发的工具调用缺席。
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage
    /** Exact timed model stream, compacted without joining delta boundaries. */
    // stream：精确的定时模型流（压缩但不拼接 delta 边界）。
    stream: AssistantStreamRecord[]
    usage?: TokenUsage
    interrupted?: true
  }
  /**
   * One model attempt that committed no surface message. The embedded stream
   * preserves a failed, retried, cancelled, or stream-error attempt that
   * reached settlement without fabricating model-visible history.
   */
  // assistant/attempt：未产生表面消息的一次模型尝试——内嵌流保留失败/重试/
  // 取消/流错误尝试的 settlement，而不伪造模型可见历史。
  'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  // tool/call：模型请求一次工具调用——arguments 保持模型产出的原始 JSON 串
  //（不解析）；callId 与 tool/result 配对。
  'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity and user-facing reason, and optional tool-private `meta`
   * presentation payload. The reason remains outside the model-facing message.
   * `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  // tool/result：已完成工具调用的结果（上游注释详尽）——模型可见结果 + 可选
  // 错误身份/用户可读原因（原因不进模型消息）+ 工具私有 meta（核心不透明，
  // 但必须 JSON 可序列化——append 用 isJsonValue 运行时校验）。
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    /**
     * Optional failure identity and raw user-facing reason, outside model content;
     * allowed only when the message has `isError: true`.
     */
    // error：可选失败身份与用户可读原因；仅当消息 isError: true 时允许。
    error?: { name: string; code: string; reason?: string }
    // meta：工具私有展示载荷（重放时复现相同卡片）。
    meta?: JsonValue
  }
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  // request/header：下一次请求的完整头——步内派发前追加；仅日志（最新快照
  // 重建请求头）。
  'request/header': {
    header: EpochHeader
    reason: RequestHeaderReason
    /** This request begins a distinct model-message series, independently of the header reason. */
    // startsSeries：本请求开启一条独立的模型消息序列（独立于头的 reason）。
    startsSeries?: true
  }
  /**
   * Route metadata for the next request, logged only when the route, capacity,
   * or system prompt update mode changes. It does not participate in request
   * reconstruction or header equality. Prompt admission uses the bound prepared
   * call's capability, not this snapshot from an earlier request.
   */
  // request/context：下一请求的路由元数据——仅路由/容量/系统提示更新模式变化时记录；
  // 不参与请求重建或头等值比较。
  'request/context': RequestContext
  /**
   * Separates inherited or restored history from later lifecycle-owned work.
   * This log-only marker need not be at {@link Session.firstLiveSeq}: a fork
   * seed can already contain its tagged marker and child-owned synthetic
   * closers before construction.
   *
   * A fresh fork child owns one `{ inherited: true }` marker at its exact
   * inherited-prefix cut, even when that prefix ends in an ancestor marker.
   * `buildForkSeed` appends that marker before any synthetic closers; the
   * `Session` constructor supplies it when given only the inherited prefix.
   * The last tagged marker is the current Session's cut; untagged markers
   * keep ordinary restore and replay lifecycle boundaries.
   *
   * Only the `Session` constructor and `buildForkSeed` may create this marker.
   * Session append does not reject other writers, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compaction/start` …
   * `compaction/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  // session/end-seed（上游注释详尽）：分隔「继承/恢复历史」与「后续生命周期工作」。
  // 只有 Session 构造器与 buildForkSeed 可创建该标记。
  'session/end-seed': { inherited?: true }
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
// SessionEventType：可追加的事件类型键（含插件合并的扩展）。
export type SessionEventType = keyof SessionEventMap

/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp}; system, user, and tool events may also cite
 * earlier sources through {@link SessionEvent.sourceEventSeqs}.
 */
// SurfaceEventType：会产出 LLM 消息、可出现在有序表面的事件类型子集。
// 只有这些类型可带 SurfaceOp；并可经 sourceEventSeqs 引用更早的源事件。
export type SurfaceEventType =
  | 'system/message'
  | 'developer/message'
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/** A message-producing event carrying its required surface operation. */
// SurfaceEvent：携带必需表面操作的消息产出型事件。
export type SurfaceEvent = SessionEvent<SurfaceEventType>

/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', startSeq, endSeq }`: replaces surface nodes from `startSeq`
 *   (inclusive) through `endSeq` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `startSeq === endSeq` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
// SurfaceOp（上游注释）：事件进入有序表面的方式——
// 'append' 追加到尾部（常态）；replace 按序号区间替换表面节点（压缩用，
// sourceEventSeqs 必须覆盖全部被遮蔽节点）。
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }

/**
 * Surface placement and cited source-event seqs for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
// SurfaceIntent：Session.append 的表面放置 + 引用源事件（消息型必填、日志型禁填）。
export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
  surfaceOp: SurfaceOp
} & (T extends 'assistant/message' ? {
  /** Assistant messages embed their provider stream instead of citing source events. */
  // 助手消息内嵌 provider 流而非引用源事件。
  sourceEventSeqs?: never
} : {
  /** Complete non-empty set of known earlier source-event seqs. */
  // 已知更早源事件序号的完整非空集合。
  sourceEventSeqs?: SessionSeq[]
})

/** One positional event call proposed for append, without assigned sequence or time. */
export type SessionEventInput = {
  [K in SessionEventType]: readonly [type: K, data: SessionEventMap[K], ...opts: K extends SurfaceEventType ? [opts: SurfaceIntent<K>] : []]
}[SessionEventType]

/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`system/message`, `user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, attempts, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
// SessionEvent（上游注释）：日志中的单个不可变条目——
// 对 type 的正规判别联合（switch 自动收窄 data，无需断言）；
// 表面元数据只存在于表面型变体上（编译器在 append 调用点强制）。
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    // 会话内单调递增序号。
    seq: SessionSeq
    /** Unix epoch milliseconds. */
    // 事件时间（Unix 毫秒）。
    time: number
    data: SessionEventMap[K]
    /**
     * Marks an event a reader may safely skip when it does not recognize
     * `type`. Absent means required: a reader meeting an unrecognized type
     * without this marker MUST refuse to reconstruct the session instead of
     * silently dropping the event, because an unrecognized required event may
     * change how the rest of the log is interpreted. A writer sets `true` only
     * on purely informational records whose loss cannot affect reconstruction;
     * defaulting to required means a forgotten marker over-refuses (an
     * inconvenience) rather than silently resuming a gutted session.
     */
    // ignorable（上游注释）：未知类型时可安全跳过的标记。缺席=必需——
    // 缺标记的未知事件必须拒绝重建（宁可过度拒绝也不吞掉可能改变解读的事件）。
    ignorable?: true
  } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
    surfaceOp?: never
    sourceEventSeqs?: never
  })
}[T]

/**
 * Event type of an experimental plugin record: `plugin:` followed by
 * slash-separated segments of lowercase letters, digits, `.`, `_`, and `-`,
 * each starting with a letter or digit. A record type is never a
 * {@link SessionEventMap} member.
 */
// PluginRecordType：实验性插件记录类型——plugin: 前缀 + 段式命名；
// 永不与 SessionEventMap 成员重叠。
export type PluginRecordType = `plugin:${string}`

/**
 * Payloads written by experimental packages, keyed by their `plugin:` record
 * names. Packages augment this map to type writes and enter the current plugin
 * record catalog; these declarations do not enter {@link SessionEventMap} or
 * released persistence schemas. Stored records still require owner validation.
 */
// PluginRecordMap：实验包写入的载荷表——包通过声明合并增补以获得类型；
// 不进入发布持久化 schema；存储记录仍需属主自行校验。
export interface PluginRecordMap {}

/**
 * One committed experimental plugin record, read from the log by
 * `pluginRecordOf`. The record's owner validates `data` before use, because a
 * restored record carries whatever JSON an earlier build of its owner wrote,
 * or a V3 event that a format migration renamed into the `plugin:` namespace held.
 */
// PluginRecord：一条已提交的实验记录——属主必须先校验 data 再使用
//（恢复的记录可能是旧构建写入的任意 JSON，或迁移改名的 V3 事件）。
export interface PluginRecord {
  /** The record type, chosen by the owning plugin. */
  // 记录类型（属主插件自选）。
  readonly type: PluginRecordType
  /** The record's position in the Session log. */
  // 在日志中的位置。
  readonly seq: SessionSeq
  /** Unix epoch milliseconds at append. */
  // 追加时间。
  readonly time: number
  /** The JSON payload as committed. */
  // 提交时的 JSON 载荷。
  readonly data: unknown
}

// 声明合并：向 Typert（类型图/远程协议）注册 session 资源与错误细节——
// 会话 id 成为远程 API 的一等线路字段。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** One Session; the Session Controller registers its default `sessionId` wire field. */
    // session 资源：Session Controller 注册其默认的 sessionId 线路字段。
    session: TypertResource<SessionId>
  }

  interface RemoteErrorDetailsMap {
    /** The named Session does not exist; produced by every layer that resolves a SessionId. */
    // 会话不存在错误：每个解析 SessionId 的层都会产生。
    'session/not-found': { readonly sessionId: SessionId }
  }
}
