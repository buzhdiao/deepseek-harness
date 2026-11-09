// 模块说明：强制的 JSON Schema 子集——工具输出、PTC 生成类型、子代理与
// 工作流共用的"最小可信校验语言"。子集只接受：任意 JSON 根、仅注解的
// 无约束 schema、单标量 type、对象的 properties/required/布尔
// additionalProperties、数组的 items、类型正确的标量 enum/const、
// 以及"恰好命中一个"的 oneOf。不支持或错位的 keyword 直接拒绝，
// 绝不"接受但不强制"（fail-closed）。校验全程用显式栈而非递归，
// 对敌意深 schema 保持栈安全。
/**
 * Enforced JSON Schema subset shared by tool outputs, generated PTC mode
 * types, subagents, and workflows. The subset accepts any JSON root, an
 * annotation-only schema for unconstrained JSON, one scalar `type`, object
 * `properties`/`required`/boolean `additionalProperties`, array `items`,
 * type-correct scalar `enum`/`const`, and exact-one `oneOf`.
 *
 * Unsupported or misplaced keywords reject rather than being accepted without
 * enforcement. Consumers that require an object root apply
 * {@link assertObjectJsonSchema} before accepting input.
 * @module dsh-tools/json-schema
 */

// HarnessError：结构化错误基类（带 name/code）。
import { HarnessError } from '@deepseek-ai/dsh-llm'
// 值工具：穷尽断言、无损 JSON 判定与 JsonValue 类型。
import { assertNever, isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

/** Scalar JSON values supported by `enum` and `const`. */
// enum 与 const 支持的标量 JSON 值。
export type JsonSchemaScalar = string | number | boolean | null

/** Single-type keywords accepted by the enforced subset. */
// 强制子集接受的单类型关键字。
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** Scalar-only schema types accepted by literal constraints. */
// 字面量约束接受的纯标量 schema 类型。
type JsonSchemaScalarType = Exclude<JsonSchemaType, 'object' | 'array'>

/**
 * One raw JSON Schema node in the enforced subset. The optional fields express
 * the external wire schema; {@link assertSupportedJsonSchema} rejects invalid
 * combinations before a caller treats the node as trusted.
 */
export interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  // 省略且无约束 = 接受任意 JSON 值；或改用 oneOf。
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  // 恰好一个分支须通过；至少两个分支。
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  // 嵌套属性 schema（仅 type: object）。
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  // 必填属性名；每个都必须出现在 properties 里。
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  // false 拒绝未声明键；缺省/true 遵循 JSON Schema 的开放默认。
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  // 元素 schema（仅 type: array）；缺省接受任意 JSON 元素。
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  // 标量节点的允许值表。
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  // 标量节点的唯一允许值。
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  // 注解：不参与校验。
  description?: string
  /** Annotation, ignored for validation. */
  // 注解：不参与校验。
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  // 注解：不参与校验，但必须是无损 JSON。
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  // 注解：不参与校验，但必须是无损 JSON。
  examples?: JsonValue
}

/** A consumer-constrained object-rooted schema. */
// 消费方约束的"对象根" schema。
export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

/**
 * Thrown when a raw schema falls outside the enforced subset. `violations`
 * lists every offending path instead of stopping at the first author error.
 */
// 原始 schema 超出强制子集时抛出。violations 列出所有违规路径，
// 而不是在第一个作者错误处停止。
export class JsonSchemaError extends HarnessError {
  /** Individual schema violations in walk order. */
  // 按遍历顺序排列的各条违规。
  readonly violations: string[]

  // 构造：聚合消息 + UNSUPPORTED_SCHEMA 错误码。
  constructor(violations: string[]) {
    super(`unsupported JSON schema: ${violations.join('; ')}`, 'UNSUPPORTED_SCHEMA')
    this.name = 'JsonSchemaError'
    this.violations = violations
  }
}

// 约束关键字集合（参与校验的八类）。
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
// 注解关键字集合（不参与校验，只要求无损 JSON）。
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
// 合法 schema 类型表。
const SCHEMA_TYPES: readonly JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/* jscpd:ignore-start -- this realm boundary mirrors the session-owned lossless-JSON intrinsic test */
// （跨 realm 原语校验段：与 session 包的无损 JSON 判定同源。）
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
// 判断某 realm 的内建原型是否由其原生构造器背书（防伪造原型）。
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  // 取原型的 constructor 描述符。
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  // 不是函数：伪造。
  if (typeof constructor !== 'function') return false
  try {
    // 名字、自反性与原生源码形式三项全查。
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
// 判断候选是否为某个 realm 的内建 Object.prototype。
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/**
 * Test for a realm-agnostic plain JSON record without accepting arrays or
 * exotic objects.
 * @param value - candidate record from any JavaScript realm.
 * @returns Whether the value has a plain-object prototype chain.
 */
export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  // 数组与非对象直接排除。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    // 原型必须是 null（Object.create(null)）或内建 Object.prototype。
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === null
      || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
  } catch {
    return false
  }
}

