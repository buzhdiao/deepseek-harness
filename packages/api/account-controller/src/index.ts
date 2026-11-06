/** Authenticated Remote operations for account UI consumers. */
// 面向账户 UI 消费方的已认证 Remote（远程）操作。
import { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context：宿主上下文。
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 导入 Remote 装饰器与远程服务基类。
import { isRunningAccountTask } from '@deepseek-ai/dsh-deepseek-account'
// 导入“正在运行账户任务”的判定函数。
import type {} from '@deepseek-ai/dsh-agent'
// 纯类型副作用导入：合并 agent 服务声明。
import type { AccountBonusBatch, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
// 导入账户域类型：奖励批次、奖励订单 id、客户端元数据、账户详情与账户用户 id。
import type { AccountView, SignInAttemptId } from './types.ts'
// 导入本包的视图与登录尝试 id 类型。

/** Account commands and reconnect-safe state stream. */
// 账户命令与重连安全（reconnect-safe）的状态流。
export class AccountController extends TypertRemoteService {
  // 依赖注入：账户提供方与 agent 服务。
  static inject = ['deepseekAccount', 'agents']
  /** @param ctx - Host with the account provider mounted. */
  // 构造：以 account 命名空间注册到宿主。
  constructor(ctx: Context) { super(ctx, 'accountController', { namespace: 'account' }) }
  /**
   * Read the safe account projection.
   * @returns current account and attempt state.
   */
  // 读取安全的账户投影（当前账户与登录尝试状态）。
  @Remote
  getState(): Promise<AccountView> { return this.ctx.deepseekAccount.getState() }
  /**
   * Query display-safe Platform profile data.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns profile outcome, or null when the account grant is absent or changed.
   */
  // 查询展示安全的平台（Platform）资料；授权缺失或已变更时返回 null。
  @Remote
  getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    return this.ctx.deepseekAccount.getProfile(client)
  }
  /**
   * Query Platform recharge-wallet balances.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns balance outcome, or null when the account grant is absent or changed.
   */
  // 查询平台充值钱包余额；授权缺失或已变更时返回 null。
  @Remote
  getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    return this.ctx.deepseekAccount.getBalance(client)
  }
  /**
   * Query the granted bonuses Platform has not yet recorded as displayed.
   * @param client - identity of the requesting UI; its language selects the server-authored message.
   * @returns bonuses with their account, or null when the account grant is absent or changed.
   */
  // 查询平台尚未记录为已展示的已发放奖励；客户端语言决定服务端文案。
  @Remote
  getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    return this.ctx.deepseekAccount.getUnnotifiedBonuses(client)
  }
  /**
   * Record one displayed bonus as notified for the account it belongs to.
   * @param accountId - account the notification was read for.
   * @param orderId - granted bonus order the user saw.
   * @param client - identity of the requesting UI; the Host derives Platform request headers from it.
   * @returns true once Platform records the acknowledgement; false when the account is absent or changed.
   */
  // 把一个已展示的奖励记录为已通知；平台确认后返回 true，账户缺失或变更时返回 false。
  @Remote
  ackBonusNotified(accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata): Promise<boolean> {
    return this.ctx.deepseekAccount.ackBonusNotified(accountId, orderId, client)
  }
  /**
   * Begin browser sign-in.
   * @param client - identity of the requesting UI, captured by a new attempt.
   * @param callbackOrigin - browser-accessible loopback HTTP origin.
   * @param loginSource - initiating UI, used to return from a failed exchange.
   * @returns a new or already-active login attempt.
   */
  // 开始浏览器登录：新尝试会捕获请求方 UI 的身份；返回新建或已活动的尝试。
  @Remote
  startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    return this.ctx.deepseekAccount.startSignIn(client, callbackOrigin, loginSource)
  }
  /**
   * Cancel the named local attempt.
   * @param attemptId - attempt to cancel.
   * @returns settled cancellation or commit state.
   */
  // 取消指定的本地登录尝试，返回已确定的取消或提交状态。
  @Remote
  cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView> { return this.ctx.deepseekAccount.cancelSignIn(attemptId) }
  /**
   * Inspect the latest logged request providers of running tasks, including tools and retries.
   * @returns whether running work has a latest request context on the account route.
   */
  // 检查运行中任务（含工具与重试）最近记录的请求提供方是否落在账户路由上。
  @Remote
  hasRunningAccountTasks(): boolean {
    return this.ctx.agents.list().some(isRunningAccountTask)
  }
  /**
   * Remove the local account grant and revoke it through Platform in the background, without deleting API keys.
   * @param client - identity of the requesting UI, captured for the background revocation retries.
   * @returns state after removing the local account grant.
   */
  // 移除本地账户授权并在后台通过平台吊销（不删除 API 密钥）。
  @Remote
  signOut(client: AccountClientMetadata): Promise<AccountView> { return this.ctx.deepseekAccount.signOut(client) }
  /**
   * Subscribe to credential expiry without replaying prior notifications.
   * @param signal - stream lifetime.
   * @returns notifications emitted while subscribed.
   */
  // 订阅凭据过期通知（不重放订阅前的通知）。
  @Remote({ mode: 'stream' })
  async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    // 待发送的通知计数。
    let pending = 0
    // 唤醒等待中的生成器的句柄。
    let wake: (() => void) | undefined
    // 订阅凭据过期事件：计数并唤醒；返回退订函数。
    const stop = this.ctx.on('deepseek-account/session-expired', () => { pending++; wake?.() })
    // 中止时也唤醒，以便循环及时退出。
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      // 流生命周期：信号未中止就一直持续。
      while (!signal.aborted) {
        // 有待发通知则产出一个会话过期事件。
        if (pending > 0) { pending--; yield 'session-expired'; continue }
        // 否则挂起，等待下一次事件或中止唤醒。
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      // 清理：退订事件并移除中止监听。
      stop()
      signal.removeEventListener('abort', abort)
    }
  }
  /**
   * Stream the safe account projection.
   * @param signal - stream lifetime.
   * @returns initial snapshot and subsequent changes.
   */
  // 以流的形式输出安全账户投影：初始快照及后续变化。
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<AccountView> { return this.ctx.deepseekAccount.watch(signal) }
}
export default AccountController
