// 模块说明：统一的 JSON 值 schema DSL、类型推断、编译与工具定义辅助——
// 工具作者面对的"声明层"。作者写紧凑的 DSL spec（带字面量约束与 required: true），
// 本文件把它编译进 json-schema.ts 的强制子集，并通过 TS 条件类型把
// 参数/输出的静态类型推断回 execute/render 回调。关键设计：
// 1. 编译走显式任务栈（栈安全，防敌意深 schema）；
// 2. 对象开放性必须显式声明（additionalProperties 强制写 true/false），
//    杜绝嵌套对象意外获得 JSON Schema 的开放默认；
// 3. defineTool 的执行路径严格校验（ToolArgsError），
//    展示路径软校验回退（重放旧日志参数永不抛错）。
/** Unified JSON-value schema DSL, inference, compilation, and tool definition helpers. @module dsh-tools/schema */

// 结构化错误基类。
import { HarnessError } from '@deepseek-ai/dsh-llm'
// 内容块与工具 schema 线上类型。
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
// 无损 JSON 快照与 JsonValue 类型。
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// 工具契约类型：定义、执行对象、结果、运行上下文、结果视图。
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext, ToolResult } from './contracts.ts'
// 强制子集原语：断言/判定/错误类型/值校验。
import { assertSupportedJsonSchema, isJsonSchemaRecord, isPlainJsonArray, JsonSchemaError, validateJsonSchemaValue } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar, ObjectJsonSchema } from './json-schema.ts'
// 展示视图类型：调用卡与结果卡。
import type { ToolCallView, ToolResultView } from './presentation.ts'

/** Annotation keywords shared by every author-facing schema node. */
// 所有作者侧 schema 节点共享的注解关键字。
export interface ValueSchemaAnnotations {
  /** Human-readable description projected into JSON Schema and generated types. */
  // 人类可读描述（投影进 JSON Schema 与生成类型）。
  description?: string
  /** Human-readable title projected into JSON Schema. */
  // 人类可读标题（投影进 JSON Schema）。
  title?: string
  /** Non-validating default annotation; it must be lossless JSON data. */
  // 不参与校验的 default 注解；必须是无损 JSON 数据。
  default?: JsonValue
  /** Non-validating examples annotation; it must be lossless JSON data. */
  // 不参与校验的 examples 注解；必须是无损 JSON 数据。
  examples?: JsonValue
}

/** String value schema with type-correct literal constraints. */
// 字符串值 schema（类型正确的字面量约束）。
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

/** Finite JSON-number schema with type-correct literal constraints. */
// 有限 JSON 数值 schema。
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

/** Integer schema with type-correct literal constraints. */
// 整数 schema。
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

/** Boolean value schema with type-correct literal constraints. */
// 布尔值 schema。
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

/** Null value schema with type-correct literal constraints. */
// null 值 schema。
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

/** Array value schema; omitted `items` accepts any lossless JSON item. */
// 数组值 schema；items 缺省即接受任意无损 JSON 元素。
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/**
 * Explicit object value schema. Openness is mandatory so a nested or output
 * object never acquires an accidental JSON Schema default.
 */
// 显式对象值 schema。开放性必须显式声明——嵌套/输出对象
// 绝不能意外获得 JSON Schema 的开放默认。
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  // 属性映射（隐式开放对象根）。
  properties?: ParameterSchemaSpec
  // 显式的开放/封闭声明。
  additionalProperties: boolean
}

/** Author-only unconstrained lossless JSON node. */
// 仅作者可用的"任意无损 JSON"节点。
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

/** Exact-one union schema; at least two branches are required. */
// "恰一"联合 schema；至少两个分支。
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

/** One author-facing schema for any lossless JSON value root. */
// 面向作者的任意无损 JSON 值根 schema（九类并集）。
export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

/** One implicit parameter-root property, optionally required. */
// 隐式参数根下的一个属性（可选 required: true）。
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
// 工具参数 schema：映射本身是隐式开放对象根；
// 必填性仍由逐属性的 required: true 表达。
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  // 符号键被类型层面禁止（运行期编译也会拒绝）。
  [key: symbol]: never
}

