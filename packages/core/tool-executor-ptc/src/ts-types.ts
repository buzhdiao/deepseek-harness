// 模块说明：PTC 模式代码生成（TypeScript 风味）——把注册工具 schema 纯投影为
// 模型面对的 TypeScript SDK 文本（tools:sdk 提示词段）。与 json-schema.ts 是姊妹
// 文件：schemas()（原生函数调用）与本模块（生成的 declare const tools API）
// 是同一存储的两个投影。渲染全程显式帧、类型文档可组合摊平，保证栈安全与线性拼接。
/**
 * PTC mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * text the model programs against (the `tools:sdk` prompt section). Sibling of
 * `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
 * `declare const tools` API) are two projections of the same store.
 * @module @deepseek-ai/dsh-tools/src/ts-types
 */

// 线上工具 schema 类型。
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
// PTC 程序语法类型（函数体/脚本等）。
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
// 强制 JSON Schema 子集断言。
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
// 校验后的 schema 节点与标量类型。
import type { JsonSchemaNode, JsonSchemaScalar } from '@deepseek-ai/dsh-tools'
/** Internal PTC mode projection: the model-facing schema plus the canonical output schema. */
// 内部 PTC 投影：模型侧 schema + 规范输出 schema。
export interface ToolSdkSchema extends Readonly<ToolSchema> {
  /** Validated canonical value returned by the tool binding. */
  // 工具绑定返回的已校验规范值 schema。
  readonly output: JsonSchemaNode
}

/** Property names that are valid bare TS identifiers; anything else is quoted. */
// 可作裸 TS 标识符的属性名模式；其余一律加引号。
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
// 渲染对象键：合法标识符裸写，否则 JSON 引号包裹（所有名字保持可达，无别名）。
function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** One `indent`-deep line prefix (two spaces per level). */
// indent 层深的行前缀（每层两空格）。
function pad(indent: number): string {
  return '  '.repeat(indent)
}

/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
// schema description 的单行 JSDoc 块；无描述则不产出。
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  // Collapse prose to stable one-line docs and escape comment closers so a
  // schema description cannot terminate generated JSDoc.
  // 散文压成稳定的单行文档并转义注释结束符——
  // schema 描述绝不能提前终结生成的 JSDoc。
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/** Render one scalar already validated by the unified schema boundary. */
// 渲染一个已被统一 schema 边界校验过的标量。
function renderScalar(value: JsonSchemaScalar): string {
  return JSON.stringify(value)
}

/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
// 渲染已校验标量的 const/enum，无约束则回落宽类型（integer -> number）。
function renderConstrainedScalar(node: Record<string, unknown>, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return renderScalar(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(renderScalar).join(' | ')
  }
  return broad
}

/** A composable type document that can be flattened without recursive string concatenation. */
// 可组合的类型文档：摊平时不做递归字符串拼接（惰性树）。
interface TypeDocument {
  // 文档部件（字符串片段或子文档）。
  readonly parts: readonly (string | TypeDocument)[]
  // 是否含联合/交叉（决定数组是否要加括号）。
  readonly containsUnionOrIntersection: boolean
}

/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
// 从部件构建文档；保留既有的数组括号判定（部件含 | 或 & 即算）。
function typeDocumentFrom(parts: readonly (string | TypeDocument)[]): TypeDocument {
  return {
    parts,
    containsUnionOrIntersection: parts.some(part => typeof part === 'string'
      ? part.includes('|') || part.includes('&')
      : part.containsUnionOrIntersection),
  }
}

/** Build a small document without an intermediate array at each call site. */
// 可变参数构建小文档（免去调用点建中间数组）。
function typeDocument(...parts: (string | TypeDocument)[]): TypeDocument {
  return typeDocumentFrom(parts)
}

/** Flatten a nested document with an explicit work stack. */
// 用显式工作栈摊平嵌套文档。
function flattenTypeDocument(document: TypeDocument): string {
  const chunks: string[] = []
  const tasks: (string | TypeDocument)[] = [document]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    // 字符串片段直接进输出。
    if (typeof task === 'string') {
      chunks.push(task)
      continue
    }
    // 子文档逆序压栈保持正序输出。
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index]
      /* v8 ignore next -- the loop is bounded by the captured part count. */
      if (part !== undefined) tasks.push(part)
    }
  }
  return chunks.join('')
}

/** One explicit call frame for stack-safe schema-to-TypeScript rendering. */
// 栈安全 schema->TS 渲染的显式调用帧。
interface SchemaRenderFrame {
  // 本帧 schema 节点。
  readonly node: JsonSchemaNode
  // 缩进层级。
  readonly indent: number
  // 阶段：start / children。
  phase: 'start' | 'children'
  // 帧类别。
  kind?: 'oneOf' | 'array' | 'object'
  // 待处理子节点。
  children: { node: JsonSchemaNode; indent: number }[]
  // 子节点游标。
  childIndex: number
  // 已完成的子文档。
  childDocuments: TypeDocument[]
  // 对象帧的属性表。
  entries: [string, JsonSchemaNode][]
}

