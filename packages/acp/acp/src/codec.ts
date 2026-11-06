/**
 * Pure translation between the harness lifecycle and the automation-only ACP wire.
 * @module @deepseek-ai/dsh-acp/codec
 */
// 在 harness 生命周期与仅面向自动化的 ACP 传输协议（wire）之间做纯转换的编解码模块。

import type { StopReason } from '@agentclientprotocol/sdk'
// 导入 ACP 的停止原因（StopReason）类型。
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
// 导入 harness 的回合结束原因（TurnEndReason）类型。

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
// 把 harness 的回合结束原因映射为 ACP 终止原因词汇表中最接近的合法值。
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    // 正常完成映射为 end_turn。
    case 'completed':
      return 'end_turn'
    // 达到 token 上限映射为 max_tokens。
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    // cancelled 专指客户端显式取消（session/cancel）与资源释放，两者均在带外结算；
    // 由钩子或其他所有者中止的回合只是普通静默，仍上报 end_turn。
    case 'aborted':
      return 'end_turn'
    // 用户中断才映射为 cancelled。
    case 'interrupted':
      return 'cancelled'
    // 被阻塞或出错都按正常结束上报 end_turn。
    case 'blocked':
    case 'error':
      return 'end_turn'
    // 兜底分支：TurnEndReason 可合并扩展；上面的分支已覆盖所有活动回合成员，
    // 仅种子（seed）专属的变体（如 forked）不会结束 ACP 提示回合。
    /* v8 ignore next 2 -- TurnEndReason is merge-extensible; every live-turn member is
     * handled above, and seed-only variants (`forked`) never end an ACP prompt turn. */
    default:
      return 'end_turn'
  }
}