/** Raw JSON Schema projection of the implicit parameter object. */
// 隐式参数对象的 raw JSON Schema 投影。
export interface ParameterJsonSchema extends ObjectJsonSchema {
  properties: Record<string, JsonSchemaNode>
}

/** Flatten an intersection into one object type for readable hovers. */
// 把交叉类型摊平成单个对象类型（悬停更易读）。
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** String keys of one property map; runtime compilation rejects symbol keys. */
// 属性映射的字符串键；运行期编译拒绝符号键。
type StringKeyOf<S> = Extract<keyof S, string>

/** Keys of a property map marked `required: true`. */
// 标记了 required: true 的属性键集合。
type RequiredKeys<S> = {
  [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
}[StringKeyOf<S>]

/** Infer the declared value of one parameter property without key optionality. */
// 推断单个参数属性的声明值类型（不管键的可选性）。
type InferProperty<P, Depth extends unknown[]> = InferValueAt<P, Depth>

/** Infer an implicit property map into required and optional object keys. */
// 把隐式属性映射推断为"必填键 + 可选键"的对象类型。
type InferProperties<S, Depth extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferProperty<S[K], Depth> }
  & { [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferProperty<S[K], Depth> }
>

/** Infer an explicit object node, including its declared openness. */
// 推断显式对象节点：含其声明的开放性（开放对象并入字符串索引签名）。
type InferObject<S extends { additionalProperties: boolean }, Depth extends unknown[]> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? InferProperties<P, Depth> & Record<string, JsonValue>
      : InferProperties<P, Depth>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      // 封闭空对象：除声明键外全禁止。
      : Record<string, never>

/** Infer a scalar node's literal constraint before its broad primitive type. */
// 标量推断：先看字面量约束（const/enum），再看宽原始类型。
type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

/** Add one schema-container level to bounded compile-time inference. */
// 编译期推断深度 +1 层。
type NextInferenceDepth<Depth extends unknown[]> = [unknown, ...Depth]

/** Infer one node without recursively checking it against the full author union. */
// 逐节点推断：递归深度封顶 16 层，超过即回落 JsonValue。
type InferValueAt<S, Depth extends unknown[]> =
  Depth['length'] extends 16 ? JsonValue :
    S extends { type: 'string' } ? InferScalar<S, string> :
      S extends { type: 'number' | 'integer' } ? InferScalar<S, number> :
        S extends { type: 'boolean' } ? InferScalar<S, boolean> :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I, NextInferenceDepth<Depth>>[] : JsonValue[]
              : S extends { type: 'object'; additionalProperties: boolean }
                ? InferObject<S, NextInferenceDepth<Depth>>
                : S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] }
                    ? InferValueAt<S['oneOf'][number], NextInferenceDepth<Depth>>
                    : never

/**
 * Infer the TypeScript value accepted by an author-facing value schema. Exact
 * inference is bounded to 16 container levels, then falls back to `JsonValue`.
 */
// 作者侧值 schema 接受的 TS 值类型；精确推断封顶 16 层后回落 JsonValue。
export type InferValue<S> = InferValueAt<S, []>

/** Infer the TypeScript argument object for an implicit parameter schema. */
// 隐式参数 schema 推断出的 TS 实参对象类型。
export type InferArgs<S> = InferProperties<S, []>

// 注解键列表。
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

/** Throw one author-schema violation through the shared schema error type. */
// 经共享错误类型抛出一条作者 schema 违规。
function authorError(message: string): never {
  throw new JsonSchemaError([message])
}

/** Copy own annotation fields for validation by the raw-schema boundary. */
// 拷贝自有注解字段，交给 raw-schema 边界校验（无损 JSON 要求在那里检查）。
function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  if (Object.hasOwn(source, 'description')) target.description = source.description as string
  if (Object.hasOwn(source, 'title')) target.title = source.title as string
  if (Object.hasOwn(source, 'default')) target.default = source.default as JsonValue
  if (Object.hasOwn(source, 'examples')) target.examples = source.examples as JsonValue
}

