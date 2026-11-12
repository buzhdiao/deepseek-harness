// 模块说明：PTC 模式的 `run_code` 传输工具。模型编写的程序通过"嵌套执行"
// 调用注册表中智能体可见的工具，调度遵循与原生循环完全相同的并发契约；
// 每次子分发都会记录日志以便重建，但只有外层经整理的结果进入模型历史。
// 关键设计：
// 1. 有序车道调度器：每个有序阶段（开始事件追加、prepare、post-execute、
//    上下文延迟、settle 追加）都在单一驱动车道内按提交顺序执行，只有
//    around-dispatch/程序体阶段并发；
// 2. 程序级取消：run 级 AbortController 融合外层信号与 run 自身落定，
//    保证在途子分发被中止而不是被遗弃；
// 3. 语言感知 schema：description 与参数描述经 getter 在投影时按运行时语言解析，
//    而参数校验始终锚定语言无关的静态 spec。
/**
 * Shared program transport. Programs call their admitted tools through nested
 * executions scheduled under the native concurrency contract; each sub-dispatch
 * is logged for reconstruction, while only the outer curated result enters model
 * history.
 * @module
 */

import { isDeepStrictEqual } from 'node:util'
import type { PtcDispatchLog } from './runtime-types.ts'
// cordis 的 symbols（含 original 包装穿透标记）与 Context 类型。
import { symbols, type Context } from '@deepseek-ai/cordis'
// brandString：把字符串收窄为品牌类型（如 ToolCallId）。
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

// LLM 线上类型：内容块、工具调用 id、工具 schema。
import type { ContentBlock, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcOutput } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcRunResult, PtcRunSandbox, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
// 沙箱升级：审批执行、升级目标集合、升级参数校验。
import { approveEscalation, ESCALATION_TARGETS, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
// 沙箱执行策略类型。
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// 副作用导入：引入 user-approval/working-directory/sandbox-policy 的类型环境。
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// 值工具：深冻结、无损 JSON 快照与 JsonValue 类型。
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, parameterSchemaSpecToJsonSchema, projectToolSchema, RUN_CODE_NAME, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
// scopeTarget：按智能体圈定作用域监听目标。
import { scopeTarget } from '@deepseek-ai/dsh-scope'
// 执行器所有的取消与重置协调接口。
import type { PtcCalls } from './ptc-calls.ts'
// 本包错误类型：代码运行失败与工具调用配额超限。
import { CodeRunFailedError, ToolCallLimitExceededError } from './errors.ts'
// 已校验的配置类型。
import type { Config } from './config.ts'
import type { RunCodeToolOptions } from './run-code.ts'
import type { ToolDefinition, ToolExecution, ToolExecutionFailure, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from './types.ts'

/** The model-facing name of the PTC mode tool. */
// 原样转发 PTC 模式工具的模型侧名字（保留的 run_code）。
export { RUN_CODE_NAME }

/** Language-specific tool and code-parameter descriptions. */
// 语言相关的工具与 code 参数描述。
interface RunCodeFlavor {
  /** The tool `description` the model sees for this language. */
  // 该语言下模型看到的工具 description。
  readonly description: string
  /** The `code` parameter's description for this language. */
  // 该语言下 code 参数的描述。
  readonly codeDescription: string
}

/** Keep tool-call rules here; the runtime owns evaluation syntax and state retention. */
function runCodeFlavor(language: string, outputInstruction: string, execution = {
  programDescription: 'the program to execute',
  codeDescription: `The ${language} program to execute, following this tool's execution instructions.`,
}): RunCodeFlavor {
  // 组装该语言风味的工具描述与 code 参数描述（运行期消费的字符串模板）。
  return {
    description: `Execute a ${language} program against the available tools. Takes two required arguments: `
      + `\`code\`, ${execution.programDescription}, and \`description\`, a short summary of what the program does. `
      + 'Call tools as `await tools.name(args)` per the declarations in the system prompt. '
      + outputInstruction,
    codeDescription: execution.codeDescription,
  }
}

const TYPESCRIPT_OUTPUT_INSTRUCTION = 'Show selected text and images with inspect(...values).'
const TYPESCRIPT_FLAVOR = runCodeFlavor('TypeScript', TYPESCRIPT_OUTPUT_INSTRUCTION)
const TYPESCRIPT_FUNCTION_FLAVOR = runCodeFlavor('TypeScript', TYPESCRIPT_OUTPUT_INSTRUCTION, {
  programDescription: 'the BODY of an async function (erasable syntax only; top-level `await` and `return` work)',
  codeDescription: 'The program: the body of an async TypeScript function.',
})
const PYTHON_FLAVOR = runCodeFlavor('Python', 'Curate the program output. Image-bearing subtool results are attached after the run.')

/** Languages with both a transport schema and an SDK renderer. */
// 同时拥有传输 schema 与 SDK 渲染器的语言集合。
export type PtcSdkLanguage = 'typescript' | 'python'

// 支持的运行时：带已注册 SDK 渲染器语言的 PtcRuntime。
type SupportedPtcRuntime = PtcRuntime & { readonly language: PtcSdkLanguage }

// 语言 -> 风味映射（编译期校验覆盖全部 SDK 语言）。
const RUN_CODE_FLAVORS = {
  typescript: TYPESCRIPT_FLAVOR,
  python: PYTHON_FLAVOR,
} satisfies Record<PtcSdkLanguage, RunCodeFlavor>

/**
 * Read the active runtime, rejecting missing providers and unsupported languages.
 * @param ctx - executor context containing the runtime provider.
 * @returns the runtime with a supported SDK language.
 */
export function requirePtcRuntime(ctx: Context): SupportedPtcRuntime {
  // 从上下文取 PTC 运行时。
  const runtime = ctx.get('ptcRuntime')
  // 未加载运行时：显式报错并提示加载实现或改用原生执行器。
  if (runtime === undefined) {
    throw new Error('dsh-tools: mode "ptc" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or load @deepseek-ai/dsh-tool-executor-native')
  }
  return requireRuntimeLanguage(runtime)
}

/** Resolve the SDK flavor for a mounted or explicitly supplied provider. */
function requireRuntimeLanguage(runtime: PtcRuntime): SupportedPtcRuntime {
  if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language)) {
    const known = Object.keys(RUN_CODE_FLAVORS).map(name => JSON.stringify(name)).join(', ')
    throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
  }
  // 收窄为"语言受支持"的运行时并返回。
  return runtime as SupportedPtcRuntime
}

