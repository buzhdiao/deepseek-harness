/** Runtime plugin trees shared by Agents selecting one preset revision. */
// 【中文逐行注释 · DSH 核心包 6：preset/agent-preset-registry/mount.ts —— 预设挂载】
// 本文件负责把一个 preset 声明的插件行列表真正装载成一棵运行时插件子树
//（Loader EntryTree），并提供三件事：泄漏审计（leakedServices）、按修订读服务
//（serviceForMount）、行级诊断（auditRows）。
// 关键设计：preset 的服务必须活在自己的 isolate realm 里——泄漏到全局 root
// 作用域的行会被挂载直接拒绝（fail loud），这是「给一个 agent 换能力集而不
// 污染其他 agent」的守门规则。
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { EntryTree, type EntryChange, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { prepareProfileEntries } from '@deepseek-ai/dsh-app-boot'
import type { PresetDefinition } from './definition.ts'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'

/** In-memory Loader tree; only the profile configuration editor persists definitions. */
// PresetTree：内存中的 Loader 树（上游注释：只有 profile 配置编辑器持久化定义，
// preset 树的 commit 是空操作——不落盘）。构造时把「属主 entry 的 subtree/subgroup
// 标记」原样带回自身（让树知道自己是某个 entry 的子树/子组载体）。
class PresetTree extends EntryTree {
  constructor(ctx: Context) {
    const owner = ctx.fiber.entry
    const subtree = owner?.subtree
    const subgroup = owner?.subgroup
    super(ctx)
    if (owner !== undefined) {
      if (subtree === undefined) delete owner.subtree
      else owner.subtree = subtree
      if (subgroup === undefined) delete owner.subgroup
      else owner.subgroup = subgroup
    }
  }

  // commit：空实现——preset 树不持久化任何变更。
  override commit(_change: EntryChange): void {}
}

/** One live revision shared by Agents and scoped readers. */
// PresetMount：一个被多个 agent 与作用域读者共享的活修订。
export interface PresetMount {
  /** The preset the subtree was composed from. */
  // 子树组装自的预设 id。
  readonly presetId: string
  /** The mounted subtree's fiber. */
  // 挂载子树的 fiber（生命周期宿主）。
  readonly fiber: Fiber
  /** Loader entry tree whose active rows form this standing composition. */
  // Loader 条目树——活跃行构成这份常驻组合。
  readonly tree: EntryTree
  /** The standing scope key agents are parented to (undefined only in torn-down records). */
  // agent 挂靠的常驻作用域键（仅拆除记录中为 undefined）。
  readonly key: ScopeKey | undefined
}

/**
 * Whether `fiber` is `root` itself or is mounted anywhere inside its subtree.
 *
 * Membership is object identity. `uid` looks like a cheaper key but is a
 * per-registry counter, so fibers in two different roots collide on it and a
 * subtree in one runtime would be blamed for a service published in another.
 * @param fiber - the fiber to locate.
 * @param root - the subtree root to test membership against.
 * @returns true when `fiber` belongs to `root`'s subtree.
 */
// withinFiber（上游注释）：fiber 是否属于 root 子树——沿父链走对象身份比较。
// 用 uid 会出错：它是每注册表计数器，两个根下的 fiber 可能撞号。
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * Service names the mounted subtree published into the root realm.
 *
 * A provider without an `isolate` realm stores its implementation under the
 * root's symbol for that name, which is exactly the comparison below; a
 * provider inside an `isolate` realm stores under a realm-private symbol and
 * is correctly absent here.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the mounted subtree's fiber.
 * @returns the leaked service names in lexical order.
 */
// leakedServices（上游注释）：子树泄漏进 root realm 的服务名——
// 未声明 isolate 的 provider 其实现存在 root 的同名 symbol 下（即下方比较）；
// isolate realm 内的 provider 存在 realm 私有 symbol 下，正确地不出现。
export function leakedServices(ctx: Context, mount: Fiber): string[] {
  const store = ctx.reflect.store
  // root 的隔离表（服务名 → root symbol）。
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than
       clearing it, so an own symbol always resolves; the guard exists only
       because the store's index signature is optional. */
    // 上游注释：cordis 卸载时删除槽位而非置空，自有 symbol 必能解析；
    // 守卫只因索引签名为可选而存在。
    if (impl === undefined) continue
    // 实现的提供方不在本子树内：不关我们的事。
    if (!withinFiber(impl.ctx.fiber, mount)) continue
    // 提供方在子树内、却注册在 root symbol 下 → 泄漏。
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

/**
 * Read a service implementation owned by one retained preset, including isolated realms.
 *
 * Ownership is the same relation {@link leakedServices} reads, inverted: there
 * it names implementations a subtree published into the ROOT realm, here it
 * names the one this subtree published anywhere. Fiber membership is object
 * identity for the reason stated on {@link withinFiber}.
 *
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the retained revision whose subtree owns the service.
 * @param name - the service name as the preset's rows resolve it.
 * @returns the implementation, or undefined when the mount provides none.
 */
// serviceForMount（上游注释）：读某个保留修订（含 isolate realm）拥有的服务——
// 与 leakedServices 是同一所有权关系的反向用法。跨插件引用 preset 内服务的
// 唯一合法通道。
export function serviceForMount<K extends string & keyof Context>(
  ctx: Context,
  mount: PresetMount,
  name: K,
): Context[K] | undefined {
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
    if (impl === undefined) continue
    // 名字匹配且实现由本修订子树提供 → 返回。
    if (impl.name !== name) continue
    if (withinFiber(impl.ctx.fiber, mount.fiber)) return impl.value as Context[K]
  }
  return undefined
}

/** Rows that did not reach a usable state, each rendered as one diagnostic line. */
// RowAudit：未达到可用状态的行（每行一条诊断）。
export interface RowAudit {
  /** Rows that never started or whose import or activation rejected. */
  // failed：从未启动、导入或激活被拒的行。
  readonly failed: string[]
  /**
   * Rows waiting for a service the composition does not supply. A Host
   * provider still activating completes such a row later; only a settled Host
   * tree tells that case from a genuinely missing service.
   */
  // pending（上游注释）：等待组合未供给服务的行——Host provider 仍在激活时
  // 会稍后补齐；只有 Host 树稳定后才能区分这两种情况。
  readonly pending: string[]
}

/**
 * Audit the rows of a mounted subtree.
 *
 * Wait for the subtree, then report import failures, activation failures, and
 * rows waiting for services the composition does not supply.
 * @param tree - the mounted subtree.
 * @returns failed and pending rows, both empty when every enabled row is usable.
 */
// auditRows（上游注释）：审计挂载子树的行——等树稳定后报告导入失败、
// 激活失败与等待服务的行。
export async function auditRows(tree: EntryTree): Promise<RowAudit> {
  await tree.await()
  const failed: string[] = []
  const pending: string[] = []
  for (const entry of tree.entries()) {
    // 禁用行不审计（有意停用不是失败）。
    if (entry.disabled) continue
    const fiber = entry.fiber
    if (fiber === undefined) {
      failed.push(`${entry.options.id} (${entry.options.name}): never started`)
      continue
    }
    try {
      // 等 fiber 落定：抛错即激活失败。
      await fiber.await()
    } catch (error) {
      const detail = mountDetail(error)
      failed.push(`${entry.options.id} (${entry.options.name}): ${detail}`)
      continue
    }
    // inject 声明的服务至今仍缺 → pending（等待依赖）。
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    if (missing.length > 0) {
      pending.push(`${entry.options.id} (${entry.options.name}): waiting for ${missing.join(', ')}`)
    }
  }
  return { failed, pending }
}

/**
 * The causes of `error` whose detail its own message does not already carry.
 *
 * Aggregate errors carry separate member messages. A wrapper can preserve the
 * aggregate as its cause without including those messages in its own text.
 * @param error - the failure to read branches from.
 * @returns the branches to render beneath `error.message`, possibly empty.
 */
// detailBranches（上游注释）：错误里「自身消息未携带」的原因分支——
// AggregateError 自带成员消息；包装器可能把聚合错误藏在 cause 里。
function detailBranches(error: Error): readonly unknown[] {
  if (error instanceof AggregateError) return error.errors
  return error.cause instanceof AggregateError ? error.cause.errors : []
}

/**
 * The reportable text of a mount failure.
 *
 * A plugin may reject with an aggregate or wrap one as its cause. Include its
 * member messages beneath the row diagnostic so each failure is visible.
 * @param error - the value the mount rejected with.
 * @returns a single-line-per-cause description.
 */
// mountDetail（上游注释）：挂载失败的可报告文本——聚合/包装错误的每个成员
// 消息都要可见（递归渲染，逐级缩进）。
function mountDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const branches = detailBranches(error)
  if (branches.length === 0) return error.message
  return [
    error.message,
    ...branches.map(branch => `- ${mountDetail(branch).replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

/** Load and audit one revision under its registry-owned scope.
 *
 * Failed rows and root-realm service leaks reject the mount. Rows waiting for
 * a Host service stay mounted: they activate by themselves once the provider
 * finishes, and the registry re-audits them after the Host tree settles.
 * Inside a profile, compatibility policy decides admission first: a row whose
 * plugin the profile denies mounts disabled, so the audit reads it as
 * intentionally inactive instead of reporting a failed import.
 * @param ctx Scope context inheriting the declaring Loader's resolution base.
 * @param id Preset identity.
 * @param plugins Declared Cordis entry list.
 * @returns The live tree; scope disposal owns its teardown.
 */
// mountPreset（上游注释）：在注册表拥有的作用域下装载并审计一个修订（上游注释详尽）——
// 失败行与 root 泄漏直接拒绝挂载；等待 Host 服务的行保持挂载（稍后自激活）；
// profile 兼容策略先决定准入（被 profile 拒绝的行以禁用状态挂载，不算导入失败）。
export async function mountPreset(ctx: Context, id: string, plugins: PresetDefinition['plugins']): Promise<PresetMount> {
  // 必须在作用域内挂载（无 scope 无法做修订隔离）。
  if (scopeOf(ctx) === undefined) throw new Error('agent-preset: mounting requires a scope')
  // 等宿主 fiber 落定（确保注册环境就绪）。
  await ctx.fiber.await()
  // 建内存树。
  const tree = new PresetTree(ctx)
  // 树的停止注册为作用域 effect：作用域销毁时整树停止（teardown 归属清晰）。
  ctx.effect(() => () =>{  tree.root.stop() }, 'agent-preset.tree')
  // 用 profile 条目准备器处理插件行（兼容策略在此准入）并应用更新（触发装载）。
  await tree.root.update(prepareProfileEntries(ctx, plugins as EntryOptions[], ctx.baseUrl))
  // 审计行状态。
  const audit = await auditRows(tree)
  // 泄漏审计：查 root realm 中本子树发布的服务。
  const leaked = leakedServices(ctx, ctx.fiber)
  // 失败行 → 拒绝挂载（fail loud）。
  if (audit.failed.length > 0) throw new Error(audit.failed.join('\n'))
  // 服务泄漏 → 拒绝挂载并点名（isolate realm 是硬性要求）。
  if (leaked.length > 0) throw new Error(`Preset services require isolate realms: ${leaked.join(', ')}`)
  // 全部通过：返回挂载记录。
  const mount = { presetId: id, fiber: ctx.fiber, tree, key: scopeOf(ctx) }
  return mount
}
