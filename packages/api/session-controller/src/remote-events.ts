// 模块说明：类型扩充文件——把 Session Controller 的五个 api-session/* 事件登记进
// Typert 协议的远程事件选择（TypertRemoteEventSelection），供 Remote Event（远程事件）
// 装配按名称选用。
/** Session Controller events available to a Remote Event assembly. */
type SessionControllerRemoteEvent =
  | 'api-session/activity' // 会话活动事件：Session 有新的活动记录
  | 'api-session/added' // 会话新增事件：出现了一个新 Session
  | 'api-session/error' // 会话错误事件：Session 处理过程中发生错误
  | 'api-session/removed' // 会话移除事件：Session 被删除
  | 'api-session/status' // 会话状态事件：Session 状态发生变化

// 通过模块声明扩充（declare module）扩展 Typert 协议包的远程事件选择接口，
// 让本包声明的这五个事件名被登记为可用的远程事件
declare module '@deepseek-ai/dsh-typert-protocol' {
  // 将五个事件名映射为 true，表示它们都在远程事件选择中被启用
  interface TypertRemoteEventSelection extends
    Record<SessionControllerRemoteEvent, true> {}
}

// 侧向类型扩充文件：导出空对象使本文件成为模块，从而让 declare module 生效
export {}
