/**
 * Client projection of generated Typert Remote descriptors. Contributions
 * install traced `remote.<namespace>` services; no JavaScript Proxy
 * participates in method lookup, invocation, or type exposure.
 */

// 本文件是生成的 Typert Remote 描述符在客户端一侧的投影（client projection）：
// 贡献包安装可追踪的 remote.<namespace> 服务；方法查找、调用与类型暴露全程不使用 JS Proxy。

// 引入 Cordis Service 基类：命名空间服务与 Remote 服务都继承自它。
import { Service } from '@deepseek-ai/cordis'
// 引入 Typert 协议的运行时工具：远程错误类、上行条目守卫、错误识别。
import { RemoteError, isRemoteUplinkItem, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// 转发导出网关故障详情类型（仅类型）。
export type { TypertGatewayFaultDetails } from '../remote-error-codes.ts'
// 仅类型导入：Cordis 上下文。
import type { Context } from '@deepseek-ai/cordis'
// 仅类型导入：连接句柄（现有 Connection 载体）。
import type {
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
// 仅类型导入：Typert 客户端协议的各类声明/结果/流句柄类型。
import type {
  InvocationDescriptor,
  TypertClientEventListener,
  TypertClientRemote,
  RemoteFailure,
  RemoteResult,
  RemoteStreamHandle,
  TypertCodec,
  TypertDisposer,
  TypertRemoteContribution,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
// 引入流复用客户端的运行时部分：上行队列、承载错误、复用客户端。
import {
  ClientUplinkQueue,
  RemoteStreamCarrierError,
  RemoteStreamMuxClient,
} from './stream-client.ts'
// 引入转发事件的客户端属主。
import { ClientRemoteEvents } from './remote-events.ts'
// 引入重连流的运行时类与选项类型。
import {
  RemoteStream,
  type RemoteStreamOptions,
} from './remote-stream.ts'

// 对外统一出口：流复用客户端的承载错误。
export { RemoteStreamCarrierError } from './stream-client.ts'
// 对外统一出口：日志流类。
export { RemoteJournalStream } from './journal-stream.ts'
// 对外统一出口：日志流的帧/变更/选项/工厂类型。
export type {
  RemoteJournalChange,
  RemoteJournalFrame,
  RemoteJournalStreamOptions,
  RemoteStreamFactory,
} from './journal-stream.ts'
// 对外统一出口：重连流类。
export { RemoteStream } from './remote-stream.ts'
// 对外统一出口：重连流条目与选项类型。
export type { RemoteStreamItem, RemoteStreamOptions } from './remote-stream.ts'
// 对外统一出口：快照流类。
export { RemoteSnapshotStream } from './snapshot-stream.ts'
// 对外统一出口：快照流选项类型。
export type { RemoteSnapshotStreamOptions } from './snapshot-stream.ts'

// 挂载令牌：一个已安装方法变体的活跃标志 + 独立取消控制器（卸载时中止进行中的调用）。
interface MountToken {
  active: boolean
  readonly abort: AbortController
}

// 作用域（scoped）投影：把哪个上下文身份写到哪个线上参数（含它在参数表中的下标）。
interface ScopedProjection {
  readonly context: string
  readonly wire: string
  readonly parameterIndex?: number
}

// 直接（direct）方法变体：描述符 + 挂载令牌。
interface DirectMethod {
  readonly descriptor: InvocationDescriptor
  readonly token: MountToken
}

// 作用域方法变体：在直接变体之上多一份投影信息。
interface ScopedMethod extends DirectMethod {
  readonly projection: ScopedProjection
}

// 同名方法的记录：可同时持有 direct 与 scoped 两个变体。
interface RemoteMethodRecord {
  direct?: DirectMethod
  scoped?: ScopedMethod
}

// 已解析的上下文身份包装（避免与 undefined 身份混淆）。
interface BoundContextIdentity {
  readonly value: unknown
}

// 准备就绪的一次调用：端点、线上参数与合成取消信号。
interface PreparedClientInvocation {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

// 已安装命名空间的句柄：命名空间服务 + 其插件 fiber 的 dispose。
interface RemoteNamespaceHandle {
  readonly service: RemoteNamespaceService
  readonly dispose: TypertDisposer
}

// 对 loader 服务就绪等待的最小类型面（可不存在）。
interface LoaderReadiness {
  await(): Promise<unknown>
}

// 组卸载用的记录：一个描述符的挂载状态（哪些变体已装上、令牌是否仍活跃）。
/** One descriptor's mounted variants, for the group disposer to unwind. */
interface InstalledMethod {
  readonly descriptor: InvocationDescriptor
  readonly token: MountToken
  direct: boolean
  scoped: boolean
}

// 类型化 Remote 服务外观：在生成的命名空间之上，补充 $stream（交互式流）与 $host（固定宿主事实）。
/** Typed Remote service augmented by generated direct namespaces and Gateway stream supervision. */
export interface ClientRemote extends TypertClientRemote {
  /**
   * Create an independently cancellable, reconnecting logical stream.
   * Requires interactions=answer; passive Clients use generated stream methods.
   * @param options - domain-owned opener and generation-end classification.
   * @returns a single-consumer stream annotated with physical generation ids.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
  /**
   * Fixed Host facts as plain reads: no store, no subscription, no generation
   * counter. `home` stays undefined until the first ready frame and reflects
   * the latest one afterwards.
   */
  readonly $host: RemoteHostFacts
}

// 暴露在 ctx.remote.$host 上的固定宿主事实。
/** The fixed Host facts exposed on `ctx.remote.$host`. */
export interface RemoteHostFacts {
  /** Host home directory from the ready frame, undefined before it. */
  readonly home: string | undefined
  /** Whether the carrier connects to the local Host. */
  readonly isLoopback: boolean
}

// 模块扩充：给 Cordis Context 增加 remote 属性的类型。
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by the Client assembly. */
    remote: ClientRemote
  }
}

// 声明依赖：Typert 注册表与现有连接（Connection）载体。
/** Required Client services: the Typert registry and the existing Connection carrier. */
export const inject = ['typert', 'connection']

/**
 * Install the typed Client Remote service.
 * @param ctx - Client Cordis root.
 */
export function apply(ctx: Context): void {
  // 安装即构造服务实例（构造函数内完成全部接线）。
  new ClientRemoteService(ctx)
}

// 客户端 Remote 服务本体：挂载生成的命名空间、转发事件、宿主事实与流监督。
class ClientRemoteService extends Service implements ClientRemote {
  // 客户端网关根上下文。
  private readonly ownerCtx: Context
  // 连接载体句柄。
  private readonly connection: ConnectionHandle
  // 已安装的命名空间：名字 -> 服务句柄。
  private readonly namespaces = new Map<string, RemoteNamespaceHandle>()
  // 缓存的宿主事实（引用稳定，见 $host）。
  private hostFacts: RemoteHostFacts | undefined
  // 物理流复用客户端（复用一条 WebSocket 承载多条逻辑流）。
  private readonly streams: RemoteStreamMuxClient
  // 转发事件属主（仅 interactions=answer 时创建）。
  private readonly events: ClientRemoteEvents | undefined
  // 串行化 $mount 卸载/挂载的变更队列。
  private mutations = Promise.resolve()

  constructor(ctx: Context) {
    // 以 'remote' 为名注册为 Cordis 服务。
    super(ctx, 'remote')
    // 记录根上下文。
    this.ownerCtx = ctx
    // 取出连接载体。
    const connection = ctx.get('connection') as ConnectionHandle
    // 记录连接句柄。
    this.connection = connection
    // 构造流复用客户端：物理套接字经连接开启；应答型客户端等待重连。
    this.streams = new RemoteStreamMuxClient(
      path => connection.openWebSocket(path),
      connection.interactions === 'answer',
    )
    // 应答型交互：创建转发事件属主（进程内优先，经 openRemoteStream 选择载体）。
    if (connection.interactions === 'answer') {
      this.events = new ClientRemoteEvents(
        ctx,
        connection,
        (endpoint, payload, signal) => this.openRemoteStream(endpoint, payload, signal),
      )
    }
    // API callers retain a lifecycle socket even when they do not receive events.
    // HTTP dispatch never waits for this independent connection attempt.
    // 无进程内 RPC 通道时，立刻启动独立的流套接字尝试（不等 HTTP 分发）。
    if (connection.rpc.open === undefined) this.streams.start()
    // 生命周期循环停止标志。
    let disposed = false
    // 连接生命周期循环句柄。
    let loop: ReturnType<ConnectionHandle['start']> | undefined
    // 启动连接循环：连接建立时广播 reset；请求重连时跟进流套接字。
    const start = (): void => {
      // 已停止或不允许交互：不启动。
      if (disposed || connection.interactions === 'none') return
      // 无进程内通道：确保流套接字尝试存在。
      if (connection.rpc.open === undefined) this.streams.start()
      // 启动连接循环并记录句柄。
      loop = connection.start({
        onConnected: () => { this.ownerCtx.emit('connection/reset') },
        onReconnectRequested: () => {
          if (connection.rpc.open === undefined) this.streams.reconnect()
        },
      })
    }
    // 若存在 loader（延迟装配），等其就绪后再启动；loader 失败则静默放弃。
    const loader = ctx.get('loader') as LoaderReadiness | undefined
    if (loader === undefined) start()
    else void loader.await().then(start, () => {})
    // 注册清理副作用：停止循环、释放事件属主与流复用客户端。
    ctx.effect(() => async () => {
      // 标记已停止：阻止 start 再次启动循环。
      disposed = true
      // 停止连接生命周期循环。
      loop?.stop()
      // 释放转发事件属主（等待监听工作静默）。
      await this.events?.dispose()
      // 永久关闭流复用客户端（关闭物理套接字并失败所有逻辑流）。
      await this.streams.close()
    }, 'api-gateway.client.transport')
  }

  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    // 被动客户端不支持交互式流：要求 interactions=answer。
    if (this.connection.interactions === 'none') {
      throw new Error('client api: $stream requires interactions=answer; use a generated stream method')
    }
    // 创建一个独立可取消、可重连的逻辑流。
    return new RemoteStream(this.connection, options)
  }

  get $host(): RemoteHostFacts {
    // Identity-stable: readers (useSyncExternalStore snapshots, memo inputs)
    // compare by reference, so a fresh object is minted only when the fact
    // itself changed. isLoopback is fixed for the page lifetime.
    // 从当前连接代快照读取宿主 home 目录（首个 ready 帧之前为 undefined）。
    const home = this.connection.generation.getSnapshot()?.host.home
    // 仅当事实本身变化时才铸造新对象，保证引用稳定（供快照/记忆化比较）。
    if (this.hostFacts === undefined || this.hostFacts.home !== home) {
      this.hostFacts = { home, isLoopback: this.connection.isLoopback }
    }
    // 返回缓存的宿主事实。
    return this.hostFacts
  }

  async $mount(contribution: TypertRemoteContribution): ReturnType<TypertClientRemote['$mount']> {
    // 记录调用方上下文（挂载在调用方 fiber 上）。
    const callerCtx = this.ctx
    // 在调用方 fiber 上注册副作用：挂载经变更队列串行执行；卸载同样排队。
    const owned = callerCtx.effect(async () => {
      // 排队执行挂载，得到组卸载函数。
      const dispose = await this.enqueue(() => this.mountContribution(callerCtx, contribution))
      // 返回"排队执行卸载"的包装。
      return () => this.enqueue(dispose)
    }, `api-gateway.client.$mount(${JSON.stringify(contribution.package)})`)
    // 等待挂载完成。
    await owned
    // 返回对外卸载函数（等待排队卸载完成）。
    return async () => { await owned() }
  }

  $on<Event extends TypertRemoteEvent>(
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    // 被动客户端无事件转发能力。
    if (this.events === undefined) throw new Error('client api: forwarded events require interactions=answer')
    // 在当前上下文注册该事件的类型化监听器。
    return this.events.subscribe(this.ctx, event, listener)
  }

  /** Open one Remote stream and normalize a worker-local carrier's structural failures. */
  private openRemoteStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
    noConnection = `client api: ${endpoint} has no active Connection`,
  ): AsyncIterable<unknown> {
    // 重新从根上下文取连接（可能在构造后才装配）。
    const connection = this.ownerCtx.get('connection') as ConnectionHandle | undefined
    // 无连接载体：以可定制的错误消息失败。
    if (connection === undefined) throw new Error(noConnection)
    // 优先尝试进程内 RPC 通道打开流（worker 场景）。
    const local = connection.rpc.open?.('/api', endpoint, payload, signal, uplink)
    // 无进程内通道：走多路复用 WebSocket；有则把结构化失败归一后返回。
    return local === undefined
      ? this.streams.open(endpoint, payload, signal, uplink)
      : normalizeConnectionStream(local)
  }

  // 串行化变更操作：任何时刻只执行一个挂载/卸载。
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    // 追加到当前队列尾部（无论前一个成败都执行）。
    const result = this.mutations.then(operation, operation)
    // 更新队列尾为"吞掉结果"的 Promise，保证后续操作总能执行。
    this.mutations = result.then(() => undefined, () => undefined)
    // 返回带原始结果/错误的 Promise。
    return result
  }

  // 挂载一个贡献包：注册贡献、按命名空间分组安装；任一步失败则逆序回滚。
  private async mountContribution(
    callerCtx: Context,
    contribution: TypertRemoteContribution,
  ): Promise<TypertDisposer> {
    // 先做结构与冲突校验（失败即拒绝挂载）。
    this.validateContribution(contribution)
    // 在 Typert 注册表登记该贡献。
    const disposeRemote = callerCtx.typert.remotes.register(contribution)
    // 按命名空间把描述符分组。
    const groups = new Map<string, InvocationDescriptor[]>()
    for (const descriptor of contribution.descriptors) {
      // 取该命名空间的现有分组。
      const group = groups.get(descriptor.namespace)
      // 无分组则新建；有则追加。
      if (group === undefined) groups.set(descriptor.namespace, [descriptor])
      else group.push(descriptor)
    }
    // 已安装各组命名空间的卸载函数（用于回滚）。
    const installed: TypertDisposer[] = []
    try {
      // 逐组安装命名空间。
      for (const [namespace, descriptors] of groups) {
        installed.push(await this.installNamespace(namespace, descriptors))
      }
    } catch (error) {
      // 安装失败：逆序卸载已装组。
      for (const dispose of installed.reverse()) await dispose()
      // 再注销贡献本身。
      await disposeRemote()
      // 原样抛出错误。
      throw error
    }
    // 返回整包卸载函数：逆序卸载各组 + 注销贡献。
    return async () => {
      for (const dispose of installed.reverse()) await dispose()
      await disposeRemote()
    }
  }

  // 贡献校验：方法不重复、输入必须是 strict 编解码、命名空间/方法名不与现有服务冲突。
  private validateContribution(contribution: TypertRemoteContribution): void {
    // 贡献内 direct 方法登记表：namespace -> 方法名集合。
    const direct = new Map<string, Set<string>>()
    // 贡献内 scoped 方法登记表。
    const scoped = new Map<string, Set<string>>()
    // 登记并检查一个方法变体（贡献内重复、与已挂载变体重复都算冲突）。
    const add = (
      table: Map<string, Set<string>>,
      descriptor: InvocationDescriptor,
      kind: 'direct' | 'scoped',
    ): void => {
      // 取该命名空间在贡献内的方法集合（无则新建）。
      const methods = table.get(descriptor.namespace) ?? new Set<string>()
      // 同一贡献内重复声明：拒绝。
      if (methods.has(descriptor.method)) {
        throw new Error(`client api: contribution repeats ${kind} method ${endpointOf(descriptor)}`)
      }
      // 登记方法名。
      methods.add(descriptor.method)
      // 写回登记表。
      table.set(descriptor.namespace, methods)
      // 检查是否与已挂载的同名变体冲突。
      const namespace = this.namespaces.get(descriptor.namespace)?.service
      if (namespace?.has(kind, descriptor.method) === true) {
        throw new Error(`client api: ${kind} method ${endpointOf(descriptor)} is already mounted`)
      }
    }
    // 逐描述符校验。
    for (const descriptor of contribution.descriptors) {
      // 所有输入字段必须是 strict 编解码。
      requireStrictInputs(descriptor)
      // direct 变体登记。
      if (descriptor.invocation.kind === 'direct') add(direct, descriptor, 'direct')
      // 存在作用域投影则登记 scoped 变体。
      if (scopedProjection(descriptor) !== undefined) add(scoped, descriptor, 'scoped')
    }
    // 涉及的全部命名空间。
    const namespaces = new Set([...direct.keys(), ...scoped.keys()])
    for (const namespace of namespaces) {
      // 该命名空间是否已安装。
      const service = this.namespaces.get(namespace)?.service
      // 尚未安装：检查与 Remote 服务本体或既有属性的冲突。
      if (service === undefined) {
        // 命名空间名与 Remote 服务自身成员冲突。
        if (namespace in this) {
          throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with the Remote service`)
        }
        // 计算命名空间服务的属性键。
        const serviceKey = remoteServiceKey(namespace)
        // 反射查看该键的属性声明。
        const property = this.ownerCtx.reflect.props[serviceKey]
        // 已有访问器属性或已有值：与现有命名空间冲突。
        if (property?.type === 'accessor' || this.ownerCtx.get(serviceKey) !== undefined) {
          throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with an existing Remote namespace`)
        }
      }
      // 校验该命名空间下每个方法名不与服务保留成员冲突。
      for (const method of new Set([...(direct.get(namespace) ?? []), ...(scoped.get(namespace) ?? [])])) {
        // 未安装：用静态校验（带命名空间名）；已安装：用实例校验。
        if (service === undefined) RemoteNamespaceService.assertMethodAvailable(namespace, method)
        else service.assertMethodAvailable(method)
      }
    }
  }

  // 安装一个命名空间的整组描述符：新命名空间在其 fiber 的 apply 内同步装完整组（无可视化间隙）；
  // 已有命名空间则一步同步并入。返回的卸载函数在组空时一并卸载命名空间。
  /**
   * Mount one namespace's descriptor group with no visibility gap: a fresh
   * namespace installs its whole group synchronously inside its fiber's
   * apply, so a plugin parked on the namespace service never observes it
   * without the methods the same contribution carries; an existing namespace
   * takes the group in one synchronous step.
   * @param name - Remote namespace.
   * @param descriptors - Every contribution descriptor naming that namespace.
   * @returns disposer unmounting the group and the namespace once empty.
   */
  private async installNamespace(
    name: string,
    descriptors: readonly InvocationDescriptor[],
  ): Promise<TypertDisposer> {
    // 该命名空间是否已存在句柄。
    let namespace = this.namespaces.get(name)
    // 本次安装的方法记录（供组卸载回滚）。
    let installed: InstalledMethod[]
    // 不存在：新建命名空间插件并同步安装整组；存在：在既有服务上一步安装。
    if (namespace === undefined) {
      ({ namespace, installed } = await this.createNamespace(name, descriptors))
    } else {
      installed = installMethods(namespace.service, descriptors)
    }
    // 固定句柄引用（卸载函数闭包使用）。
    const handle = namespace
    // 返回组卸载函数：逆序卸载每个方法变体，再视空情况卸载命名空间。
    return async () => {
      for (const method of [...installed].reverse()) {
        // 已被回滚卸载过：跳过。
        /* v8 ignore next -- Cordis effect disposers are idempotent and invoke this cleanup at most once. */
        if (!method.token.active) continue
        // 标记令牌失效：进行中的调用将按"已撤销"处理。
        method.token.active = false
        // 中止该方法的进行中调用。
        method.token.abort.abort()
        // 从服务上移除 scoped 变体（若装过）。
        if (method.scoped) handle.service.remove('scoped', method.descriptor.method, method.token)
        // 从服务上移除 direct 变体（若装过）。
        if (method.direct) handle.service.remove('direct', method.descriptor.method, method.token)
      }
      // 组内方法清空后视情况卸载命名空间本体。
      await this.disposeNamespace(name, handle)
    }
  }

  // 新建命名空间：在独立插件 fiber 内同步构造服务并安装整组方法（无可视化间隙）。
  private async createNamespace(
    name: string,
    descriptors: readonly InvocationDescriptor[],
  ): Promise<{ namespace: RemoteNamespaceHandle; installed: InstalledMethod[] }> {
    // fiber apply 内构造的服务实例。
    let service: RemoteNamespaceService | undefined
    // fiber apply 内安装的方法记录。
    let installed: InstalledMethod[] | undefined
    // 以 remote.<namespace> 为名启动插件 fiber。
    const fiber = this.ownerCtx.plugin({
      name: remoteServiceKey(name),
      apply: (ctx: Context) => {
        // 构造命名空间服务；方法调用统一回到 invokeMethod 分发。
        service = new RemoteNamespaceService(
          ctx,
          name,
          (direct, scoped, caller, args) => this.invokeMethod(direct, scoped, caller, args),
        )
        // Same synchronous window as the service registration: a dependent the
        // new service unparks runs only after the methods exist.
        installed = installMethods(service, descriptors)
      },
    })
    try {
      // 等待 fiber 启动完成。
      await fiber
    } catch (error) {
      // 启动失败：释放 fiber 并上抛。
      await fiber.dispose()
      throw error
    }
    /* v8 ignore next 3 -- a settled namespace fiber synchronously constructs its Service and installs the group. */
    if (service === undefined || installed === undefined) {
      throw new Error(`client api: namespace ${JSON.stringify(name)} did not start`)
    }
    // 组装命名空间句柄。
    const namespace = { service, dispose: fiber.dispose }
    // 登记到命名空间表。
    this.namespaces.set(name, namespace)
    // 返回句柄与安装记录。
    return { namespace, installed }
  }

  // 命名空间空了且仍是登记中的那个句柄：删除登记并卸载插件 fiber。
  private async disposeNamespace(name: string, namespace: RemoteNamespaceHandle): Promise<void> {
    // 还有方法未卸载，或句柄已被替换：保留命名空间。
    if (!namespace.service.empty || this.namespaces.get(name) !== namespace) return
    // 从登记表删除。
    this.namespaces.delete(name)
    // 卸载命名空间插件。
    await namespace.dispose()
  }

  // 方法调用分发：优先带已解析身份的 scoped，其次 direct，再退回未解析身份的 scoped。
  private invokeMethod(
    direct: DirectMethod | undefined,
    scoped: ScopedMethod | undefined,
    callerCtx: Context,
    values: readonly unknown[],
  ): Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown> {
    if (scoped !== undefined) {
      // 取作用域上下文的客户端适配器。
      const adapter = this.ownerCtx.typert.contexts.getClient(scoped.projection.context)
      // 从调用方上下文解析身份。
      const identity = adapter?.identity(callerCtx)
      // 身份可解析：以绑定身份走 scoped 调用。
      if (identity !== undefined) {
        return this.invokeSelected(
          scoped.descriptor,
          scoped.projection,
          scoped.token,
          callerCtx,
          values,
          { value: identity },
        )
      }
    }
    // 有 direct 变体：按直接调用处理。
    if (direct !== undefined) {
      return this.invokeSelected(direct.descriptor, undefined, direct.token, callerCtx, values)
    }
    // 只有 scoped 且身份无法解析：仍走 scoped（缺少身份将在参数准备时失败）。
    if (scoped !== undefined) {
      return this.invokeSelected(scoped.descriptor, scoped.projection, scoped.token, callerCtx, values)
    }
    // 两个变体都没挂载：方法已被卸载。
    throw new Error('client api: Remote method is no longer mounted')
  }

  // 按描述符模式分流：流模式走 invokeStream，普通调用走 invoke。
  private invokeSelected(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown> {
    // 声明了流模式：交给流调用路径。
    if (descriptor.mode !== undefined) {
      return this.invokeStream(descriptor, projection, token, callerCtx, values, boundIdentity)
    }
    // 普通请求-响应调用。
    return this.invoke(descriptor, projection, token, callerCtx, values, boundIdentity)
  }

  // 执行一次普通（非流）远程调用，并把各种失败归一为 RemoteResult。
  private async invoke(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): Promise<RemoteResult<unknown>> {
    // 计算端点字符串。
    const endpoint = endpointOf(descriptor)
    // 方法已卸载：返回"已撤销"失败。
    if (!token.active) return withdrawn(endpoint)
    // 准备端点、参数与信号。
    const prepared = this.prepareInvocation(descriptor, projection, token, callerCtx, values, boundIdentity)
    // 取连接载体（可能尚未装配）。
    const connection = this.ownerCtx.get('connection') as ConnectionHandle | undefined
    // 无连接：抛出装配错误（不经错误分支，属本地缺陷）。
    if (connection === undefined) throw new Error(`client api: ${endpoint} has no active Connection`)
    try {
      // 经连接的 RPC 通道发起调用。
      const result = await connection.rpc.call('/api', endpoint, { args: prepared.args }, prepared.signal)
      // 响应返回时方法已被卸载：按撤销处理。
      if (!mountActive(token)) return withdrawn(endpoint)
      // 调用方信号已中止：抛出以走取消分支。
      prepared.signal.throwIfAborted()
      // 宿主返回失败：重建为本地 RemoteError。
      if (!result.ok) return { ok: false, error: rebuiltFailure(result.error) }
      // strict 结果模式且有解码器：先解码；否则原样透传。
      const value = descriptor.result.mode === 'strict' && descriptor.result.decode !== undefined
        ? descriptor.result.decode(result.value)
        : result.value
      // 返回成功结果。
      return { ok: true, value }
    } catch (error) {
      // Carrier throws (offline or abort) are outcomes of the call, not assembly
      // faults, so they join the same error branch. A caller-aborted call is a
      // cancellation even when the local throw wins the race against the wire
      // round-trip, so it gets the same code the Host would have produced.
      // 信号已中止：按调用方取消处理（即使本地抛出先于线上往返）。
      if (prepared.signal.aborted) return cancelledFailure(endpoint, error)
      // 其余载体抛错（离线/传输故障）：归为内部失败。
      return carrierFailure(endpoint, error)
    }
  }

  /** Open the logical stream now and hand back its handle; `send()` before the first read queues behind the `open` frame. */
  private invokeStream(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): RemoteStreamHandle<unknown, unknown> {
    // 计算端点字符串。
    const endpoint = endpointOf(descriptor)
    // 方法已卸载：以撤销错误抛出。
    if (!token.active) throw new Error(withdrawn(endpoint).error.message)
    // 准备端点、参数与信号。
    const prepared = this.prepareInvocation(descriptor, projection, token, callerCtx, values, boundIdentity)
    // 本"代"（一次打开到关闭）的取消控制器。
    const generation = new AbortController()
    // 创建上行队列：消费方 send()/end() 先入队，由载体泵发送。
    const uplink = new ClientUplinkQueue(endpoint)
    // 打开下行流：取消信号 = 调用方信号 + 本代控制器。
    const downlink = this.openRemoteStream(
      endpoint,
      { args: prepared.args },
      AbortSignal.any([prepared.signal, generation.signal]),
      uplink,
    )
    // 返回单代流句柄。
    return new ClientStreamHandle(endpoint, downlink, uplink, generation, token)
  }

  // 校验实参并装配一次调用：投影身份、按名收集参数、合并取消信号。
  private prepareInvocation(
    descriptor: InvocationDescriptor,
    projection: ScopedProjection | undefined,
    token: MountToken,
    callerCtx: Context,
    values: readonly unknown[],
    boundIdentity?: BoundContextIdentity,
  ): PreparedClientInvocation {
    // 计算端点字符串。
    const endpoint = endpointOf(descriptor)
    // 期望的业务参数个数（作用域投影占用的参数不计入实参）。
    const expected = descriptor.parameters.length - (projection?.parameterIndex === undefined ? 0 : 1)
    // 是否携带了调用方取消信号（仅当方法声明支持取消且多给了一个实参）。
    const hasCallerSignal = descriptor.cancellation !== undefined && values.length === expected + 1
    // 实参数目不符：给出精确契约的错误。
    if (values.length !== expected && !hasCallerSignal) {
      // 依据是否支持取消生成不同的期望描述。
      const contract = descriptor.cancellation === undefined
        ? `${String(expected)} argument(s)`
        : `${String(expected)} business argument(s) plus an optional AbortSignal`
      throw new Error(
        `client api: ${endpoint} expected ${contract}, got ${String(values.length)}`,
      )
    }
    // 以 null 原型收集线上参数（避免原型键污染）。
    const args = Object.create(null) as Record<string, unknown>
    if (projection !== undefined) {
      // 未预绑定身份时取客户端适配器。
      const adapter = boundIdentity === undefined
        ? this.ownerCtx.typert.contexts.getClient(projection.context)
        : undefined
      // 无适配器：无法解析该上下文。
      if (boundIdentity === undefined && adapter === undefined) {
        throw new Error(`client api: ${endpoint} has no Client Context adapter for ${JSON.stringify(projection.context)}`)
      }
      // 解析上下文身份（预绑定优先）。
      const identity = boundIdentity === undefined
        ? adapter?.identity(callerCtx)
        : boundIdentity.value
      // 身份缺失：要求提供相应上下文。
      if (identity === undefined) {
        throw new Error(`client api: ${endpoint} requires a ${JSON.stringify(projection.context)} Context`)
      }
      // 把身份写到投影指定的线上参数。
      args[projection.wire] = identity
    }
    // 实参游标。
    let valueIndex = 0
    descriptor.parameters.forEach((parameter, parameterIndex) => {
      // 作用域投影占用的参数跳过（已单独写入）。
      if (parameterIndex === projection?.parameterIndex) return
      // 取下一个实参。
      const value = values[valueIndex]
      // undefined 视为缺省不发送；其余按线上名写入。
      if (value !== undefined) args[parameter.wire] = value
      valueIndex += 1
    })
    // 调用方信号（若提供）。
    const callerSignal = hasCallerSignal ? values[expected] as AbortSignal | undefined : undefined
    // 合成取消信号：挂载令牌的信号（卸载即取消），并上叠加调用方信号。
    const signal = callerSignal === undefined
      ? token.abort.signal
      : AbortSignal.any([token.abort.signal, callerSignal])
    // 返回准备结果。
    return { endpoint, args, signal }
  }
}