/** Whether an array uses one realm's intrinsic `Array.prototype`. */
// 判断数组是否使用某 realm 的内建 Array.prototype。
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  // 数组原型的原型必须是内建 Object.prototype。
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype)
}
/* jscpd:ignore-end */

/** Return whether a record contains only own enumerable string keys. */
// 记录是否只含自有可枚举字符串键（JSON 投影后键不丢）。
function hasOnlyEnumerableStringKeys(value: object): boolean {
  try {
    return Reflect.ownKeys(value)
      .every(key => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
  } catch {
    return false
  }
}

/**
 * Test for an ordinary schema record whose keys survive JSON projection.
 * @param value - candidate record from any JavaScript realm.
 * @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
 */
// 普通且键可 JSON 投影的 schema 记录。
export function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value)
}

/**
 * Test for a dense ordinary array with no JSON-invisible decorations.
 * @param value - candidate array from any JavaScript realm.
 * @returns Whether the array is intrinsic, dense, and undecorated.
 */
// 稠密、无 JSON 不可见装饰的普通数组。
export function isPlainJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    // 自有键数必须恰为 length+1（length 属性本身），且每个下标都有自有键。
    if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return false
    }
    return true
  } catch {
    return false
  }
}

/** Lossless finite JSON number, excluding negative zero. */
// 无损有限 JSON 数值（显式排除 -0）。
function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

