// 原始 Session 日志响应的事件本地（event-local）校验；载荷仍是所有者定义的 JSON。
/** Event-local acceptance for raw Session journal responses; payloads remain owner-defined JSON. */

import { validateSessionEventData, validateSurfaceMetadata } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent } from '../types.ts'

// 拒绝非当前（non-current）事件信封，但不剥离或规范化任何线上字段；范围成员与源存在性需要持久日志，仍归 Host 所有。
/**
 * Reject non-current event envelopes without stripping or normalizing wire fields.
 * Range membership and source existence require the durable log and remain Host-owned.
 * @param value - one event received in a follow frame or history page.
 * @returns nothing after narrowing the accepted event envelope.
 * @throws when the envelope or current event-local metadata is invalid.
 */
export function assertSessionWireEvent(value: unknown): asserts value is SessionWireEvent {
  // 错误消息中的主体名。
  const subject = 'session wire event'
  // 必须是普通对象（非 null、非数组）。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
  // 以字段包的形式逐键检查。
  const event = value as Record<string, unknown>
  // 信封白名单：不允许任何额外字段。
  for (const key of Object.keys(event)) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'ignorable':
      case 'surfaceOp':
      case 'sourceEventSeqs':
        break
      default:
        // 未知字段直接拒绝，保持收窄后的信封形态可信。
        throw new Error(`${subject} has unexpected field ${key}`)
    }
  }
  // 取出 seq 供下方集中校验。
  const seq = event['seq']
  // 信封校验：type 为字符串、seq 为非负安全整数（排除 -0）、time 为安全整数、data 必须存在、ignorable 出现时只能为 true。
  if (typeof event['type'] !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof event['time'] !== 'number' || !Number.isSafeInteger(event['time'])
    || !Object.hasOwn(event, 'data') || event['data'] === undefined
    || (Object.hasOwn(event, 'ignorable') && event['ignorable'] !== true)) {
    // 任一校验失败：信封非法。
    throw new Error(`${subject} has an invalid envelope`)
  }
  // Event names and payloads are merge-extensible; only event-local owner rules run here.
  // 事件名与载荷是合并可扩展的；这里只运行事件本地的所有者规则。
  // 收窄为当前 Session 事件类型。
  const current = event as SessionEvent
  // 校验表面元数据（surface metadata）。
  validateSurfaceMetadata(current)
  // 按事件类型校验数据载荷。
  validateSessionEventData(current, subject)
}