// 生成的流方法返回的句柄：一个逻辑流的单次物理代。
// 下行只允许迭代一次；send/end 经上行队列由载体泵发送；dispose 中止本代并归还载体迭代器
// （未收到终态帧则发出 cancel、丢弃缓冲并安静结束迭代）。
/**
 * The handle a generated stream method returns: one generation of one logical
 * stream. The downlink is iterated once; `send`/`end` feed the uplink queue the
 * carrier pump drains; `dispose` aborts the generation and returns the carrier
 * iterator, which sends `cancel` unless a terminal frame arrived, drops what was
 * buffered, and ends the iteration quietly.
 */
class ClientStreamHandle implements RemoteStreamHandle<unknown, unknown> {
  // 下行迭代器（从载体可迭代对象取得）。
  private readonly downlink: AsyncIterator<unknown>
  // 预取的首次读取：把 open 帧抢先上线，其余留给消费者。
  private primed: Promise<IteratorResult<unknown>> | undefined
  // 唯一消费者是否已取走迭代器。
  private consumed = false
  // 是否已释放。
  private disposed = false

  constructor(
    private readonly endpoint: string,
    downlink: AsyncIterable<unknown>,
    private readonly uplink: ClientUplinkQueue,
    private readonly generation: AbortController,
    private readonly token: MountToken,
  ) {
    // 取得下行迭代器。
    this.downlink = downlink[Symbol.asyncIterator]()
    // The carrier opens the logical stream on the first pull; pulling now puts
    // the `open` frame on the wire before any `send()`. The first read is kept
    // for the consumer, and a failure waits for it instead of surfacing here;
    // it also terminates the stream, so the queue closes and `send()` throws.
    // 预取首次读取：让 open 帧先于任何 send() 上线。
    this.primed = this.downlink.next()
    // 预取失败不在此处暴露：先关上行队列，让 send() 尽早抛错；错误留给消费者读取。
    void this.primed.catch(() => { this.uplink.close() })
  }