/** Whether a scalar is valid for one declared schema type. */
// 标量是否匹配某个已声明的 schema 类型。
function scalarMatches(type: JsonSchemaScalarType, value: unknown): value is JsonSchemaScalar {
  switch (type) {
    // 字符串。
    case 'string': return typeof value === 'string'
    // 数值（有限非 -0）。
    case 'number': return isJsonNumber(value)
    // 整数（在数值基础上加整数判定）。
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    // 布尔。
    case 'boolean': return typeof value === 'boolean'
    // null。
    case 'null': return value === null
    /* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
    default: return assertNever(type, 'JsonSchemaType')
  }
}

/** Deferred work for the stack-safe raw-schema walk. */
// 栈安全 raw-schema 遍历的延迟任务：进入/离开/oneOf 收尾/对象收尾。
type SchemaWalkTask =
  | { kind: 'enter'; node: unknown; path: string }
  | { kind: 'leave'; node: object }
  | { kind: 'one-of-tail'; node: Record<string, unknown>; path: string }
  | { kind: 'object-tail'; node: Record<string, unknown>; path: string; properties: unknown }

/** Keywords that are invalid beside `oneOf`. */
// 与 oneOf 并列时非法的兄弟关键字。
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const

/** Validate object-only fields after its property schemas have been visited. */
// 在属性 schema 访问完之后校验对象专属字段（required 与 additionalProperties）。
function checkObjectSchemaTail(
  node: Record<string, unknown>,
  path: string,
  properties: unknown,
  violations: string[],
): void {
  // required 存在性检查。
  const hasRequired = Object.hasOwn(node, 'required')
  const required = hasRequired ? node.required : undefined
  if (hasRequired) {
    // 必须是字符串数组；每个名字都必须在 properties 中声明。
    if (!isPlainJsonArray(required) || required.some(entry => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of strings`)
    } else {
      const declared = isJsonSchemaRecord(properties) ? properties : {}
      for (const key of required as string[]) {
        if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
      }
    }
  }
  // additionalProperties 必须是布尔。
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
}

/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
// 收集一棵 raw schema 树的全部违规：不用 JS 调用栈（显式任务栈）。
function checkSchemaNode(root: unknown, rootPath: string, violations: string[], seen: Set<object>): void {
  // 根任务入栈。
  const tasks: SchemaWalkTask[] = [{ kind: 'enter', node: root, path: rootPath }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    // 离开：从循环检测集合中移除。
    if (task.kind === 'leave') {
      seen.delete(task.node)
      continue
    }
    // oneOf 收尾：检查兄弟关键字。
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`)
      }
      continue
    }
    // 对象收尾：校验 required/additionalProperties。
    if (task.kind === 'object-tail') {
      checkObjectSchemaTail(task.node, task.path, task.properties, violations)
      continue
    }

    const { node, path } = task
    // 每个节点必须是键可投影的普通记录。
    if (!isJsonSchemaRecord(node)) {
      violations.push(`${path} must be a schema object`)
      continue
    }
    // 循环引用：报错。
    if (seen.has(node)) {
      violations.push(`${path} is circular`)
      continue
    }
    // 登记访问中并安排离开任务。
    seen.add(node)
    tasks.push({ kind: 'leave', node })

    // 逐关键字分类。
    for (const key of Object.keys(node)) {
      // 约束关键字：留给下方类型分派。
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        // 注解必须是无损 JSON（getter 抛错也计入违规）。
        try {
          if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        } catch {
          violations.push(`${path}.${key} annotation must be lossless JSON data`)
        }
        continue
      }
      // 其余关键字：不在子集内，直接拒绝。
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
    // 注解的字符串类型检查。
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    // type 与 oneOf 的互斥/共存检查。
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      // 两者不可同时声明。
      violations.push(`${path} cannot declare both type and oneOf`)
      continue
    }
    if (!hasType && !hasOneOf) {
      // 都没有：只允许纯注解节点。
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      continue
    }

    if (hasOneOf) {
      // oneOf 分支：先排收尾任务再排分支（逆序压栈保持正序访问）。
      const oneOf = node.oneOf
      tasks.push({ kind: 'one-of-tail', node, path })
      if (!isPlainJsonArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (let index = oneOf.length - 1; index >= 0; index--) {
          tasks.push({ kind: 'enter', node: oneOf[index], path: `${path}.oneOf[${index}]` })
        }
      }
      continue
    }

    // type 必须是单类型字符串（数组形式明确拒绝）。
    const type = node.type
    if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly unknown[]).includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      continue
    }
    const schemaType = type as JsonSchemaType
    // 各约束关键字允许挂载的类型表。
    const allowedFor: Record<string, JsonSchemaType[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    // 错位的关键字：拒绝。
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(schemaType)) {
        violations.push(`${path}.${key} is not supported on type "${schemaType}"`)
      }
    }

    // 按类型分派深入遍历。
    switch (schemaType) {
      case 'object': {
        const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
        // 先排收尾任务（属性访问完后执行）。
        tasks.push({ kind: 'object-tail', node, path, properties })
        if (Object.hasOwn(node, 'properties')) {
          if (!isJsonSchemaRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            // 属性 schema 逆序入栈。
            const entries = Object.entries(properties)
            for (let index = entries.length - 1; index >= 0; index--) {
              const entry = entries[index]
              /* v8 ignore next -- the loop is bounded by the captured entry count. */
              if (entry === undefined) continue
              tasks.push({ kind: 'enter', node: entry[1], path: `${path}.properties.${entry[0]}` })
            }
          }
        }
        break
      }
      case 'array': {
        // items 子节点入栈。
        if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` })
        break
      }
      // 标量类型：校验 enum/const 的类型一致性。
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const hasEnum = Object.hasOwn(node, 'enum')
        const allowed = hasEnum ? node.enum : undefined
        // enum 必须是非空、稠密、类型全匹配的数组。
        const enumValid = isPlainJsonArray(allowed)
          && allowed.length > 0
          && allowed.every(entry => scalarMatches(schemaType, entry))
        if (hasEnum && !enumValid) {
          violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`)
        }
        const hasConst = Object.hasOwn(node, 'const')
        const declaredConst = hasConst ? node.const : undefined
        // const 必须匹配声明类型，且与 enum 同时声明时必须是 enum 成员。
        const constValid = scalarMatches(schemaType, declaredConst)
        if (hasConst) {
          if (!constValid) {
            violations.push(`${path}.const must be a ${schemaType} value`)
          } else if (enumValid && !allowed.includes(declaredConst)) {
            violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
          }
        }
        break
      }
      /* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
      default: assertNever(schemaType, 'JsonSchemaType')
    }
  }
}

/**
 * Assert that an arbitrary raw schema uses only the enforced subset.
 * Annotation-only schemas are accepted as the standard unconstrained-JSON
 * form; callers that require an object root use {@link assertObjectJsonSchema}.
 * @param schema - untrusted raw JSON Schema.
 * @returns Assertion that the schema belongs to the supported subset.
 */
export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  // 全树走一遍收集违规。
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  // 有违规：聚合抛出。
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/**
 * Assert the enforced subset plus the object-root constraint retained by
 * subagent and workflow structured outputs.
 * @param schema - untrusted caller-supplied schema.
 * @returns Assertion that the schema belongs to the supported subset and has an object root.
 */