/** Reject author-only keys outside one node's declared vocabulary. */
// 拒绝节点声明词汇表之外的作者键。
function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/** Compiled form of one implicit property map. */
// 隐式属性映射的编译产物。
interface CompiledPropertyMap {
  // 编译后的属性 schema。
  properties: Record<string, JsonSchemaNode>
  // 必填键列表（存在时）。
  required?: string[]
}

/** Mutable holder used only while an iterative compilation root is unresolved. */
// 仅在迭代编译根未落定时使用的可变持有器。
interface CompileRoot<T> {
  value?: T
}

/** Where one compiled value node is installed. */
// 编译产物值节点的安装位置。
type NodeDestination =
  | { kind: 'root'; holder: CompileRoot<JsonSchemaNode> }
  | { kind: 'property'; target: Record<string, JsonSchemaNode>; key: string }
  | { kind: 'item'; target: JsonSchemaNode }
  | { kind: 'one-of'; target: JsonSchemaNode[]; index: number }

/** Where one compiled property map is installed. */
// 编译产物属性映射的安装位置。
type PropertyMapDestination =
  | { kind: 'root'; holder: CompileRoot<CompiledPropertyMap> }
  | { kind: 'object'; target: JsonSchemaNode }

/** Deferred work for stack-safe author-schema compilation. */
// 栈安全作者 schema 编译的延迟任务（五类）。
type CompileTask =
  | { kind: 'value'; input: unknown; path: string; allowRequired: boolean; destination: NodeDestination }
  | { kind: 'property-map'; input: unknown; path: string; destination: PropertyMapDestination }
  | {
    kind: 'property'
    property: unknown
    path: string
    key: string
    properties: Record<string, JsonSchemaNode>
    required: string[]
  }
  | {
    kind: 'property-map-tail'
    compiled: CompiledPropertyMap
    required: string[]
    destination: PropertyMapDestination
  }
  | { kind: 'leave'; input: object }

