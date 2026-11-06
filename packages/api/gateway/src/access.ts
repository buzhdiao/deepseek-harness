/**
 * Resource resolution for non-owner access decisions: the resources one call
 * or one forwarded event touches, read from Typert-validated arguments before
 * any lookup or Context resolves them.
 * @module @deepseek-ai/dsh-api-gateway/src/access
 */
// 面向非所有者访问决策的资源解析（详见上方英文说明）：在任何查找或 Context 解析
// 之前，从 Typert 校验过的参数中读取一次调用或一次转发事件所触及的资源。

import type {
  InvocationDescriptor,
  RemoteAccessResource,
  TypertRegistryContract,
  TypertResourceReader,
} from '@deepseek-ai/dsh-typert-protocol'
// 导入 Typert 协议类型：调用描述符、远程访问资源、注册契约与资源读取器。

// 全局资源的单例数组（内外均冻结，防止被修改）。
const GLOBAL: readonly RemoteAccessResource[] = Object.freeze([Object.freeze({ kind: 'global' })])

/** Resource ids one source produced for a kind, or `invalid` for a malformed value. */
// 一个来源为某种类产出的资源 id 列表；值畸形时为 'invalid'。
type ResourceIds = readonly unknown[] | 'invalid'

/**
 * Resolve the resources one call touches. For each resource kind, a
 * `resources` reader of the method wins; otherwise every lookup parameter
 * whose provider declares the kind contributes its wire resource id, and so
 * does the Context identity of a Context method whose Host adapter declares
 * the kind; otherwise the kind's registered default resolver receives named
 * wire values and ordered parameter descriptions. A default field instead
 * reads a top-level argument or, failing that, the first object argument.
 * @param typert - registry holding default fields or resolvers, lookup providers, and Host Context adapters.
 * @param readers - the method's `resources` readers, or `undefined` when it declares none.
 * @param descriptor - receiver, parameter order, lookups, and cancellation slot of the method.
 * @param args - named arguments matched to the descriptor's field set: JSON
 *   arguments as their Typert codecs validated them, lookup and Context
 *   identities as wire values.
 * @param signal - value placed in the cancellation slot of the positional arguments.
 * @returns the touched resources, the global resource alone when none;
 *   `undefined` when the resources are invalid: a reader or resolver throws,
 *   a reader returns an empty list, a default field or resolver holds an
 *   array, or a resource id is not a non-empty string.
 */
// 解析一次调用触及的资源（详见上方英文说明）。
export function callResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups' | 'resources'>,
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  descriptor: Pick<InvocationDescriptor, 'cancellation' | 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): readonly RemoteAccessResource[] | undefined {
  // Each later source replaces an earlier one for its kind and keeps the kind's position.
  // 后登记的来源覆盖同一种类先登记的来源，但保持该种类首次出现的位置。
  const sources = new Map<string, () => ResourceIds>()
  // 按描述符顺序构造位置参数：具名参数按 wire 名取值，末尾按需追加取消槽位的信号。
  const positionalArgs: readonly unknown[] = [
    ...descriptor.parameters.map(parameter => args[parameter.wire]),
    ...descriptor.cancellation === undefined ? [] : [signal],
  ]
  // 来源一：注册表中的默认字段/解析器声明。
  for (const declaration of typert.resources.entries()) {
    sources.set(declaration.kind, () => {
      let id: unknown
      if (declaration.resolve !== undefined) {
        // 优先使用注册的自定义解析器。
        const resolve = declaration.resolve
        try {
          id = resolve({ args, parameters: descriptor.parameters })
        } catch {
          // A resolver failure cannot identify an authorized resource.
          // 解析器失败即无法标识被授权的资源，判为 invalid。
          return 'invalid'
        }
      } else {
        // 否则按默认字段读取。
        id = defaultFieldId(descriptor, args, declaration.field)
      }
      // 数组即 invalid；undefined 表示无资源；其余包装为单元素列表。
      return Array.isArray(id) ? 'invalid' : id === undefined ? [] : [id]
    })
  }
  // 来源二：查找参数与 Context 身份贡献的资源 id。
  for (const [kind, ids] of lookupResources(typert, descriptor, args)) {
    sources.set(kind, () => ids)
  }
  // 来源三：方法声明的 `resources` 读取器（优先级最高）。
  for (const [kind, reader] of Object.entries(readers ?? {})) {
    sources.set(kind, () => read(() => reader(...positionalArgs), []))
  }
  // 依次收集各来源的资源；任何一个畸形即整体返回 undefined。
  const resources: RemoteAccessResource[] = []
  for (const [kind, ids] of sources) {
    if (!collect(resources, kind, ids())) return undefined
  }
  // 没有触及任何资源时仅返回全局资源。
  return resources.length === 0 ? GLOBAL : resources
}

