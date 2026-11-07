/**
 * Type face of the forwarded-Host-event allowlist: the consumer key projection
 * and the selection seat it fills. The allowlist VALUE lives in
 * `./remote-events.ts`, keeping this module type-only per the package
 * convention; both compiler faces list both files, so the Host forwarding loop
 * and the consumer `ctx.remote.$on` key face read one declaration instead of
 * two copies that could drift.
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

// 以类型方式引用转事件白名单常量（其值定义在 ./remote-events.ts），
// 用于派生允许转发的事件名的联合类型。
import type { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// 白名单的类型投影：取出每个白名单项的 event 字段类型（即事件名字符串字面量类型的联合），
// 消费端与 Host 转发循环都以此单一声明为准，避免两份副本漂移。
/** Type projection of the allowlist; the consumer and the Host read this one. */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

// 模块扩充（module augmentation）：向 typert 协议声明转发的远端事件选择面，
// 把每个白名单事件名映射为 true，从而约束消费端可订阅的事件集合。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
