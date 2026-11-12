// 模块说明：credentials 远程命名空间的宿主所有者——配置页面读写的"引用（reference）"
// 半边：批量 describe、单向 set/unset；承担批量扇出上限、逐字段投影、引用语法守卫
// 与拒绝映射，机密值只进不出。
/**
 * Host owner of the `credentials` Remote namespace: the reference half of
 * `ctx.credentials` as a browser configuration page reads and writes it.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/credentials.ts
 */

// 导入 cordis 的 Context 类型
import { Context } from '@deepseek-ai/cordis'
// 导入凭据引用（credentialRef）的构造函数（带品牌校验）
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// 导入凭据提供方（CredentialProvider）类型
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
// 导入凭据信息（CredentialInfo）类型
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
// 导入 Typert 协议的 Remote 装饰器、远程错误与远程服务基类
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 导入 zod 校验库
import { z } from 'zod'

/**
 * 一次远程 `describe` 批量的扇出上限。配置页面只会询问它自己各行所引用的凭据，
 * 因此该上限远高于任何真实页面，同时仍能防止单个已验证请求启动无界的提供方工作。
 */
const MAX_DESCRIBE_REFS = 64

// 引用名语法：以字母或下划线开头，后接字母/数字/下划线
const credentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
// describe 请求体：refs 数组，最多 MAX_DESCRIBE_REFS 个引用名
const describeRequestSchema = z.object({
  refs: z.array(credentialRefSchema).max(MAX_DESCRIBE_REFS),
})
// set 请求体：引用名 + 非空字符串值
const setRequestSchema = z.object({ ref: credentialRefSchema, value: z.string().min(1) })
// unset 请求体：仅引用名
const unsetRequestSchema = z.object({ ref: credentialRefSchema })

/** 解析比生成的 TypeScript 编解码器更具体的领域约束。 */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  // 用 zod 安全解析（不抛异常）
  const parsed = schema.safeParse(value)
  // 校验失败：抛出网关坏请求错误并附带 zod 的问题列表
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  // 返回解析后的数据
  return parsed.data
}

/**
 * 只拷贝 {@link CredentialInfo} 声明的字段。网关返回业务结果时不做解码，
 * 因此如果某个提供方的 `describe` 带了额外的可枚举属性，会被原样序列化给调用方；
 * 此函数逐字段投影避免这种泄漏。
 * @param info - 提供方对某个引用的回答。
 * @returns 仅包含相同事实、不附加任何其他内容的对象。
 */
function projectCredentialInfo(info: CredentialInfo): CredentialInfo {
  return {
    // 是否已配置
    configured: info.configured,
    // 来源仅在存在时输出（条件展开避免显式 undefined 字段）
    ...info.source === undefined ? {} : { source: info.source },
    // 是否可写
    writable: info.writable,
    ...info.masked === undefined ? {} : { masked: info.masked },
  }
}

// 扩充 cordis 的 Context 接口，把 credentialsController 登记为宿主上下文上的服务
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `credentials` 远程命名空间的宿主所有者。 */
    credentialsController: CredentialsController
  }
}

/**
 * Host service backing the generated `ctx.remote.credentials` namespace. It
 * carries every wire obligation the credential seam itself does not: the batch
 * fan-out bound, the field-by-field view projection, the reference-grammar
 * guard, and the refusal mapping. Full secret values cross in one direction only —
 * no method here returns one.
 */
export class CredentialsController extends TypertRemoteService {
  /** @param ctx - 可能挂载凭据提供方的宿主上下文。 */
  constructor(ctx: Context) {
    // 调用基类构造：服务名为 credentialsController，远程命名空间为 credentials
    super(ctx, 'credentialsController', { namespace: 'credentials' })
  }