  send(item: unknown): void {
    // 上行条目必须是无损 JSON 值。
    if (!isRemoteUplinkItem(item)) throw new Error(`client api: ${this.endpoint} uplink item is not a lossless JSON value`)
    // 入队等待载体泵发送。
    this.uplink.push(item)
  }

  end(): void {
    // 半关闭上行：队列读取完毕后发 end 帧。
    this.uplink.end()
  }

  dispose(): void {
    // 幂等：重复释放直接返回。
    if (this.disposed) return
    // 标记已释放。
    this.disposed = true
    // 关闭上行队列：此后 send() 抛错。
    this.uplink.close()
    // 中止本代：打开中的流与进行中的读写一并取消。
    this.generation.abort(new Error(`client api: ${this.endpoint} stream disposed`))
    // Returning the carrier iterator reaches its `finally` even while nobody
    // reads the downlink, so `cancel` goes out now and the pump stops.
    // 归还载体迭代器触发其 finally：立即发出 cancel 并停止泵（错误忽略）。
    void Promise.resolve(this.downlink.return?.()).catch(() => undefined)
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // 单消费者：第二次取迭代器报错。
    if (this.consumed) throw new Error(`client api: ${this.endpoint} stream has one consumer`)
    // 标记已被消费。
    this.consumed = true
    // 启动内部迭代生成器。
    const iteration = this.iterate()
    return {
      next: () => iteration.next(),
      // A return before the first read ends a generator that never started, so its `finally` would not dispose.
      return: (value?: unknown) => {
        this.dispose()
        return iteration.return(value)
      },
    }
  }

