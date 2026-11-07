// Client 作用域代（generation）：本地事件的独立路由，与 Host Agent 驻留无关。
/** Client scope generations route local events independently of Host Agent residency. */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

// 携带一个 Agent 身份及其作用域 Remote 命名空间的 Client Cordis Context。
/** Client Cordis Context carrying one Agent identity and its scoped Remote namespaces. */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: ClientRemote & TypertRemoteScopeApi<'agent'>
}

// 由 createScope 写入的 context 标签（tag）。
/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope')

// 作用域身份：该代承载的持久会话 id。
interface ScopeIdentity {
  readonly sessionId: SessionId
}

// 一个铸出的 Agent 作用域及其销毁边界。
/** A minted Agent scope and its disposal boundary. */
export interface AgentScopeHandle {
  // 打过标签的 context：作用域内的注册与作用域分发都经过它（把它作为分发主体时会路由到本代的标签监听者加上所有未打标签者）。
  /**
   * Tagged context: scope-owned registrations and scoped dispatch both go
   * through it (passing it as the dispatch subject routes to this generation's
   * tagged listeners plus every untagged one).
   */
  ctx: AgentContext
  // 背后的 fiber（dispose 会拆除所有作用域内注册）。
  /** Backing fiber (dispose tears down every scope-owned registration). */
  fiber: Fiber
}

// 每个作用域 fiber 共享的空插件（仅用于挂载 context）。
/** Shared no-op plugin backing each Agent scope fiber. */
function agentScope(): void {}

// 在 ctx 下铸出一个 Agent 作用域：一个空插件 fiber，其 context 携带 agent 标签与分发过滤器——未打标签的监听者全局放行，打了标签的仅同代匹配；经返回 ctx 的注册随 fiber 销毁。
/**
 * Mint an Agent scope under `ctx`: a no-op plugin fiber whose context
 * carries the agent tag and the dispatch filter — untagged listeners are
 * admitted globally, tagged listeners only for the same Client generation.
 * Registrations through the returned ctx dispose with the fiber.
 * @param ctx - client root context the scope fiber mounts under.
 * @param key - durable Session identity carried by this generation.
 * @returns the tagged context and its backing fiber.
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  // 挂载空插件 fiber，作用域内注册随它销毁。
  const fiber = ctx.plugin(agentScope)
  // 该代的身份对象（供过滤器比较与查询）。
  const identity: ScopeIdentity = { sessionId: key }
  // 扩展 context：写入身份标签与事件分发过滤器。
  const scoped = fiber.ctx.extend({
    [kScope]: identity,
    [CordisContext.filter](listenerCtx: Context): boolean {
      // 读取监听者 context 的作用域标签。
      const tag = scopeIdentityOf(listenerCtx)
      // 未打标签的监听者全局放行；打了标签的仅同代匹配。
      return tag === undefined || tag === identity
    },
  }) as AgentContext
  return {
    fiber,
    ctx: scoped,
  }
}

// 读取 context 继承的最近 agent 标签。
/**
 * Read the nearest agent tag inherited by a context.
 * @param ctx - any client context.
 * @returns its agent identity (the session id), or undefined for root contexts.
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  // 从代身份中取出会话 id。
  return scopeIdentityOf(ctx)?.sessionId
}

// 读取 Client Context 继承的精确代身份。
/**
 * Read the exact generation identity inherited by a Client Context.
 * @param ctx - scoped or root Client Context.
 * @returns the generation identity, or undefined for an unscoped Context.
 */
export function scopeIdentityOf(ctx: Context): ScopeIdentity | undefined {
  // 读取标签属性；未打标签的 context 得 undefined。
  return (ctx as Context & { [kScope]?: ScopeIdentity })[kScope]
}