  /**
   * 为一个配置界面描述多个引用。做成批量是因为配置页面会一次性描述其各行引用的
   * 全部凭据，一次往返可避免各行分别就绪。
   * @param refs - 引用名，至多 {@link MAX_DESCRIBE_REFS} 个；语法之外的名称会以
   *   `gateway/bad-request` 拒绝整个调用。
   * @returns 每个请求名称对应一个视图，以该名称为键。
   * @throws 当请求非法或未挂载凭据提供方时抛出 RemoteError。
   */
  @Remote
  async describe(refs: string[]): Promise<Record<string, CredentialInfo>> {
    // 先按 schema 校验请求体
    const request = parseRequest('credentials.describe', describeRequestSchema, { refs })
    // 为每个引用构造品牌化的引用键（不合法的名称在此抛错）
    const branded = request.refs.map(ref => [ref, credentialRef(ref)] as const)
    // 解析可选的凭据提供方（缺失时抛错）
    const credentials = this.provider()
    // 并发描述每个引用，并做逐字段投影
    const entries = await Promise.all(branded.map(async ([ref, key]) =>
      [ref, projectCredentialInfo(await credentials.describe(key))] as const))
    // 把 [ref, info] 对转换为以引用名为键的对象
    return Object.fromEntries(entries)
  }

  /**
   * 从一个配置界面存储一个值。该值只沿这个方向跨越网络：没有任何读取路径会返回它。
   * @param ref - 要存储其下的引用名。
   * @param - 非空的机密值。
   * @throws 当请求非法、未挂载提供方或提供方拒绝写入时抛出 RemoteError。
   */
  @Remote
  async set(ref: string, value: string): Promise<void> {
    // 校验 set 请求体
    const request = parseRequest('credentials.set', setRequestSchema, { ref, value })
    // 构造品牌化的引用键
    const branded = credentialRef(request.ref)
    // 解析可选的凭据提供方（缺失时抛错）
    const credentials = this.provider()
    // 执行写入并统一映射拒绝错误
    await this.write(request.ref, () => credentials.set(branded, request.value))
  }

  /**
   * 从一个配置界面移除一个引用。
   * @param ref - 要移除的引用名。
   * @throws 当请求非法、未挂载提供方或提供方拒绝写入时抛出 RemoteError。
   */
  @Remote
  async unset(ref: string): Promise<void> {
    // 校验 unset 请求体
    const request = parseRequest('credentials.unset', unsetRequestSchema, { ref })
    // 构造品牌化的引用键
    const branded = credentialRef(request.ref)
    // 解析可选的凭据提供方（缺失时抛错）
    const credentials = this.provider()
    // 执行删除并统一映射拒绝错误
    await this.write(request.ref, () => credentials.unset(branded))
  }

  /** 解析可选的提供方，或在缺失时报告如何补齐。 */
  private provider(): CredentialProvider {
    // 从宿主上下文获取凭据服务
    const credentials = this.ctx.get('credentials')
    // 未挂载提供方：抛出内部错误，说明部署组合中缺少凭据提供方
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    // 返回已挂载的提供方
    return credentials
  }

  /**
   * 执行一次远程写入，并把每种拒绝都报告为携带接缝自身消息的 `credential/rejected`：
   * 提供方的拒绝（例如存储的文档不再可解析）正是配置页面必须原样展示的内容。
   * 调用方在进入前已对引用做品牌化，因此语法之外的名称永远不会到达此路径，
   * 其失败方式与读取侧一致。details 只包含引用名，任何失败路径都不可能把值带出去。
   */
  private async write(ref: string, write: () => Promise<void>): Promise<void> {
    try {
      // 执行实际的写入操作
      await write()
    } catch (error: unknown) {
      // 把提供方拒绝包装为 credential/rejected：消息取自原始错误，details 只带引用名
      throw new RemoteError(
        'credential/rejected',
        error instanceof Error ? error.message : String(error),
        { ref },
        { cause: error },
      )
    }
  }
}

// 默认导出该服务类，便于宿主组合时统一引用
export default CredentialsController