  // 内部读取生成器：循环交付下行条目，卸载/撤销时静默退出。
  private async *iterate(): AsyncGenerator {
    try {
      while (true) {
        // 优先消费预取的首次读取，之后正常读取。
        const next = await (this.primed ?? this.downlink.next())
        // 预取只生效一次。
        this.primed = undefined
        // 已释放或流已结束：退出。
        if (this.disposed || next.done === true) return
        // 挂载令牌已撤销：以撤销错误终止迭代。
        if (!mountActive(this.token)) throw new Error(withdrawn(this.endpoint).error.message)
        // 向消费者交付一个条目。
        yield next.value
      }
    } catch (error) {
      // 释放引发的取消错误对消费者不可见：静默退出。
      if (this.disposed) return
      // 其余错误原样上抛。
      throw error
    } finally {
      // Ending early is a dispose; a terminated stream accepts no more uplink.
      this.dispose()
      await this.downlink.return?.()
    }
  }
}

// 命名空间服务的调用回调类型：把 direct/scoped 变体与调用方上下文、实参交给属主分发。
type InvokeRemote = (
  direct: DirectMethod | undefined,
  scoped: ScopedMethod | undefined,
  callerCtx: Context,
  args: readonly unknown[],
) => Promise<RemoteResult<unknown>> | RemoteStreamHandle<unknown, unknown>

