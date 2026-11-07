// Session Controller（会话控制器）的适配层：为 Agent 范围的文件引用（file-reference）发现提供远程服务。
/** Session Controller adapter for Agent-scoped file-reference discovery. */

// cordis 的 Context 类型：宿主（Host）依赖注入上下文。
import type { Context } from '@deepseek-ai/cordis'
// Agent 类型：目标智能体，文件引用按其工作目录解析。
import type { Agent } from '@deepseek-ai/dsh-agent'
// 副作用导入：注册 file-reference 相关的类型声明。
import type {} from '@deepseek-ai/dsh-file-reference'
// FileReferenceCandidate（文件引用候选）：候选文件/目录的对外形状。
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
// Remote 装饰器与 TypertRemoteService 基类：把类方法暴露为 Typert（类型化协议）远程方法。
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

// 模块扩充：给 cordis 的 Context 挂上本服务的类型，供宿主各处通过 ctx 访问。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // `fileReferences` 远程命名空间的宿主持有者。
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences
  }
}

// 宿主远程适配器：把组合后的文件引用提供者（provider）包装成远程命名空间。
/** Host Remote adapter over the composed file-reference provider. */
export class SessionFileReferences extends TypertRemoteService {
  // 声明依赖注入列表：文件引用服务与 typert 协议栈。
  static inject = ['fileReferences', 'typert']

  // 构造时登记远程服务名与线上命名空间（namespace）。
  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  // Remote 装饰器：把下面的方法注册为可远程调用的端点。
  @Remote
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    // 直接委托给组合的文件引用提供者执行实际列举。
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}

// 默认导出本适配器类，便于按需装配。
export default SessionFileReferences