/** Initialize one schema-render frame with empty aggregation state. */
// 初始化一个渲染帧（聚合状态全空）。
function schemaRenderFrame(node: JsonSchemaNode, indent: number): SchemaRenderFrame {
  return { node, indent, phase: 'start', children: [], childIndex: 0, childDocuments: [], entries: [] }
}

/** Render an already asserted schema to a composable document. */
// 把已断言的 schema 渲染成可组合文档（显式帧遍历）。
function renderSupportedSchema(schema: JsonSchemaNode, indent: number): TypeDocument {
  // 根帧入栈。
  const frames: SchemaRenderFrame[] = [schemaRenderFrame(schema, indent)]
  // 根文档。
  let rootDocument: TypeDocument | undefined
  // 子文档完成回调：弹栈交给父帧或作为根结果。
  const finish = (document: TypeDocument): void => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined) rootDocument = document
    else parent.childDocuments.push(document)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    if (frame.phase === 'children') {
      // 子节点未处理完：继续压栈。
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        /* v8 ignore next -- childIndex is bounded by children.length. */
        if (child === undefined) throw new Error('missing schema render child')
        frame.childIndex++
        frames.push(schemaRenderFrame(child.node, child.indent))
        continue
      }
      if (frame.kind === 'oneOf') {
        // 联合收尾：子文档以 " | " 相接。
        const parts: (string | TypeDocument)[] = []
        for (let index = 0; index < frame.childDocuments.length; index++) {
          if (index > 0) parts.push(' | ')
          const child = frame.childDocuments[index]
          /* v8 ignore next -- child documents correspond one-to-one with children. */
          if (child !== undefined) parts.push(child)
        }
        finish(typeDocumentFrom(parts))
        continue
      }
      if (frame.kind === 'array') {
        // 数组收尾：含联合/交叉的子类型加括号再接 []。
        const child = frame.childDocuments[0]
        /* v8 ignore next -- array frames always schedule exactly one child. */
        if (child === undefined) throw new Error('missing array item type')
        finish(child.containsUnionOrIntersection
          ? typeDocument('(', child, ')[]')
          : typeDocument(child, '[]'))
        continue
      }

      // 对象收尾：组装多行对象字面量。
      const required = new Set(frame.node.required)
      const parts: (string | TypeDocument)[] = ['{']
      for (let index = 0; index < frame.entries.length; index++) {
        const entry = frame.entries[index]
        const child = frame.childDocuments[index]
        /* v8 ignore next -- object entries and child documents have the same length. */
        if (entry === undefined || child === undefined) throw new Error('missing object property type')
        const [name, prop] = entry
        // 属性描述先出 JSDoc 行。
        for (const line of docLines(prop.description, frame.indent + 1)) parts.push('\n', line)
        // 属性行：键 + 可选标记 + 子类型 + 分号。
        parts.push('\n', `${pad(frame.indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: `, child, ';')
      }
      // 闭合花括号。
      parts.push('\n', `${pad(frame.indent)}}`)
      const declared = typeDocumentFrom(parts)
      // 开放对象并入字符串索引签名；封闭对象保持声明。
      finish(frame.node.additionalProperties === false
        ? declared
        : typeDocument(declared, ' & Record<string, JsonValue>'))
      continue
    }

    const node = frame.node
    if (node.oneOf !== undefined) {
      // 联合：分支共享同一缩进。
      frame.kind = 'oneOf'
      frame.children = Array.from(node.oneOf, child => ({ node: child, indent: frame.indent }))
      frame.childIndex = 0
      frame.childDocuments = []
      frame.phase = 'children'
      continue
    }
    if (node.type === undefined) {
      // 无类型：JsonValue。
      finish(typeDocument('JsonValue'))
      continue
    }
    switch (node.type) {
      // 标量：走 const/enum 渲染。
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        finish(typeDocument(renderConstrainedScalar(node as Record<string, unknown>, node.type)))
        break
      case 'array':
        // 数组：无 items 即 JsonValue[]。
        if (node.items === undefined) {
          finish(typeDocument('JsonValue[]'))
        } else {
          // 有 items：排一个子帧。
          frame.kind = 'array'
          frame.children = [{ node: node.items, indent: frame.indent }]
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      case 'object': {
        // 对象：开放性判定 + 属性收集。
        const open = node.additionalProperties !== false
        const entries = Object.entries(node.properties ?? {})
        if (entries.length === 0) {
          // 空对象：开放即任意记录，封闭即禁键。
          finish(typeDocument(open ? 'Record<string, JsonValue>' : 'Record<string, never>'))
        } else {
          // 非空：排对象帧。
          frame.kind = 'object'
          frame.entries = entries
          frame.children = entries.map(([, child]) => ({ node: child, indent: frame.indent + 1 }))
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      }
      /* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
      default:
        // 兜底：unknown。
        finish(typeDocument('unknown'))
    }
  }

  /* v8 ignore next -- every root frame produces one document. */
  return rootDocument ?? typeDocument('unknown')
}

/**
 * Map one enforced JSON-Schema node to a TypeScript type literal. Supports
 * every unified schema construct and returns `unknown` for malformed or
 * unsupported inputs without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    // 先断言强制子集，再渲染摊平。
    assertSupportedJsonSchema(schema)
    return flattenTypeDocument(renderSupportedSchema(schema, indent))
  } catch {
    // 任何失败：宽化为 unknown（敌意输入降级不抛）。
    return 'unknown'
  }
}

/** Render the argument and call instructions for the selected execution syntax. */
// 按所选执行语法渲染实参与调用指令（提示词模板，一字不动）。
function renderSdkInstructions(programFormat: PtcProgramFormat): string {
  const programDescription = programFormat === 'function-body'
    ? 'the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped)'
    : 'the program to execute'
  return `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\`, ${programDescription}, and \`description\`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.`
}

/** Render tool execution and output instructions for the selected execution syntax. */
// 按所选执行语法渲染工具执行与输出指令（提示词模板）。
function renderSdkProgramInstructions(programFormat: PtcProgramFormat): string {
  const outputInstruction = programFormat === 'function-body'
    ? 'Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output.'
    : 'Only values emitted as program output enter the conversation.'
  return `Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- ${outputInstruction} A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:`
}

/** Whether one string schema accepts the literal used by the bash example. */
// 判断字符串 schema 是否接受 bash 示例用的字面量（const/enum 兼容）。
function acceptsExampleString(schema: JsonSchemaNode | undefined, value: string): boolean {
  return schema?.type === 'string'
    && (schema.const === undefined || schema.const === value)
    && (schema.enum === undefined || schema.enum.includes(value))
}

/** Render the bash example only when its literal arguments satisfy the current parameter schema. */
// 仅当示例的字面实参满足当前参数 schema 时才渲染 bash 示例。
function renderBashExample(schemas: ToolSdkSchema[], programFormat: PtcProgramFormat): string {
  // 找到 bash 工具。
  const bash = schemas.find(schema => schema.name === 'bash')
  if (bash === undefined) return ''
  // 参数必须是对象根。
  const parameters = bash.parameters as JsonSchemaNode
  if (parameters.type !== 'object') return ''
  // 必填键只能是 command 与 description 的子集。
  const required = parameters.required ?? []
  if (required.some(name => name !== 'command' && name !== 'description')) return ''
  // command 必须接受 'pwd'。
  if (!acceptsExampleString(parameters.properties?.command, 'pwd')) return ''
  // description 必填时也必须接受示例字面量。
  const needsDescription = required.includes('description')
  if (needsDescription && !acceptsExampleString(parameters.properties?.description, 'Show current directory')) return ''
  // 组装示例参数文本。
  const description = needsDescription ? "description: 'Show current directory', " : ''
  // 按程序语法选择输出方式。
  const program = programFormat === 'function-body'
    ? `return await tools.bash({ ${description}command: 'pwd' })`
    : `console.log(await tools.bash({ ${description}command: 'pwd' }))`
  // 返回带上下文的示例段。
  return ` When no separate \`bash\` schema is supplied, invoke a declared \`bash\` binding inside \`run_code\`:\n\n\`run_code({ code: "${program}", description: "Show current directory" })\``
}

/**
 * Render the full `tools:sdk` prompt section: the fixed usage instructions
 * plus one `declare const tools` interface covering every given tool.
 * Deterministic — tools are emitted in lexicographic name order, so an
 * unchanged tool set produces byte-identical text across assemblies. The sort
 * is not a total order on byte-equal names, so two schemas sharing a name
 * would render in argument order; the caller's visible-capability map is keyed
 * by name, so the input never carries a duplicate.
 * @param schemas - the tool schemas to declare (the caller excludes
 *   `run_code` itself).
 * @param programFormat - Runtime syntax selecting function-body, REPL, or Script instructions and examples.
 * @returns the complete section text.
 */
export function renderToolsSdk(schemas: readonly ToolSdkSchema[], programFormat: PtcProgramFormat = 'function-body'): string {
  // 工具按名字字典序排序（确定性输出）。
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  // 参数映射与输出映射的成员行收集器。
  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    // 参数成员：先描述 JSDoc，再键与类型。
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    // 输出成员。
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }
  // 组装两个映射接口。
  const argsMap = `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`
  const outputMap = `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  // 组装完整声明：映射接口 + 工具名 + 错误类 + tools 单例。
  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')
  // 固定的 JsonValue 类型定义。
  const jsonValue = 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'
  // 使用契约与程序内指令。
  const instructions = renderSdkInstructions(programFormat)
  const programInstructions = renderSdkProgramInstructions(programFormat)
  // 最终输出：指令 + bash 示例 + ts 代码围栏包住声明。
  return `${instructions}${renderBashExample(sorted, programFormat)}\n\n${programInstructions}\n\n\`\`\`ts\n${jsonValue}\n\n${declaration}\n\`\`\``
}