// 单个 Remote 命名空间的服务：方法经属性访问器暴露，调用时动态查找当前变体。
class RemoteNamespaceService extends Service {
  // 方法记录表：方法名 -> direct/scoped 变体。
  private readonly methods = new Map<string, RemoteMethodRecord>()
  // 命名空间名（用于错误消息）。
  private readonly namespace: string

  // 静态校验：方法名不得与命名空间服务的保留字段/原型成员冲突。
  static assertMethodAvailable(namespace: string, method: string): void {
    if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
      throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`)
    }
  }

  constructor(
    ctx: Context,
    name: string,
    private readonly invokeRemote: InvokeRemote,
  ) {
    // 以 remote.<namespace> 为键注册服务。
    super(ctx, remoteServiceKey(name))
    // 记录命名空间名。
    this.namespace = name
  }

  // 实例级校验：静态冲突 + 与运行时自身成员的冲突。
  assertMethodAvailable(method: string): void {
    // 先做静态（类级）校验。
    RemoteNamespaceService.assertMethodAvailable(this.namespace, method)
    // 名字撞上了实例自身成员（如历史遗留的访问器）却不在方法表里：冲突。
    if (method in this && !this.methods.has(method)) {
      throw new Error(`client api: method ${JSON.stringify(`${this.namespace}/${method}`)} conflicts with its namespace service`)
    }
  }

  get empty(): boolean {
    // 是否已无任何方法（决定命名空间能否卸载）。
    return this.methods.size === 0
  }

  has(kind: 'direct' | 'scoped', method: string): boolean {
    // 查询某方法是否已挂载指定种类的变体。
    return this.methods.get(method)?.[kind] !== undefined
  }

  installDirect(descriptor: InvocationDescriptor, token: MountToken): void {
    // 安装 direct 变体。
    this.install(descriptor.method, 'direct', { descriptor, token })
  }

  installScoped(descriptor: InvocationDescriptor, projection: ScopedProjection, token: MountToken): void {
    // 安装 scoped 变体（带投影）。
    this.install(descriptor.method, 'scoped', { descriptor, projection, token })
  }

  private install(method: string, kind: 'direct', value: DirectMethod): void
  private install(method: string, kind: 'scoped', value: ScopedMethod): void
  private install(method: string, kind: 'direct' | 'scoped', value: DirectMethod | ScopedMethod): void {
    // 安装前校验方法名可用。
    this.assertMethodAvailable(method)
    // 取既有记录。
    let record = this.methods.get(method)
    // 是否首次安装该方法。
    const fresh = record === undefined
    // 无记录则新建空记录。
    record ??= {}
    if (fresh) {
      // 首次安装：定义同名的惰性访问器，读取时再解析当前变体。
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        get: function (this: RemoteNamespaceService): (...args: unknown[]) => unknown {
          // 捕获调用方 fiber 上下文。
          const callerCtx = this.ctx
          // 每次访问都取最新记录（卸载/重挂立即生效）。
          const current = this.methods.get(method)
          // 读出当前直接的变体（可能为空）。
          const direct = current?.direct
          // 读出当前作用域的变体（可能为空）。
          const scoped = current?.scoped
          // 返回真正的调用函数：把变体与调用方上下文交给属主分发。
          return (...args: unknown[]) => {
            return this.invokeRemote(direct, scoped, callerCtx, args)
          }
        },
      })
      // 登记方法记录。
      this.methods.set(method, record)
    }
    // 按种类写入变体。
    if (kind === 'direct') record.direct = value
    else record.scoped = value as ScopedMethod
  }

  // 卸载指定种类的方法变体；两个变体都移除后删除方法与访问器。
  remove(kind: 'direct' | 'scoped', method: string, token: MountToken): void {
    // 取方法记录与当前变体。
    const record = this.methods.get(method)
    const current = record?.[kind]
    // 记录不存在或令牌不匹配（已被新变体替换）：不动作。
    /* v8 ignore next -- duplicate live variants are rejected before installation, so no newer token can replace this one. */
    if (record === undefined || current?.token !== token) return
    // 删除对应种类的变体。
    if (kind === 'direct') delete record.direct
    else delete record.scoped
    // 另一个变体仍在：保留方法与访问器。
    if (record.direct !== undefined || record.scoped !== undefined) return
    // 两个变体都没了：从表中删除记录。
    this.methods.delete(method)
    // 同时删除实例上的同名访问器。
    Reflect.deleteProperty(this, method)
  }
}

// 在命名空间服务上安装一组描述符；任一被拒绝则回滚已安装的部分组。
/**
 * Install one descriptor group on a namespace service, unwinding the partial
 * group when a descriptor is refused.
 * @param service - Namespace service taking the methods.
 * @param descriptors - Descriptor group of one contribution.
 * @returns per-descriptor records for the group disposer.
 */
function installMethods(
  service: RemoteNamespaceService,
  descriptors: readonly InvocationDescriptor[],
): InstalledMethod[] {
  // 已安装记录（供失败回滚与组卸载）。
  const installed: InstalledMethod[] = []
  try {
    for (const descriptor of descriptors) {
      // 为该描述符建立安装记录：活跃令牌 + 独立取消控制器。
      const method: InstalledMethod = {
        descriptor,
        token: { active: true, abort: new AbortController() },
        direct: false,
        scoped: false,
      }
      // 先登记，再安装（便于部分失败时回滚）。
      installed.push(method)
      // direct 描述符：安装 direct 变体并记录。
      if (descriptor.invocation.kind === 'direct') {
        service.installDirect(descriptor, method.token)
        method.direct = true
      }
      // 计算作用域投影（若有）。
      const projection = scopedProjection(descriptor)
      if (projection !== undefined) {
        // 有投影：安装 scoped 变体并记录。
        service.installScoped(descriptor, projection, method.token)
        method.scoped = true
      }
    }
  } catch (error) {
    // 任一描述符被拒绝：逆序回滚已安装的方法。
    for (const method of [...installed].reverse()) {
      // 标记令牌失效并中止进行中调用。
      method.token.active = false
      method.token.abort.abort()
      // 从服务上移除已安装的变体。
      if (method.scoped) service.remove('scoped', method.descriptor.method, method.token)
      if (method.direct) service.remove('direct', method.descriptor.method, method.token)
    }
    // 原样抛出拒绝原因。
    throw error
  }
  return installed
}

// 命名空间服务的保留成员名：方法名不得与之冲突。
const REMOTE_NAMESPACE_FIELDS = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace'])

function remoteServiceKey(namespace: string): string {
  // 命名空间服务的 Cordis 属性键。
  return `remote.${namespace}`
}

function endpointOf(descriptor: Pick<InvocationDescriptor, 'namespace' | 'method'>): string {
  // 端点 = `<namespace>/<method>`。
  return `${descriptor.namespace}/${descriptor.method}`
}

function mountActive(token: MountToken): boolean {
  // 挂载令牌是否仍活跃（方法未卸载）。
  return token.active
}

// 推导描述符的作用域投影：context 调用直接取声明；scope 声明则必须唯一选中其 lookup 参数。
function scopedProjection(descriptor: InvocationDescriptor): ScopedProjection | undefined {
  // context 类调用：上下文名与线上参数直接来自声明本身。
  if (descriptor.invocation.kind === 'context') {
    return {
      context: descriptor.invocation.context,
      wire: descriptor.invocation.wire,
    }
  }
  // 无 scope 声明：非作用域方法。
  if (descriptor.scope === undefined) return undefined
  // 找出全部 lookup 来源的参数（带原下标）。
  const lookupParameters = descriptor.parameters
    .map((parameter, index) => ({ parameter, index }))
    .filter(candidate => candidate.parameter.source === 'lookup')
  // 仅当恰好一个 lookup 参数时才可选定。
  const selected = lookupParameters.length === 1 ? lookupParameters[0] : undefined
  // 未选定，或与 scope 声明的线上名/上下文不一致：生成器输出不合法。
  if (selected === undefined
    || selected.parameter.wire !== descriptor.scope.wire
    || selected.parameter.lookup !== descriptor.scope.context) {
    throw new Error(
      `client api: generated Remote ${endpointOf(descriptor)} scope must select its only lookup parameter`,
    )
  }
  // 返回投影：上下文、线上参数与该参数在参数表中的下标。
  return {
    context: descriptor.scope.context,
    wire: descriptor.scope.wire,
    parameterIndex: selected.index,
  }
}

// 要求描述符全部输入（参数、上行、上下文）都有 strict 编解码器。
function requireStrictInputs(descriptor: InvocationDescriptor): void {
  // 端点字符串用于错误消息。
  const endpoint = endpointOf(descriptor)
  for (const parameter of descriptor.parameters) {
    // 逐参数校验。
    requireStrictCodec(parameter.codec, endpoint, parameter.wire)
  }
  // 上行编解码校验。
  if (descriptor.uplink !== undefined) requireStrictCodec(descriptor.uplink.codec, endpoint, 'uplink')
  // context 调用的上下文参数校验。
  if (descriptor.invocation.kind === 'context') {
    requireStrictCodec(descriptor.invocation.codec, endpoint, descriptor.invocation.wire)
  }
}

// 单字段校验：编解码模式必须是 strict。
function requireStrictCodec(codec: TypertCodec, endpoint: string, field: string): void {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
}

/** The namespace retired before or during the call, so no request outcome exists. */
function withdrawn(endpoint: string): Extract<RemoteResult<never>, { readonly ok: false }> {
  // 方法已撤销：统一以内部失败表达（无请求结果可言）。
  return internalFailure(`client api: Remote method ${endpoint} is no longer mounted`)
}

/**
 * The error branch a carrier throw (offline, transport fault) folds into: `gateway/internal` naming the endpoint and
 * the thrown message. Exported so a stand-in for this face folds identically.
 * @param endpoint - `<namespace>/<method>` that was called.
 * @param error - what the carrier threw.
 * @returns the failed result.
 */
export function carrierFailure(endpoint: string, error: unknown): Extract<RemoteResult<never>, { readonly ok: false }> {
  // 以 gateway/internal 包装载体错误消息（含端点），供替身实现复用同一形态。
  return internalFailure(`client api: ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * The error branch a call aborted by its caller folds into: `gateway/cancelled` with the carrier's throw as `cause`.
 * @param endpoint - `<namespace>/<method>` that was called.
 * @param cause - what the carrier threw when the signal aborted.
 * @returns the failed result.
 */
export function cancelledFailure(endpoint: string, cause: unknown): Extract<RemoteResult<never>, { readonly ok: false }> {
  // 取消失败：gateway/cancelled 码，载体抛错作为 cause 保留。
  return {
    ok: false,
    error: new RemoteError('gateway/cancelled', `client api: Remote invocation "${endpoint}" was aborted`, {}, { cause }),
  }
}

// 内部失败：gateway/internal 码 + 诊断消息。
function internalFailure(message: string): Extract<RemoteResult<never>, { readonly ok: false }> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/**
 * Whether a caught value is a Remote failure this face delivered or threw.
 * The one consumer-facing discrimination point: marked instances carry their
 * Host code; anything else is a local fault the caller should let crash.
 * @param error - a caught value.
 * @returns true when the value narrows to RemoteFailure.
 */
export function isRemoteFailure(error: unknown): error is RemoteFailure {
  // 值带有远程错误标记（RemoteError 实例）即视为远程失败。
  return remoteErrorOf(error) !== undefined
}

/**
 * Rebuild the wire failure as a local RemoteError instance so the error branch
 * carries a real Error and `throw result.error` keeps throw semantics. The code
 * is passed through verbatim without runtime validation: a code outside this
 * Client's merged map still surfaces as-is, so a newer Host stays readable.
 */
function rebuiltFailure(error: { code: string; message: string; details: object }): RemoteFailure {
  // 以线上错误重建本地 RemoteError：错误码逐字透传不做运行时校验（更新的宿主码仍可读）。
  return new RemoteError(error.code as never, error.message, error.details as never)
}

// worker 传输对端打标的错误形态：远程失败（带码）或承载失败。
type MarkedConnectionStreamFailure = Error & {
  readonly dshRemoteStreamFailure?:
    | { readonly kind: 'remote'; readonly code: string; readonly details: object }
    | { readonly kind: 'carrier' }
}

/** Preserve Gateway error classes across a worker transport's separately bundled page half. */
async function *normalizeConnectionStream(source: AsyncIterable<unknown>): AsyncGenerator {
  try {
    // 透传源迭代的所有条目。
    yield * source
  } catch (error) {
    // 非 Error 抛出值：原样上抛。
    if (!(error instanceof Error)) throw error
    // 读取传输对端的错误标记。
    const marker = (error as MarkedConnectionStreamFailure).dshRemoteStreamFailure
    // 标记为远程失败：重建为带码 RemoteError。
    if (marker?.kind === 'remote') {
      throw new RemoteError(marker.code as never, error.message, marker.details as never)
    }
    // 标记为承载失败：重建为可重试的 CarrierError。
    if (marker?.kind === 'carrier') {
      throw new RemoteStreamCarrierError(error.message, { cause: error })
    }
    // 未打标的错误：原样上抛（本地缺陷）。
    throw error
  }
}