// 强制子集 + 对象根约束（子代理与工作流结构化输出保留该约束）。
export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length === 0
    && (!isJsonSchemaRecord(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object')) {
    // 无子集违规但根不是对象：补一条违规。
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/** Safely test the lossless JSON boundary when a getter may throw. */
// getter 可能抛错时安全测试无损 JSON 边界。
function safelyIsJsonValue(value: unknown): boolean {
  try {
    return isJsonValue(value)
  } catch {
    return false
  }
}

/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
// 根感知的诊断路径：空路径显示为 arguments。
function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

/** Append one object property without a leading dot at an implicit root. */
// 在隐式根处追加对象属性（不带前导点）。
function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** One child evaluation deferred by a container or exact-one union frame. */
// 容器帧或"恰一"联合帧延迟求值的一个子项。
interface ValueChild {
  // 子节点的 schema。
  readonly node: JsonSchemaNode
  // 子值。
  readonly value: unknown
  // 诊断路径。
  readonly path: string
}

/** Explicit call frame for stack-safe schema-value validation. */
// 栈安全 schema 值校验的显式调用帧。
interface ValueFrame {
  // 本帧的 schema 节点。
  readonly node: JsonSchemaNode
  // 本帧的候选值。
  readonly value: unknown
  // 诊断路径。
  readonly path: string
  // 本帧是否承接子帧抛出的异常。
  catches: boolean
  // 阶段：start=本节点处理中，children=子项处理中。
  phase: 'start' | 'children'
  // 帧类别：联合/对象/数组。
  kind?: 'oneOf' | 'object' | 'array'
  // 待求值子项。
  children: ValueChild[]
  // 当前子项游标。
  childIndex: number
  // 子项违规聚合。
  violations: string[]
  // 收尾阶段违规（如额外属性）。
  tailViolations: string[]
  // oneOf 命中计数。
  matches: number
}

/** The generic exception-containment diagnostic owned by one valid schema node. */
// 由合法 schema 节点认领的通用"异常容住"诊断。
function losslessValueViolation(path: string): string[] {
  return [`"${diagnosticPath(path)}" must be a lossless JSON value`]
}

/** Append diagnostics without spreading a potentially wide child result as call arguments. */
// 追加诊断：不用展开语法，避免超宽子结果被当作调用实参。
function appendViolations(target: string[], source: readonly string[]): void {
  for (const violation of source) target.push(violation)
}

/** Initialize one validation frame with empty aggregation state. */
// 初始化一个校验帧（聚合状态全空）。
function valueFrame(node: JsonSchemaNode, value: unknown, path: string): ValueFrame {
  return {
    node,
    value,
    path,
    catches: false,
    phase: 'start',
    children: [],
    childIndex: 0,
    violations: [],
    tailViolations: [],
    matches: 0,
  }
}

/** Validate one scalar node after its primitive type check. */
// 在原始类型检查之后校验标量的 enum/const。
function checkScalarValue(node: JsonSchemaNode, value: unknown, path: string): string[] {
  // enum 成员检查。
  const allowed = Object.hasOwn(node, 'enum') ? node.enum : undefined
  if (allowed !== undefined && !allowed.includes(value as JsonSchemaScalar)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`]
  }
  // const 相等检查。
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
// 用显式帧（而非递归调用）校验一对已信任的 schema/值。
function checkValue(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  // 根帧入栈。
  const frames: ValueFrame[] = [valueFrame(schema, value, path)]
  // 根结果。
  let rootResult: string[] | undefined

  // 子结果接收：oneOf 帧计数空违规命中，其余帧聚合违规。
  const receive = (result: string[]): void => {
    const parent = frames.at(-1)
    if (parent === undefined) {
      rootResult = result
      return
    }
    if (parent.kind === 'oneOf') {
      if (result.length === 0) parent.matches++
    } else {
      appendViolations(parent.violations, result)
    }
  }
  // 完成：弹栈并接收结果。
  const finish = (result: string[]): void => {
    frames.pop()
    receive(result)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    try {
      if (frame.phase === 'children') {
        // 还有子项未处理：压入子帧。
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing schema-value child frame')
          frame.childIndex++
          frames.push(valueFrame(child.node, child.value, child.path))
          continue
        }
        if (frame.kind === 'oneOf') {
          // oneOf 收尾：恰好命中一个才算合法。
          finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`])
          continue
        }
        // 其余帧：并回收尾违规。
        appendViolations(frame.violations, frame.tailViolations)
        if (frame.violations.length > 0) {
          // 有违规：直接完成。
          finish(frame.violations)
        } else if (frame.kind === 'object') {
          // 对象收尾：整体还必须是无损 JSON。
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`])
        } else {
          // 数组收尾：整体必须是无损 JSON（稠密性已由子项路径保证）。
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`])
        }
        continue
      }

      // 读取声明类型。
      const nodeType = Object.hasOwn(frame.node, 'type') ? frame.node.type : undefined
      // 异常承接标记：非法类型节点不承接（异常原样上抛）。
      frame.catches = !(nodeType !== undefined && !(SCHEMA_TYPES as readonly unknown[]).includes(nodeType))
      // oneOf 帧准备。
      const oneOf = Object.hasOwn(frame.node, 'oneOf') ? frame.node.oneOf : undefined
      if (oneOf !== undefined) {
        frame.kind = 'oneOf'
        // 每个分支都以同一值求值。
        frame.children = Array.from(oneOf, branch => ({ node: branch, value: frame.value, path: frame.path }))
        frame.childIndex = 0
        frame.matches = 0
        frame.phase = 'children'
        continue
      }
      if (nodeType === undefined) {
        // 无类型：任意无损 JSON 值。
        finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path))
        continue
      }

      // 按类型分派。
      switch (nodeType) {
        case 'object': {
          // 值必须是普通 JSON 记录。
          if (!isPlainJsonRecord(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an object`])
            break
          }
          // 属性表与必填列表。
          const properties = Object.hasOwn(frame.node, 'properties') ? frame.node.properties ?? {} : {}
          const violations: string[] = []
          const required = Object.hasOwn(frame.node, 'required') ? frame.node.required ?? [] : []
          // 必填属性检查（undefined 视同缺失）。
          for (const key of required) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) {
              violations.push(`missing required property "${propertyPath(frame.path, key)}"`)
            }
          }
          // 在场的已声明属性进入子项求值。
          const children: ValueChild[] = []
          for (const [key, child] of Object.entries(properties)) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) continue
            children.push({ node: child, value: frame.value[key], path: propertyPath(frame.path, key) })
          }
          // additionalProperties: false 的额外键检查（收尾执行）。
          const tailViolations: string[] = []
          if (Object.hasOwn(frame.node, 'additionalProperties') && frame.node.additionalProperties === false) {
            for (const key of Object.keys(frame.value)) {
              if (!Object.hasOwn(properties, key)) {
                tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`)
              }
            }
          }
          // 装帧。
          frame.kind = 'object'
          frame.children = children
          frame.childIndex = 0
          frame.violations = violations
          frame.tailViolations = tailViolations
          frame.phase = 'children'
          break
        }
        case 'array': {
          // 值必须是数组。
          if (!Array.isArray(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an array`])
            break
          }
          // 每个元素进子项求值（无 items 则不深入）。
          const items = Object.hasOwn(frame.node, 'items') ? frame.node.items : undefined
          const children = items === undefined
            ? []
            : frame.value.flatMap((entry, index): ValueChild[] => [{ node: items, value: entry, path: `${frame.path}[${index}]` }])
          frame.kind = 'array'
          frame.children = children
          frame.childIndex = 0
          frame.violations = []
          frame.phase = 'children'
          break
        }
        // 标量类型：先类型后字面量约束。
        case 'string':
          finish(typeof frame.value === 'string'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a string`])
          break
        case 'number':
          finish(typeof frame.value !== 'number'
            ? [`"${diagnosticPath(frame.path)}" must be a number`]
            : !isJsonNumber(frame.value)
              ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`]
              : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'integer':
          finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value)
            ? [`"${diagnosticPath(frame.path)}" must be an integer`]
            : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'boolean':
          finish(typeof frame.value === 'boolean'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a boolean`])
          break
        case 'null':
          finish(frame.value === null
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be null`])
          break
        default:
          finish(assertNever(nodeType, 'JsonSchemaType'))
      }
    } catch (error) {
      // 异常容住：沿栈上弹直到第一个声明承接的帧。
      let failed = frames.pop()
      while (failed !== undefined && !failed.catches) failed = frames.pop()
      if (failed === undefined) throw error
      // 由承接帧给出通用诊断（getter 抛错也归入无损 JSON 违规）。
      receive(losslessValueViolation(failed.path))
    }
  }

  /* v8 ignore next -- every root frame finishes or throws. */
  // 根帧必然完成或抛出；?? 仅为类型系统存在。
  return rootResult ?? losslessValueViolation(path)
}

/**
 * Validate a candidate value against an asserted raw schema. The function is
 * total for arbitrary values and returns path-qualified violations.
 * @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
 * @param value - the candidate JSON value.
 * @param path - root label used in diagnostics.
 * @returns All violations in walk order; empty means valid.
 */
export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = 'value'): string[] {
  // 委托显式帧校验器。
  return checkValue(schema, value, path)
}