/**
 * Resolve the resources one forwarded event notification touches. An event
 * carries every resource it declares, so a reader returning `undefined`
 * makes the notification invalid instead of a global one.
 * @param readers - the event entry's declared readers, or `undefined` when it declares none.
 * @param args - the event's validated JSON arguments, passed to each reader as its positional arguments.
 * @returns the global resource alone without readers, including an empty
 *   reader set; otherwise the touched resources; `undefined` when the
 *   resources are invalid: a resource id is missing or malformed.
 */
// 解析一次转发事件通知触及的资源（详见上方英文说明）。
export function eventResources(
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  args: readonly unknown[],
): readonly RemoteAccessResource[] | undefined {
  // 事件声明读取器的有序列表。
  const declared = Object.entries(readers ?? {})
  // 无读取器（含声明为空集）时仅返回全局资源。
  if (declared.length === 0) return GLOBAL
  const resources: RemoteAccessResource[] = []
  // 逐个读取器收集；读取器返回 undefined 即缺资源，整体判 invalid。
  for (const [kind, reader] of declared) {
    if (!collect(resources, kind, read(() => reader(...args), 'invalid'))) return undefined
  }
  return resources
}

/**
 * The resource ids lookup parameters and the Context identity name, per
 * resource kind: the Context identity first, then lookup parameters in order.
 * An optional lookup parameter the call omits names no resource id; the
 * Context identity is required.
 */
// 按种类汇总查找参数与 Context 身份命名的资源 id（详见上方英文说明）：
// Context 身份在前，查找参数按参数顺序在后。
function lookupResources(
  typert: Pick<TypertRegistryContract, 'contexts' | 'lookups'>,
  descriptor: Pick<InvocationDescriptor, 'invocation' | 'parameters'>,
  args: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown[]> {
  // 种类 -> 资源 id 列表。
  const ids = new Map<string, unknown[]>()
  // 向某种类追加一个资源 id。
  const add = (kind: string, id: unknown): void => {
    const list = ids.get(kind)
    if (list === undefined) ids.set(kind, [id])
    else list.push(id)
  }
  // 方法接收者。
  const receiver = descriptor.invocation
  if (receiver.kind === 'context') {
    // Context 方法：宿主适配器声明的资源种类收到 Context 身份参数。
    const kind = typert.contexts.getHost(receiver.context)?.resource
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined) add(kind, args[receiver.wire])
  }
  // 遍历参数：声明了 lookup 的参数按其种类贡献 wire 资源 id。
  for (const parameter of descriptor.parameters) {
    // 调用省略的可选查找参数不命名任何资源 id。
    if (parameter.lookup === undefined) continue
    const kind = typert.lookups.get(parameter.lookup)?.resource
    const id = args[parameter.wire]
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- domain packages merge resource kinds into TypertResourceMap.
    if (kind !== undefined && id !== undefined) add(kind, id)
  }
  return ids
}

/** Read resource identities: `undefined` yields `absent`, a list names several and must not be empty. */
// 读取资源身份：undefined 产出调用方给的缺省值；列表命名多个资源且不得为空。
function read(reader: () => unknown, absent: ResourceIds): ResourceIds {
  let value: unknown
  try {
    // 执行读取器。
    value = reader()
  } catch {
    // Any reader error means it cannot name its resources, so they are invalid.
    // 读取器抛错意味着它无法命名自己的资源，判为 invalid。
    return 'invalid'
  }
  // undefined 返回调用方指定的缺省值。
  if (value === undefined) return absent
  // 非数组值包装为单元素列表。
  if (!Array.isArray(value)) return [value]
  // 空列表非法。
  return value.length === 0 ? 'invalid' : value
}

/** Append one kind's resource ids; false when any is malformed. */
// 追加一个种类的资源 id；任一畸形返回 false。
function collect(resources: RemoteAccessResource[], kind: string, ids: ResourceIds): boolean {
  // 来源已判 invalid 直接失败。
  if (ids === 'invalid') return false
  for (const id of ids) {
    // 资源 id 必须是非空字符串。
    if (typeof id !== 'string' || id.length === 0) return false
    // Kinds come from registrations, lookups, Context adapters, and reader keys, all typed by the merged resource map.
    // 种类来自注册、查找、Context 适配器与读取器键，均由合并的资源映射约束类型。
    resources.push({ kind, id } as RemoteAccessResource)
  }
  return true
}

/** The default field: a top-level argument, else that field of the first object argument. */
// 默认字段：优先读取同名的顶层参数，否则读取第一个对象参数的同名字段。
function defaultFieldId(
  descriptor: Pick<InvocationDescriptor, 'parameters'>,
  args: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  // 参数集中存在同名字段的顶层参数则直接取值。
  if (descriptor.parameters.some(parameter => parameter.wire === field)) return args[field]
  // 依次查找第一个对象参数。
  for (const parameter of descriptor.parameters) {
    const value = args[parameter.wire]
    // 跳过非对象参数（含数组与 null）。
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    // 第一个对象参数缺少该字段时判定为无资源。
    if (!Object.hasOwn(value, field)) return undefined
    // 读取该字段的值。
    const id: unknown = Reflect.get(value, field)
    return id
  }
  return undefined
}