/**
 * The `description` parameter's model-facing description: language-independent
 * (the UI label contract is the same for every runtime), shared between the
 * static spec and the language-aware `parameters` getter so the two emissions
 * can never drift.
 */
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
  // description 参数的模型侧描述：与语言无关（UI 标签契约对每个运行时一致），
  // 由静态 spec 与语言感知的 parameters getter 共享，两处发射永不漂移。
  = 'Clear, concise description of what this program does in active voice, '
    + '5-10 words (shown in the UI). '
    + 'Examples: "Count TODO markers across packages"; '
    + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

// run_code 的可选控制参数（静态底稿）：超时、沙箱升级、升级理由。
const RUN_CODE_CONTROLS = {
  // 毫秒级时间预算。
  timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the deployment maximum.' },
  // 本次完整程序执行申请更宽的沙箱模式；需要理由与审批（枚举 = 升级目标全集）。
  sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
  // 升级理由，展示给用户审批；建议使用用户当前请求的语言。
  justification: { type: 'string', description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.' },
} as const

// 按运行时能力裁剪控制参数：支持超时才给 timeoutMs（描述带上默认值与上限）；
// 支持沙箱模式才给 sandbox_permissions 与 justification。
function controlParameters(runtime: PtcRuntime) {
  return {
    ...runtime.timeout === undefined ? {} : {
      timeoutMs: { ...RUN_CODE_CONTROLS.timeoutMs,
        description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}. Zero does not disable the deadline.` },
    },
    ...runtime.sandboxMode === undefined ? {} : {
      sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
      justification: RUN_CODE_CONTROLS.justification,
    },
  }
}

// 沙箱升级的补充指引文本：运行时无沙箱模式时为空串，否则拼上固定指引。
function escalationGuidance(mode: PtcRuntime['sandboxMode']): string {
  return mode === undefined ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

/** Match schema text to the runtime language and program syntax. */
// 按运行时语言与程序语法匹配 schema 文案：TS 函数体语法用函数体风味，其余查表。
function resolveFlavor(runtime: SupportedPtcRuntime): RunCodeFlavor {
  return runtime.language === 'typescript' && runtime.programFormat === 'function-body'
    ? TYPESCRIPT_FUNCTION_FLAVOR : RUN_CODE_FLAVORS[runtime.language]
}


/**
 * Snapshot one binding call's argument as lossless JSON, then snapshot that
 * detached value again so dispatch and logging stay independent without
 * reintroducing structured-clone's platform-specific nesting limit.
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  // 快照槽位。
  let snapshot: JsonValue | undefined
  try {
    // 第一步：把参数快照为无损 JSON（同时与源对象分离）。
    snapshot = snapshotJsonValue(value) as JsonValue | undefined
  } catch (error: unknown) {
    // 无法无损 JSON 化：报错并附原因。
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  // undefined 说明不是可快照的参数对象（如 null/原始值）。
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  // 第二步：对已分离的值再快照一次，得到日志专用副本。
  const logged = snapshotJsonValue(snapshot)
  /* v8 ignore next -- snapshot is already a detached lossless JSON value. */
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  // 返回"分发用"与"记录用"两个独立副本；刻意不用 structuredClone 以避开
  // 其平台相关的嵌套深度限制。
  return { dispatched: snapshot, logged }
}

/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
// 两空格的 JSON 呈现缩进，与既有浅层 run_code 文本契约一致。
const JSON_INDENT = '  '

/**
 * ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
 * renderer also caps TOTAL indentation there, compacting deeper subtrees, so
 * formatted output remains linear in the canonical JSON size.
 */
// ECMAScript 把 JSON.stringify 的 space 参数截到十字符；本渲染器同样把总缩进
// 封顶在十字符（更深的子树压缩输出），保证格式化输出相对规范 JSON 尺寸保持线性。
const MAX_JSON_INDENT_CHARS = 10

/** A pending fragment in the iterative JSON presentation traversal. */
// 迭代式 JSON 呈现遍历中的待处理片段：文本块或带深度/压缩标记的值节点。
type JsonRenderTask =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: JsonValue; depth: number; compact: boolean }

/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
// 渲染一个非字符串 JSON 根：不用递归遍历，也不让缩进无界增长。
function renderJsonValue(value: Exclude<JsonValue, string>): string {
  // 输出片段收集器。
  const chunks: string[] = []
  // 显式任务栈，根任务入栈。
  const tasks: JsonRenderTask[] = [{ kind: 'value', value, depth: 0, compact: false }]
  // 主循环：弹栈处理直到清空。
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    // 文本片段：直接进输出。
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }

    const current = task.value
    // 标量（null/布尔/数值）：直接字符串化。
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    // 字符串：JSON 转义输出。
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }

    // 计算压缩标记：父级已压缩，或下一层缩进超过总缩进上限。
    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    // 子节点深度。
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      // 数组开头。
      chunks.push('[')
      // 空数组：直接闭合。
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      // 闭合括号任务（压缩则紧贴，否则换行到本层缩进）。
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      // 逆序压栈使元素按正序输出；每个元素前是分隔+缩进文本。
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        /* v8 ignore next -- canonical JsonValue arrays are dense. */
        if (item === undefined) throw new Error('cannot render a sparse JSON array')
        tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? index === 0 ? '' : ','
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }

    // 对象：取键列表。
    const keys = Object.keys(current)
    // 对象开头。
    chunks.push('{')
    // 空对象：直接闭合。
    if (keys.length === 0) {
      chunks.push('}')
      continue
    }
    // 闭合括号任务。
    tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
    // 逆序压栈使键按正序输出；每个键是 value 任务 + 分隔文本。
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new Error('cannot render a missing JSON object key')
      const item = current[key]
      /* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
      if (item === undefined) throw new Error('cannot render an undefined JSON object property')
      tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
      tasks.push({
        kind: 'text',
        text: compact
          ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
          : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
      })
    }
  }
  // 拼接全部片段。
  return chunks.join('')
}

/** Render one present program completion value for the model-facing result text. */
// 为模型侧结果文本渲染一个"在场"的程序完成值：字符串原样，其余格式化 JSON。
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : renderJsonValue(value)
}

/** Canonical value returned by the outer PTC mode transport. */
// 外层 PTC 模式传输返回的规范值：日志、可选结果值、可选沙箱信息。
type RunCodeOutput = { logs: string[]; result?: JsonValue; sandbox?: PtcRunSandbox }

/** Render captured text, selected images, and the applied file policy in emission order. */
function renderRunOutput(
  value: RunCodeOutput,
  guidance: string,
  output: PtcOutput[] = value.logs.map(text => ({ type: 'text', text })),
  toolName: string,
): ContentBlock[] {
  const content: ContentBlock[] = []
  const appendText = (text: string): void => { if (text.length > 0) content.push({ type: 'text', text }) }
  const remaining: string[] = []
  for (const block of output) {
    if (block.type === 'text') remaining.push(block.text)
    else {
      appendText(remaining.join(''))
      remaining.length = 0
      content.push(block)
    }
  }
  appendText(remaining.join(''))
  const details: string[] = []
  if (value.result !== undefined) details.push(renderValue(value.result))
  if (value.sandbox?.enforcement === 'partial') details.push('File sandbox enforcement is partial on this host.')
  if (value.sandbox?.denied) details.push(`The ${value.sandbox.mode} file sandbox denied an operation.${guidance}`)
  appendText(details.filter(text => text.length > 0).join('\n'))
  return content.length > 0 ? content : [{ type: 'text', text: `(${toolName} completed with no output)` }]
}

/** Unowned programs do not require Session directory state. */
// 解析工作目录：无主（无 Agent）的程序不需要会话目录状态，返回 undefined。
async function resolveWorkingDirectory(ctx: Context, exec: ToolRunContext): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  // 有 Agent 则必须挂载 workingDirectory 服务。
  const directories = ctx.get('workingDirectory')
  if (directories === undefined) throw new Error('dsh-tools: run_code with an Agent requires workingDirectory')
  // 确保该智能体的会话目录存在并返回路径。
  return directories.ensure(exec.agent, exec.signal)
}

/** Resolve standing authority for a runtime that enforces file policy. */
// 为强制文件策略的运行时解析常设沙箱权限。
function resolveSandboxPolicy(ctx: Context, exec: ToolRunContext): SandboxExecutionPolicy {
  const policy = ctx.get('sandboxPolicy')
  // 受限 PTC 运行时必须有 sandboxPolicy 服务。
  if (policy === undefined) throw new Error('dsh-tools: confined PTC runtime requires sandboxPolicy')
  // 按会话（若有）解析出具体执行策略。
  return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

/**
 * Build a program transport using the shared nested-call scheduler.
 * @param ctx - executor context owning policy listeners and active program cleanup.
 * @param executor - shared invocation pipeline for nested calls.
 * @param config - validated timeout-based tool-call allowance and concurrency limits.
 * @param calls - Executor-owned cancellation and reset coordination.
 * @param options - Fixed runtime and tools for a registered program tool; omission selects PTC's visible registry and current runtime.
 * @returns the transport definition with runtime-dependent schema text.
 */
export function createRunCodeTransport(
  ctx: Context,
  executor: ToolExecutionPipeline,
  config: Config,
  calls: PtcCalls,
  options?: Omit<RunCodeToolOptions, 'limits'>,
): ToolDefinition {
  // 解构配置：每分钟子调用配额与并行子调用上限。
  const { maxSubCallsPerMinute, maxParallelSubCalls: maxParallel } = config
  const toolName = options?.name ?? RUN_CODE_NAME
  const getRuntime = options === undefined ? () => requirePtcRuntime(ctx) : () => requireRuntimeLanguage(options.runtime)
  // Retain services for log settlement after the executor context becomes inactive.
  // 提前保留服务引用：执行器上下文失活后仍要完成日志落定。
  const tools = ctx.tools
  const logger = ctx.logger

  /** A failed log-content listener preserves the settled content and cannot fail the dispatch. */
  // 经瀑布监听器整形分发日志；失败的监听器保留已定稿内容，绝不让分发失败。
  async function shapeDispatchLog(dispatch: PtcDispatchLog): Promise<ContentBlock[]> {
    try {
      return await ctx.waterfall(
        scopeTarget(tools, dispatch.agent), 'tools/ptc-dispatch-log', dispatch,
        // 兜底工厂：监听器全部缺席/直通时返回原始内容。
        () => Promise.resolve(dispatch.content),
      )
    } catch (error: unknown) {
      // 记告警并回退到原始定稿内容（日志整形的失败被容住）。
      logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${toolErrorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']
  const inspections = new WeakMap<ToolExecution, {
    value?: RunCodeOutput
    failure?: Pick<ToolExecutionFailure, 'error' | 'content'>
    output: PtcOutput[]
  }>()
  const programImage = (ref: ImageRef): PtcImage => {
    const attachments = ctx.get('attachments')
    const fs = ctx.get('fs')
    const access = attachments === undefined || fs === undefined ? undefined
      : resolveImageAttachmentAccess(attachments, path => fs.processPathFromHostPath(path), ref)
    if (access === undefined) throw new Error('Image storage must expose a readable path in the program filesystem')
    return new PtcImage(access.readonlyPath, ref)
  }
  const stateOwners = new WeakMap<object, WeakSet<PtcRuntime>>()
  // 用 defineTool 组装保留的 run_code 工具定义。
  const definition = defineTool({
    name: toolName,
    // The description and `code` parameter description are placeholders here:
    // the language-aware getters installed below replace both, resolving the
    // loaded runtime's flavor at schema-emission time so the schema the MODEL
    // sees matches the SDK section's language. Argument VALIDATION still keys
    // off this static spec (defineTool closes over it), which is language-
    // independent (one required string `code`).
    // 这里的 description 与 code 参数描述只是占位：下方安装的语言感知 getter
    // 会在 schema 发射时按已加载运行时的风味解析二者，使模型看到的 schema
    // 与 SDK 段的语言一致。参数"校验"仍以这份静态 spec 为准（defineTool 闭包
    // 持有它）——它语言无关（就是一个必填字符串 code）。
    description: TYPESCRIPT_FLAVOR.description,
    // 静态参数 spec：code 与 description 必填，再摊开可选控制参数。
    parameters: {
      code: { type: 'string', required: true, description: TYPESCRIPT_FLAVOR.codeDescription },
      description: {
        type: 'string',
        required: true,
        description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION,
      },
      ...RUN_CODE_CONTROLS,
    },
    // 输出 schema 与渲染器。
    output: {
      schema: {
        // 输出为封闭对象。
        type: 'object',
        additionalProperties: false,
        properties: {
          // 程序捕获的日志行（必填）。
          logs: { type: 'array', required: true, items: { type: 'string' } },
          // 程序返回的结果值（任意 JSON，可选）。
          result: { type: 'json' },
          // 沙箱执行信息（可选）。
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              // 生效的沙箱模式（必填，三档枚举）。
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              // 是否拒绝了操作（必填）。
              denied: { type: 'boolean', required: true },
              // 强制程度（可选）。
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => renderRunOutput(value,
        escalationGuidance(options === undefined ? ctx.get('ptcRuntime')?.sandboxMode : options.runtime.sandboxMode), undefined, toolName),
    },
    // 工具执行入口。
    async execute(args, exec): Promise<RunCodeOutput> {
      // description 不能是纯空白。
      if (args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      const runtime = getRuntime()
      const run = async (callSignal: AbortSignal): Promise<RunCodeOutput> => {
        // 校验升级参数的配对合法性与长度。
        validateEscalationArgs(args.sandbox_permissions, args.justification)
        // 运行时不支持超时却传了 timeoutMs：报错。
        if (args.timeoutMs !== undefined && runtime.timeout === undefined) {
          throw new Error('timeoutMs is not available for this PTC runtime')
        }
        // timeoutMs 必须是正的有限数。
        if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
          throw new Error('invalid timeoutMs: expected a positive finite number')
        }
        // 解析常设沙箱策略（运行时启用沙箱模式才有）。
        const standingPolicy = runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec)
        // 本次执行生效的策略，初始为常设策略。
        let policy = standingPolicy
        // 申请升级：必须有常设策略，且走用户审批。
        if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
          if (standingPolicy === undefined) throw new Error('sandbox_permissions is not available for this PTC runtime')
          // 走审批流：以程序为升级对象，携带理由与当前生效模式。
          const approvedMode = await approveEscalation({
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: standingPolicy.mode,
            subject: 'program',
          }, {
            approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
            toolName, signal: callSignal,
          })
          // 审批通过：以批准的模式覆盖常设策略的模式。
          policy = { ...standingPolicy, mode: approvedMode }
        }
        // 解析工作目录（随本调用的取消信号）。
        const cwd = await resolveWorkingDirectory(ctx, { ...exec, signal: callSignal })
        // 目录解析后再检查一次是否已取消。
        callSignal.throwIfAborted()

        // The run-scoped abort: follows the outer signal in, and fires when the
        // run settles for ANY reason, so an in-flight sub-dispatch is aborted
        // (its executor kills on this signal) instead of orphaned, and
        // queued-unstarted dispatches are abandoned.
        // run 级中止信号：入方向跟随外层信号，出方向在 run 因任何原因落定时触发，
        // 使在途子分发被中止（其执行器监听此信号）而不是被遗弃，
        // 排队未开始的分发则被放弃。
        const runController = new AbortController()
        // 外层取消 -> run 级取消的桥接回调。
        const onOuterAbort = (): void => { runController.abort(callSignal.reason) }
        // 注册一次性监听。
        callSignal.addEventListener('abort', onOuterAbort, { once: true })

        // 子调用尝试计数（含失败的调用）。
        let toolCallAttempts = 0
        // 本 run 允许的最大子调用数（由解析出的超时决定，见下方赋值）。
        let maxSubCalls: number
        // The per-run scheduler uses the registry's staged interface and follows
        // the same concurrency rules as the native loop. It also follows the
        // native loop's SEQUENCING: every ordered stage (the dispatch-start
        // append, prepare = pre-execute/guards, complete = post-execute,
        // context deferral, the settle append) runs inside ONE driver lane, so
        // ordered policy stages never overlap each other and only the
        // around-dispatch/body stage runs concurrently. Starts are strictly
        // submission-ordered; results commit in submission order through the
        // head-of-line cursor. Consecutive parallel-classified calls overlap up
        // to maxParallel; an exclusive call waits for the pool to drain, runs
        // alone, and holds its barrier until its COMMIT (post-execute included)
        // completes, exactly like a native exclusive group. Classification is
        // re-read via executionMode() immediately before each start (a registry
        // mutation while queued can flip a call exclusive), matching the native
        // scheduler's lazy reclassification.
        interface PendingDispatch {
          /** Ordered stage: append the start event, await prepare (pre-execute/guards), launch the body into `flight`. */
          // 有序阶段：追加开始事件、等待 prepare（预执行/守卫）、把程序体发射进 flight。
          start(): Promise<void>
          // 分类本次调用为 parallel 或 exclusive（启动前再读一次）。
          classify(): 'parallel' | 'exclusive'
          // 放弃本条目（run 已中止时的排队未开始分发）。
          abandon(): void
          /** Ordered stage: post-execute + context deferral + settle event, in submission order. */
          // 有序阶段：post-execute + 上下文延迟 + settle 事件，严格按提交顺序。
          commit(): Promise<void>
          /** The launched around-dispatch/body stage; resolved until start() replaces it. */
          // 已发射的 around-dispatch/程序体阶段；start() 之前是已解决的占位。
          flight: Promise<void>
          /** True once the dispatch stage parked its outcome; the commit cursor waits on it. */
          // 分发阶段结果就位后为 true；提交游标要等它。
          settled: boolean
          /** The classification this entry started under; an exclusive holds its barrier through commit(). */
          // 本条目启动时的分类；exclusive 的屏障要持续到 commit() 完成。
          mode?: 'parallel' | 'exclusive'
        }
        // 等待启动的分发队列（严格提交顺序）。
        const pendingQueue: PendingDispatch[] = []
        // 在途程序体 promise 集合。
        const inFlight = new Set<Promise<void>>()
        /** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
        // 被跟踪的 settle 事件附带工作（日志监听 + 追加），run 落定时排空。
        const logWork = new Set<Promise<void>>()
        // 提交队列（与提交顺序一致，由队首游标推进）。
        const commitQueue: PendingDispatch[] = []
        // 是否有 exclusive 调用正在占据屏障。
        let exclusiveActive = false
        // 驱动器是否已在运行。
        let driving = false
        // 当前驱动器运行 promise。
        let driverRun: Promise<void> = Promise.resolve()
        // 唤醒闭包槽位。
        let wake: (() => void) | undefined
        // 唤醒驱动器（若有等待中的驱动器）。
        const wakeup = (): void => {
          const release = wake
          wake = undefined
          release?.()
        }
        /**
         * The single ordered lane. Each pass commits the head-of-line settled
         * dispatch (ordered post-execute), then starts the next queued entry if
         * its slot is free (ordered pre-execute), and otherwise sleeps until a
         * body settles or a new submission arrives. One run reaching the
         * empty-queues/empty-pool state is quiescence.
         */
        // 单一有序车道。每一轮：先提交队首已 settle 的分发（有序 post-execute），
        // 再在槽位空闲时启动下一个排队条目（有序 pre-execute），否则休眠到
        // 某个程序体落定或有新提交到达。队列与在途池全空即静止。
        const drive = (): Promise<void> => {
          // 已有驱动器在跑：复用其 promise。
          if (driving) return driverRun
          driving = true
          driverRun = (async () => {
            try {
              // 永续循环，直到静止退出。
              for (;;) {
                // Create the wakeup promise before inspecting state so a settle or submission arriving
                // between the checks and the await below cannot be lost.
                // 先创建唤醒 promise 再检查状态：检查与 await 之间到达的
                // settle/提交不会被丢失。
                const signal = new Promise<void>((resolve) => { wake = resolve })
                // 提交游标：队首且已 settle 才能提交。
                const commitHead = commitQueue[0]
                if (commitHead !== undefined && commitHead.settled) {
                  // 出队并按序提交。
                  commitQueue.shift()
                  await commitHead.commit()
                  // The barrier covers post-execute: later starts wait for the
                  // exclusive call's full pipeline, as under the native loop.
                  // 屏障覆盖到 post-execute：后续启动要等 exclusive 调用完整
                  // 管线结束，与原生循环一致。
                  if (commitHead.mode === 'exclusive') exclusiveActive = false
                  continue
                }
                // 启动游标：队首条目。
                const head = pendingQueue[0]
                if (head !== undefined) {
                  // run 已中止：放弃所有排队未开始的条目。
                  if (runController.signal.aborted) {
                    pendingQueue.shift()
                    head.abandon()
                    continue
                  }
                  // Reclassify at start time (fail-closed on registry changes).
                  // 启动时刻重新分类（注册表变化时 fail-closed）。
                  const mode = head.classify()
                  // 槽位判定：无 exclusive 占据，且 exclusive 需空池、parallel 需池未满。
                  const capacity = !exclusiveActive
                    && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel)
                  if (capacity) {
                    // exclusive 启动即占据屏障。
                    if (mode === 'exclusive') exclusiveActive = true
                    head.mode = mode
                    pendingQueue.shift()
                    // Joined before start() so the commit cursor sees submission
                    // order; nothing commits it until `settled` flips.
                    // 在 start() 之前入提交队列，提交游标才能看到提交顺序；
                    // settled 翻转前不会有任何提交动作。
                    commitQueue.push(head)
                    // 有序 prepare（在车道内串行）。
                    await head.start()
                    // 程序体 flight：落定时离开在途池并唤醒驱动器。
                    const flight: Promise<void> = head.flight.finally(() => {
                      inFlight.delete(flight)
                      wakeup()
                    })
                    inFlight.add(flight)
                    continue
                  }
                }
                // 静止判定：两队列皆空且无在途。
                if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
                // 休眠等待唤醒。
                await signal
              }
            } finally {
              // 退出时清标记与唤醒槽位。
              driving = false
              wake = undefined
            }
          })()
          return driverRun
        }
        /** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
        // 排空所有分发：每个都已 settle 且提交完毕；此刻不会再有新启动
        // （run 在调用时刻即已中止）。
        const drainDispatches = async (): Promise<void> => {
          // The abort already fired: the driver abandons queued-unstarted
          // entries, awaits the live pool, and drains the ordered commit lane —
          // including a commit already in progress when the program returned.
          // abort 已触发：驱动器放弃排队未开始的条目、等在途池清空、
          // 并排空有序提交车道——包括程序返回时已在进行中的提交。
          await drive()
          // Every settle event is appended inside the open run_code turn
          // (tasks self-remove on settlement).
          // 每个 settle 事件都在 run_code 未闭合的轮次内追加
          // （任务在落定时自行从集合移除）。
          while (logWork.size > 0) await Promise.allSettled([...logWork])
        }

        // Read through a call, not a bare property: the abort state genuinely
        // changes across awaits, and a direct `.aborted` re-check after one
        // would be narrowed away by control flow analysis.
        // 经函数调用读取 abort 状态而非裸属性：await 之间状态真的会变，
        // 直接的 .aborted 复查会被控制流分析收窄掉。
        const runOver = (): boolean => runController.signal.aborted

        // 绑定函数工厂：把一个工具 schema 变成程序可调用的绑定。
        const binding = (schema: ToolSchema): PtcBindingFunction => async (rawArgs: unknown): Promise<JsonValue> => {
          const { name } = schema
          // FIXME: Let image-producing tools declare their program result adaptation.
          const usesProgramImage = runtime.language === 'typescript' && (name === 'read_image' || name === 'cua')
          if (runOver()) {
            throw new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
          }
          // Count before validation and queuing so repeated failed calls also exhaust the allowance.
          // 在校验与排队之前计数：反复失败的调用同样耗尽配额。
          const n = ++toolCallAttempts
          if (n > maxSubCalls) {
            const error = new ToolCallLimitExceededError(maxSubCalls, n, maxSubCallsPerMinute, toolName)
            runController.abort(error)
            throw error
          }
          // 参数无损 JSON 化（分发副本 + 日志副本）。
          const normalized = jsonNormalizeArgs(rawArgs)
          // 生成子调用 id：`外层调用id:ptc:序号`。
          const subCallId = brandString<ToolCallId>(`${String(exec.callId)}:ptc:${n}`)
          // 组装子执行的输入上下文。
          const input = {
            callId: subCallId,
            rootCallId: exec.rootCallId,
            name,
            schema,
            arguments: normalized.dispatched,
            ...exec.agent ? { agent: exec.agent } : {},
            ...exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {},
            // 父调用令牌，维持调用链。
            parent: exec.token,
            // 子执行监听 run 级取消信号。
            signal: runController.signal,
          }
          type DispatchOutcome = { isError: true; message: string }
            | { isError: false; value: JsonValue; content: ContentBlock[]; imageRemoved: boolean }
          const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
            // Set by the dispatch stage (or start() for a pre-settled result): what commit() finalizes in submission order.
            // 由分发阶段（或 start() 的预定结果）设置：commit() 按提交顺序收尾的对象。
            let parked:
              | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
              | undefined
            const settle = (result: ToolExecutionResult, imageRemoved: boolean): void => {
              // The program gets its value NOW: the log-content listener (for
              // example, a spill backend) must never delay the binding or occupy
              // a dispatch slot. The event append is tracked side work; the run's
              // settlement drains logWork so every settle event is still appended
              // inside the open turn (shapeDispatchLog is contained, so this
              // chain cannot reject).
              // 程序此刻就拿到值：日志内容监听器（例如溢出后端）绝不能延迟
              // 绑定或占用分发槽位。事件追加是被跟踪的附带工作；run 落定时
              // 排空 logWork，保证每个 settle 事件仍在未闭合轮次内追加
              // （shapeDispatchLog 被容住，该链不会 reject）。
              resolve(result.isError
                ? { isError: true, message: result.error.message }
                : { isError: false, value: result.value, content: result.content, imageRemoved })
              const agent = exec.agent
              if (agent === undefined) return
              // 附带任务：整形日志内容并追加 settle 事件。
              const task: Promise<void> = (async () => {
                // The listener may replace the durable copy with a preview and
                // locator; the program's value and model-visible result are
                // untouched.
                // 监听器可以把持久副本换成预览+定位符；程序的值与模型可见
                // 结果不受影响。
                const logged = await shapeDispatchLog({
                  exec, agent, subCallId, name, isError: result.isError,
                  // The registry deep-froze this projection at result
                  // finalization; append snapshots the final copy again, so
                  // the log stays detached.
                  // 注册表在结果定稿时已深冻结该投影；追加时再次快照，
                  // 日志保持独立分离。
                  content: result.content,
                })
                // 追加 tool/ptc-dispatch 事件（重建子调用的完整记录）。
                agent.session.append('tool/ptc-dispatch', {
                  rootCallId: exec.rootCallId,
                  parentCallId: exec.callId,
                  subCallId,
                  name,
                  // The SIBLING parse of the dispatched value: byte-identical JSON,
                  // but a separate object — a tool mutating its args cannot desync
                  // this record from what it actually received.
                  // 分发值的"兄弟"解析：字节相同的 JSON 但是独立对象——
                  // 工具改写自己的参数也无法让本记录与其实际收到的东西失同步。
                  arguments: normalized.logged,
                  isError: result.isError,
                  ...result.error?.info === undefined ? {} : { error: result.error.info },
                  content: logged,
                  ...result.meta === undefined ? {} : { meta: result.meta },
                })
              })().finally(() => { logWork.delete(task) })
              logWork.add(task)
            }
            // 把本调用压入排队队列。
            pendingQueue.push({
              // start() 之前的占位 flight。
              flight: Promise.resolve(),
              settled: false,
              // Re-read per driver pass against the same agent view the SDK
              // declared; fail-closed exclusive when undeclared/invalid.
              // 每次驱动轮次按 SDK 声明的同一智能体视图重读分类；
              // 未声明/非法时 fail-closed 为 exclusive。
              classify: () => executor.executionMode(input).kind,
              abandon: () => {
                reject(new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
              },
              async start(): Promise<void> {
                // 有序阶段第一步：追加分发开始事件。
                exec.agent?.session.append('tool/ptc-dispatch-start', {
                  rootCallId: exec.rootCallId,
                  parentCallId: exec.callId,
                  subCallId,
                  name,
                  arguments: normalized.logged,
                })
                // Ordered prepare runs INSIDE the driver lane: the next entry's
                // pre-execute waits for this resolution, as under the native
                // scheduler. Only the launched body below overlaps.
                // 有序 prepare 在驱动车道内执行：下一个条目的预执行要等本次
                // 完成，与原生调度器一致。只有下方发射的程序体才并发。
                const prepared = await executor.prepare(input)
                if (prepared.kind === 'dispatch') {
                  // 正常分发：发射 around-dispatch/程序体阶段，落定时登记 parked。
                  this.flight = executor.dispatch(prepared.exec).then((dispatchOutcome) => {
                    parked = { kind: dispatchOutcome.kind, exec: prepared.exec, result: dispatchOutcome.result }
                    this.settled = true
                  })
                  return
                }
                // 预执行直接出结果（守卫拦截等）：立即标记 settled。
                parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
                this.settled = true
              },
              async commit(): Promise<void> {
                /* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
                if (parked === undefined) return
                // 有序阶段：执行完整完成管线（post-execute 等）。
                const result = await executor.complete(parked.exec, parked)
                if (!usesProgramImage && !result.isError && result.content.some(block => block.type === 'image')) {
                  exec.deferContext(createUserMessage({
                    content: result.content,
                    source: { kind: 'ptc-mode' },
                  }))
                }
                // 透传嵌套结果的附加上下文。
                for (const context of result.additionalContexts ?? []) {
                  exec.deferContext(context)
                }
                // The composite forwards `additionalContexts` above and
                // `concludesTurn` here from the nested result. Only a successful
                // nested result can carry the terminal marker
                // (ToolExecutionFailure types it never), so a policy-converted
                // failure cannot stop the turn through a recovering program.
                // 组合器上方透传 additionalContexts，这里透传 concludesTurn。
                // 只有成功的嵌套结果能携带终止标记（ToolExecutionFailure
                // 类型永不携带），策略转换出的失败无法借恢复中的程序终止轮次。
                if (result.concludesTurn) exec.concludeTurn()
                settle(result, parked.result.content.some(block => block.type === 'image')
                  && !result.content.some(block => block.type === 'image'))
                // Backpressure on pending event-append tasks: each task retains
                // a full result while a slow backend stores it, so the pool cap
                // bounds their count. Beyond the cap, the
                // ordered lane waits, so later sub-calls cannot start and
                // pending I/O/memory cannot grow without bound.
                // 对未完成事件追加任务施加背压：每个任务在慢后端存储期间都
                // 持有完整结果，池上限约束其数量；超上限时有序车道等待，
                // 后续子调用无法启动，待决 I/O 与内存不会无界增长。
                while (logWork.size > maxParallel) await Promise.race(logWork)
              },
            })
            // 唤醒驱动器并异步开跑。
            wakeup()
            void drive()
          })
          // A budget expiry or outer cancel that occurs while this call was in
          // flight already aborted the dispatch; stop the program now rather
          // than hand it a result from a run that is over.
          // 本调用在途期间发生的预算到期或外层取消已经中止了该分发；
          // 现在就停程序，而不是把已结束 run 的结果递给它。
          if (runOver()) {
            throw new Error(`${toolName} run is over (${String(runController.signal.reason)}); ${name} result discarded`)
          }
          // The worker turns a binding rejection into ToolCallError and adds
          // only the binding name. Native content and internal error metadata
          // stay outside the program-facing failure contract.
          // worker 侧把绑定拒绝转成 ToolCallError，只附加绑定名。
          // 原生内容与内部错误元数据不进入程序侧的失败契约。
          if (outcome.isError) throw new Error(outcome.message)
          if (usesProgramImage) {
            const images = outcome.content.filter(block => block.type === 'image')
            const first = images[0]
            if (first !== undefined && images.length === 1) return programImage(first.attachment)
            if (outcome.imageRemoved) {
              throw new Error('Image output was removed by a tool output policy.\n'
                + outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
            }
            if (name === 'read_image' || images.length > 1) throw new Error('Image-producing tools must return exactly one image')
          }
          return outcome.value
        }

        // Null-prototype + defineProperty, mirroring the worker-side namespace
        // build: a registered tool named `__proto__` must become an ordinary
        // own key (a plain-object assignment would hit the prototype setter,
        // silently dropping the binding), and the runtime host resolves
        // binding names as own properties only.
        // 空原型 + defineProperty，与 worker 侧命名空间构建一致：名为 `__proto__`
        // 的注册工具必须成为普通自有键（普通对象赋值会命中原型 setter，静默
        // 丢掉绑定），且运行时宿主只按自有属性解析绑定名。
        const functions: Record<string, PtcBindingFunction> = Object.create(null) as Record<string, PtcBindingFunction>
        // PTC uses step-admitted registry tools; a registered program tool uses
        // only its private definitions, resolved by its own pipeline on each call.
        const schemas = options === undefined ? tools.schemas(exec.agent, exec.toolSet)
          : options.tools.map(definition => projectToolSchema(definition, true))
        for (const schema of schemas) {
          Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(deepFreeze(schema)) })
        }

        try {
          // 运行结果槽位。
          let result: PtcRunResult
          try {
            // 有主运行：确保"运行时保留环境"的释放 effect 每个 provider 只注册一次。
            if (exec.agent !== undefined) {
              const agent = exec.agent
              let runtimes = stateOwners.get(agent)
              if (runtimes === undefined) stateOwners.set(agent, runtimes = new WeakSet())
              // Cordis can wrap service returns repeatedly; cleanup belongs to the original provider.
              // Cordis 可能层层包装服务返回值；清理归属于最初的 provider。
              let provider: PtcRuntime = runtime
              for (;;) {
                // 沿 symbols.original 一路解包到原始 provider。
                const original = (provider as PtcRuntime & { [symbols.original]?: PtcRuntime })[symbols.original]
                if (original === undefined) break
                provider = original
              }
              if (!runtimes.has(provider)) {
                // 在智能体作用域上登记释放 effect；agent 卸载时释放保留环境。
                agent.ctx.effect(() => () => runtime.release(agent), 'PTC retained environment')
                runtimes.add(provider)
              }
            }
            // 解析运行 spec：程序、状态归属（仅当策略模式未升级）、绑定集、
            // 取消信号、目录、沙箱策略与超时。
            const spec = runtime.resolve({
              program: args.code,
              ...runtime.language === 'typescript' ? { discardCompletion: true } : {},
              ...exec.agent === undefined || policy?.mode !== standingPolicy?.mode ? {} : { stateOwner: exec.agent },
              bindings: [{
                global: 'tools',
                functions,
                // 程序侧错误类：名为 ToolCallError，携带 toolName 成员。
                errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
              }],
              signal: runController.signal,
              ...cwd !== undefined ? { cwd } : {},
              ...policy !== undefined ? { sandboxPolicy: policy } : {},
              ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
            })
            // 由解析出的超时推导子调用配额：无超时即无上限；否则按分钟配额折算。
            maxSubCalls = spec.timeoutMs === null ? Infinity
              : Math.floor(spec.timeoutMs / 60_000 * maxSubCallsPerMinute)
            // 运行程序。
            result = await runtime.run(spec)
          } finally {
            // Abort sub-dispatches and drain every in-flight dispatch before
            // closing the turn (queued-unstarted ones are abandoned unlogged).
            // Binding failures remain observable through their individual promises.
            runController.abort(`${toolName} settled`)
            await drainDispatches()
          }

          const logs = result.output.flatMap(block => block.type === 'text' ? [block.text] : [])
          const hasImages = result.output.some(block => block.type === 'image')
          if (result.error) {
            // 若中止原因是配额超限，取出该错误。
            const limitError = runController.signal.reason instanceof ToolCallLimitExceededError
              ? runController.signal.reason : undefined
            let failure: HarnessError
            if (result.error.kind === 'abort' && exec.signal.aborted && limitError === undefined) {
              const message = runtime.retainsState ? `tool call aborted: ${result.error.message}` : 'tool call aborted'
              failure = new HarnessError(message, TOOL_ABORTED)
              failure.name = 'AbortError'
            } else {
              const logsText = logs.length > 0 && !hasImages
                ? `\nCaptured output:\n${logs.join('')}` : ''
              const sandboxText = result.sandbox === undefined ? ''
                : `${logsText.endsWith('\n') ? '' : '\n'}File sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === undefined ? '' : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? '; operation denied' : ''}.`
              const failureText = limitError === undefined || limitError.message === result.error.message
                ? result.error.message : `${limitError.message}\n${result.error.message}`
              failure = new CodeRunFailedError(`code run failed (${result.error.kind}): ${failureText}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime.sandboxMode) : ''}`)
            }
            if (hasImages) inspections.set(exec, {
              failure: {
                error: { message: failure.message, info: { name: failure.name, code: failure.code } },
                content: [{ type: 'text', text: `Error: ${failure.message}` }],
              },
              output: result.output,
            })
            throw failure
          }
          const value: RunCodeOutput = {
            logs,
            ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
            ...runtime.language !== 'typescript' && result.value !== undefined ? { result: result.value } : {},
          }
          if (hasImages) inspections.set(exec, { value, output: result.output })
          return value
        } finally {
          // 无论成败都移除外层取消桥接监听。
          callSignal.removeEventListener('abort', onOuterAbort)
        }
      }
      // 入口分派：无主运行或"无沙箱且不留状态"直接执行；
      // 否则经 PtcCalls 的按会话协调（含沙箱模式读取钩子）执行。
      return exec.agent === undefined || (runtime.sandboxMode === undefined && !runtime.retainsState) ? run(exec.signal)
        : calls.run(exec.agent.session.id, exec.signal,
          () => runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec).mode, run)
    },
    projectContent(exec, result) {
      const selected = inspections.get(exec)
      inspections.delete(exec)
      if (selected === undefined) return undefined
      if (result.isError) {
        if (!isDeepStrictEqual(selected.failure, { error: result.error, content: result.content })) return undefined
        return [...result.content, ...renderRunOutput({ logs: [] }, '', selected.output, toolName)]
      }
      if (selected.value === undefined || !isDeepStrictEqual(selected.value, result.value)) return undefined
      return renderRunOutput(selected.value,
        escalationGuidance(options === undefined ? ctx.get('ptcRuntime')?.sandboxMode : options.runtime.sandboxMode), selected.output, toolName)
    },
    // The model-authored description is the call's always-visible UI label
    // (the bash `description` precedent); the program itself rides rawInput.
    // 模型撰写的 description 是调用卡常显的 UI 标题（沿用 bash 的 description
    // 先例）；程序本体挂在 rawInput 上。
    presentCall: args => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
    // Deliberately no presentResult: the generic card fallback keeps this
    // title and reads durable result content without duplicating a large raw
    // result into the host view payload.
    // 刻意不提供 presentResult：generic 卡兜底沿用该标题并读取持久结果内容，
    // 避免把大体量原始结果复制进宿主视图载荷。
  })
  // Read current runtime instructions and controls whenever the schema is projected.
  // schema 每次投影时都实时读取当前运行时的指令与控制项。
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    // 语言感知的 description getter。
    get: () => {
      const runtime = getRuntime()
      const instructions = runtime.executionInstructions
      return (options?.description ?? resolveFlavor(runtime).description)
        + (instructions ? ` ${instructions}` : '')
        + " Each program starts in the Session's current directory. Running programs keep their initial directory."
        + escalationGuidance(runtime.sandboxMode)
    },
  })
  // 语言感知的 parameters getter。
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    // Recompile through the same spec→schema projection defineTool used, so
    // the emitted schema always matches the validated specification.
    // 经 defineTool 同一条 spec→schema 投影重新编译，
    // 保证发射的 schema 永远与校验用规范一致。
    get: () => {
      const runtime = getRuntime()
      return parameterSchemaSpecToJsonSchema({
        code: { type: 'string', required: true, description: resolveFlavor(runtime).codeDescription },
        description: { type: 'string', required: true, description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION },
        ...controlParameters(runtime),
      })
    },
  })
  // 返回组装好的工具定义。
  return definition
}