/** Install a compiled node without giving `__proto__` assignment semantics. */
// 安装编译节点：不走赋值语义，杜绝 `__proto__` 键的攻击面。
function assignCompiledNode(destination: NodeDestination, node: JsonSchemaNode): void {
  switch (destination.kind) {
    // 根：写持有器。
    case 'root':
      destination.holder.value = node
      break
    // 属性：用 defineProperty 而非赋值。
    case 'property':
      Object.defineProperty(destination.target, destination.key, {
        value: node,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      break
    // 数组 items。
    case 'item':
      destination.target.items = node
      break
    // oneOf 分支。
    case 'one-of':
      destination.target[destination.index] = node
      break
  }
}

/** Install a compiled property map at its root or containing object node. */
// 把编译后的属性映射安装到根持有器或所属对象节点。
function assignCompiledPropertyMap(destination: PropertyMapDestination, compiled: CompiledPropertyMap): void {
  if (destination.kind === 'root') {
    destination.holder.value = compiled
  } else {
    destination.target.properties = compiled.properties
  }
}

/** Execute an author-schema compilation task graph without recursive descent. */
// 执行作者 schema 编译任务图：不用递归下降（显式任务栈）。
function runSchemaCompiler(initial: CompileTask): void {
  // 循环检测集合。
  const seen = new Set<object>()
  const tasks: CompileTask[] = [initial]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    // 离开：清除循环标记。
    if (task.kind === 'leave') {
      seen.delete(task.input)
      continue
    }
    // 属性映射收尾：写入必填键列表。
    if (task.kind === 'property-map-tail') {
      if (task.required.length > 0) {
        task.compiled.required = task.required
        if (task.destination.kind === 'object') task.destination.target.required = task.required
      }
      continue
    }
    // 属性任务：先校验 required 注解，再派值任务。
    if (task.kind === 'property') {
      // 属性值必须是值 schema 对象。
      if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`)
      // required 若存在只能是 true。
      if (Object.hasOwn(task.property, 'required') && task.property.required !== true) {
        authorError(`${task.path}.required must be true when present`)
      }
      if (Object.hasOwn(task.property, 'required') && task.property.required === true) task.required.push(task.key)
      // 派发值编译任务（该层级允许 required 键）。
      tasks.push({
        kind: 'value',
        input: task.property,
        path: task.path,
        allowRequired: true,
        destination: { kind: 'property', target: task.properties, key: task.key },
      })
      continue
    }
    // 属性映射任务：登记循环检测、建产物并逐属性派任务。
    if (task.kind === 'property-map') {
      // 必须是值 schema 对象映射。
      if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`)
      // 循环引用：报错。
      if (seen.has(task.input)) authorError(`${task.path} is circular`)
      seen.add(task.input)
      // 先建产物并安装（根任务赋值先于后代调度）。
      const compiled: CompiledPropertyMap = { properties: {} }
      const required: string[] = []
      assignCompiledPropertyMap(task.destination, compiled)
      tasks.push({ kind: 'leave', input: task.input })
      // 收尾任务负责必填列表。
      tasks.push({ kind: 'property-map-tail', compiled, required, destination: task.destination })
      // 逆序压栈保持正序处理。
      const entries = Object.entries(task.input)
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        /* v8 ignore next -- the loop is bounded by the captured entry count. */
        if (entry === undefined) continue
        tasks.push({
          kind: 'property',
          property: entry[1],
          path: `${task.path}.${entry[0]}`,
          key: entry[0],
          properties: compiled.properties,
          required,
        })
      }
      continue
    }

    // 值任务：校验并按类型编译。
    const { input, path } = task
    if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`)
    if (seen.has(input)) authorError(`${path} is circular`)
    seen.add(input)
    // 允许键 = 注解 + （可选）required。
    const authorKeys = [...ANNOTATION_KEYS, ...(task.allowRequired ? ['required'] : [])]
    // 先建空节点并安装（保证根引用可用）。
    const node: JsonSchemaNode = {}
    assignCompiledNode(task.destination, node)
    tasks.push({ kind: 'leave', input })

    if (Object.hasOwn(input, 'oneOf')) {
      // 联合节点：type 与 oneOf 互斥；分支至少两个。
      assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
      if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
      if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`)
      // 建分支容器并复制注解。
      const branches: JsonSchemaNode[] = []
      node.oneOf = branches
      copyAnnotations(input, node)
      // 分支逆序压栈；分支层级不允许 required。
      for (let index = input.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          input: input.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          allowRequired: false,
          destination: { kind: 'one-of', target: branches, index },
        })
      }
      continue
    }

    // 按声明类型分派。
    const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
    switch (inputType) {
      // 任意 JSON：只允许注解。
      case 'json':
        assertAuthorKeys(input, path, [...authorKeys, 'type'])
        copyAnnotations(input, node)
        break
      // 对象：开放性必须显式声明。
      case 'object':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
          authorError(`${path}.additionalProperties must be explicitly true or false`)
        }
        node.type = 'object'
        copyAnnotations(input, node)
        node.additionalProperties = input.additionalProperties
        if (Object.hasOwn(input, 'properties')) {
          // 属性映射转交编译任务。
          tasks.push({
            kind: 'property-map',
            input: input.properties,
            path: `${path}.properties`,
            destination: { kind: 'object', target: node },
          })
        }
        break
      // 数组：items 可选。
      case 'array':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
        node.type = 'array'
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'items')) {
          tasks.push({
            kind: 'value',
            input: input.items,
            path: `${path}.items`,
            allowRequired: false,
            destination: { kind: 'item', target: node },
          })
        }
        break
      // 标量类型：支持 enum/const 字面量约束。
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
        node.type = inputType
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'enum')) {
          // enum 必须是非空标量数组。
          if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`)
          node.enum = Array.from(input.enum, entry => entry as JsonSchemaScalar)
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const as JsonSchemaScalar
        break
      default:
        // 未知类型：报错并提示合法集合。
        authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    }
  }
}

/** Compile one implicit property map, collecting per-property requiredness. */
// 编译一个隐式属性映射，收集逐属性的必填性。
function compilePropertyMap(input: unknown, path: string): CompiledPropertyMap {
  const holder: CompileRoot<CompiledPropertyMap> = {}
  runSchemaCompiler({ kind: 'property-map', input, path, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

/** Compile one author node without applying any consumer root restriction. */
// 编译一个作者节点，不施加任何消费方根限制。
function compileValueSchema(input: unknown, path: string): JsonSchemaNode {
  const holder: CompileRoot<JsonSchemaNode> = {}
  runSchemaCompiler({ kind: 'value', input, path, allowRequired: false, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

/**
 * Compile one author-facing value schema to the enforced raw JSON Schema
 * subset. The author-only `json` node becomes an annotation-only schema.
 * @param spec - schema for any JSON-value root.
 * @returns The asserted raw schema projection.
 */
// 把作者值 schema 编译到强制 raw 子集（json 节点编译为仅注解 schema）。
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  // 先编译。
  const schema = compileValueSchema(spec, 'schema')
  // 再经强制边界断言（双保险）。
  assertSupportedJsonSchema(schema)
  return schema
}

/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * @param spec - per-property parameter definitions.
 * @returns An object-rooted raw schema with no implicit-root openness override.
 */
// 把隐式开放参数对象编译为 raw JSON Schema（对象根，无开放性覆盖）。
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters')
  // 组装对象根 schema。
  const schema: ParameterJsonSchema = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
  // 过强制边界断言。
  assertSupportedJsonSchema(schema)
  return schema
}

/** Invalid model-generated arguments for a typed tool. */
// 类型化工具的非法模型生成参数。
export class ToolArgsError extends HarnessError {
  /** Individual violations in schema-walk order. */
  // 按遍历顺序排列的违规列表。
  readonly violations: string[]

  // 构造：聚合消息 + INVALID_ARGS 错误码。
  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/**
 * Validate model-generated arguments against an implicit parameter schema.
 * @param spec - declared parameter schema.
 * @param args - candidate arguments, however malformed.
 * @returns Path-qualified violations; empty means valid.
 */
// 用隐式参数 schema 校验模型生成的参数（对任意畸形输入全函数）。
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  return validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')
}

/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  /** Tool name (must be unique). */
  readonly name: string
  /** Human-readable description sent to the model. */
  readonly description: string
  /** Per-property parameter schema compiled to an implicit open object root. */
  readonly parameters: S
  /** Canonical output schema plus pure Native and presentation projections. */
  readonly output: {
    /** Schema enforced against every successful body or policy-replaced value. */
    readonly schema: O
    /** Pure Native/model rendering of one validated canonical value. */
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    /** Pure replayable presentation metadata for native and nested calls. */
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  /** Requests deferred loading of the tool definition; see {@link @deepseek-ai/dsh-llm#ToolSchema.deferLoading}. */
  readonly deferLoading?: true
  /** Optional positive cooperative timeout budget in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Pure classifier for sibling overlap.
   * @param args - typed validated arguments.
   * @returns Whether the call may join a parallel group.
   */
  isConcurrencySafe?(args: InferArgs<S>): boolean
  /**
   * Execute the tool after argument validation.
   * @param args - typed validated arguments.
   * @param exec - execution identity, caller, cancellation, and nesting data.
   * @returns The canonical value declared by `output.schema`.
   */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  /**
   * Install execution-prepared content before result policies.
   * @param exec - immutable execution identity and arguments.
   * @param result - normalized outcome entering post-execute.
   * @returns replacement content, or undefined to preserve it.
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Optional last-mile content transform for every normalized outcome. Unlike
   * `execute`, arguments remain `unknown` because invalid-input failures also
   * reach this callback. See {@link ToolDefinition.finalizeContent}.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Pure pending-state presenter.
   * @param args - typed validated arguments.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * Pure completed-state presenter.
   * @param args - typed validated arguments.
   * @param result - final model-facing tool result.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

/**
 * Define a first-party tool with inferred arguments and strict execution
 * validation. Replay-only presenters validate softly and fall back to generic
 * rendering for obsolete logged arguments.
 * @param options - typed definition and optional finalizer and presenters.
 * @returns A registry-ready definition.
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // Object-literal methods do not use `this`; retaining references is safe.
  // 对象字面量方法不用 this；提前保留引用是安全的（每类回调一条）。
  // oxlint-disable-next-line typescript/unbound-method
  const userExecute = options.execute
  // oxlint-disable-next-line typescript/unbound-method
  const userFinalizeContent = options.finalizeContent
  // oxlint-disable-next-line typescript/unbound-method
  const userProjectContent = options.projectContent
  // oxlint-disable-next-line typescript/unbound-method
  const userRender = options.output.render
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentationMeta = options.output.presentationMeta
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentCall = options.presentCall
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentResult = options.presentResult
  // oxlint-disable-next-line typescript/unbound-method
  const userIsConcurrencySafe = options.isConcurrencySafe
  // 超时预算必须是正的有限数。
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  // 加载期即编译参数与输出 schema。
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  // 参数校验闭包。
  const validate = (args: unknown): string[] => validateJsonSchemaValue(parameters, args, '')
  // 组装工具定义。
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    // raw 参数 schema。
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: outputSchema,
      // 渲染：类型收窄后转发给作者回调。
      render(args: unknown, value: JsonValue): ContentBlock[] {
        return userRender(args as InferArgs<S>, value as InferValue<NoInfer<O>>)
      },
      // 可选的展示元数据投影。
      ...userPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: JsonValue): JsonValue {
          return userPresentationMeta(args as InferArgs<S>, value as InferValue<NoInfer<O>>)
        },
      } : {},
    },
    // 可选的延迟加载标记与超时预算。
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // 执行包装：先严格校验（违例抛 ToolArgsError），再调用作者回调。
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec) as Promise<JsonValue>
    },
  }
  if (userProjectContent) {
    // 安装执行期内容投影。
    tool.projectContent = (exec, result) => userProjectContent(exec, result)
  }
  if (userFinalizeContent) {
    // 安装最终内容变换。
    tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result)
  }
  // Presentation is display-only and may run on REPLAY of arbitrary logged args
  // (possibly from an older schema), so it must never throw: validate softly and
  // fall back to `undefined` (a generic UI presentation) on any mismatch, rather
  // than the hard `ToolArgsError` the execute path raises.
  // 展示仅用于显示，且可能在"重放任意已记录参数"（可能来自旧 schema）时运行，
  // 所以绝不能抛错：软校验，任何不匹配都回退到 undefined（通用 UI 呈现），
  // 而不是执行路径的硬 ToolArgsError。
  if (userPresentCall) {
    // 调用卡展示：软校验回退。
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    // 结果卡展示：软校验回退。
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  if (userIsConcurrencySafe) {
    // 并发安全分类：参数非法时 fail-closed 为 false（不并行）。
    tool.isConcurrencySafe = (args: unknown): boolean => {
      if (validate(args).length > 0) return false
      return userIsConcurrencySafe(args as InferArgs<S>)
    }
  }
  return tool
}

/**
 * Omit execution and presentation callbacks from a tool definition.
 * @param definition - visible capability or executor-owned transport.
 * @param detachParameters - copy parameters for a caller-owned inspection result.
 * @returns the model-facing schema fields.
 */
// 从工具定义中省略执行与展示回调，只留模型可见的 schema 字段。
export function projectToolSchema(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
  // 解构模型可见字段。
  const { name, description, parameters, deferLoading } = definition
  // 按需分离参数快照（调用方自有的检查结果）。
  const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
  if (detached === undefined) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
  return { name, description, parameters: detached, ...deferLoading === true ? { deferLoading } : {} }
}
