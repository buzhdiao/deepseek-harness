// 共享的 Session（会话）历史分页、地址校验与线上（wire）格式转换。
/** Shared Session history pagination, address validation and wire conversion. */

// 会话日志工具：追加表面事件判定与日志偏移品牌构造器。
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
// 会话核心类型：事件、头部、id、日志偏移与序号游标。
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
// SessionObservation（会话观察）：查询服务返回的观察快照类型。
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
// 副作用导入：拉取 subagent（子代理）相关的类型环境。
import type {} from '@deepseek-ai/dsh-subagent'
// RemoteError（远程错误）：跨端业务错误的标准载体。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// 本包类型：地址、事件条目、历史记录与线上事件。
import type {
  SessionAddress,
  SessionEventEntry,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionWireEvent,
} from './types.ts'

// 历史请求未指定 maxMessages（最大消息数）时应用的消息预算。
/** Message budget applied when a history request omits `maxMessages`. */
export const DEFAULT_MAX_MESSAGES = 50
// 计入消息预算的消息类型集合：用户消息与助手消息。
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Reject an invalid message budget or turn window.
 * @param request - history window fields.
 */
// 校验消息预算与轮次窗口（turn window），非法时直接拒绝。
export function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  // maxMessages 给出时必须是正的安全整数。
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  // 取出可选的轮次窗口。
  const window = request.turnWindow
  if (window !== undefined) {
    // minMessages 必须是正安全整数，且不得超过实际生效的消息预算。
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    // minTurns（最小轮次数）必须是正的安全整数。
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

/**
 * Select the Session whose log an address names.
 * @param address - ordinary Session or direct-subagent address.
 * @returns the Session whose log the address reads.
 */
// 解析地址（address）实际命中的日志所属会话：普通地址取 sessionId，子代理地址取 childSessionId。
export function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

/**
 * Reject an address that does not match the observed Session.
 * @param address - ordinary Session or direct-subagent address.
 * @param header - observed Session header.
 * @param inheritedEventCount - observed fork-inherited event count.
 * @param projections - observed projections; subagent addresses require them.
 */
// 校验地址与观察到的会话一致，不匹配则按地址类别抛出对应错误。
export function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  // 普通会话地址分支。
  if (address.kind === 'session') {
    // 子代理会话不接受普通地址，必须走持久化父地址。
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    // 普通地址与普通会话匹配，校验通过。
    return
  }
  // 子代理地址分支：头部必须是子代理来源，且父会话与地址声明一致。
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  // 读取子代理身份投影（projection）。
  const identity = projections?.values.subagent
  if (identity === null) {
    // 身份描述符损坏：给出诊断错误。
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    // 身份缺失或序号早于分叉继承边界：说明该部署不支持此子代理描述。
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    // 地址声明了具体模式但与身份不符：拒绝访问。
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

/**
 * Reject a missing Session using its address-specific error.
 * @param address - ordinary Session or direct-subagent address.
 * @returns never; this operation always throws.
 * @throws RemoteError `session/not-found` or `subagent/not-found`.
 */
// 会话缺失时的统一拒绝：按地址类别抛出对应的 not-found 错误。
export function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    // 普通会话未找到。
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  // 子代理不可用。
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

/**
 * Cut one message-aligned backwards page from a contiguous event prefix.
 * @param events - contiguous events starting at seq 0.
 * @param beforeSeq - exclusive upper offset of an older page.
 * @param maxMessages - message budget.
 * @param throughSeq - inclusive log cut.
 * @param turnWindow - optional turn-boundary stop rule.
 * @returns the page events and whether older events remain.
 */
// 从连续事件前缀中切出一条消息对齐的向后分页（backwards page）。
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  // 计算本页右端（不含）：throughSeq 的下一位，且受 beforeSeq 上界约束。
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  // 已计入的消息数。
  let count = 0
  // 已越过的轮次起点数。
  let turns = 0
  // 本页左端切点（含），初始为 0。
  let cut = SessionLogOffset(0)
  // 从右端向左扫描事件。
  for (let index = end - 1; index >= 0; index--) {
    // 取当前事件。
    const event = events[index] as SessionEvent
    // 有轮次窗口且遇到轮次起点时做停止判定。
    if (turnWindow !== undefined && event.type === 'turn/start') {
      turns++
      // 已满足最小消息数且达到最小轮次数：在此轮次边界切页。
      if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
        cut = SessionLogOffset(index)
        break
      }
    }
    // 非计费消息类型或非追加表面的事件不计入预算，继续左移。
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    // 取该消息引用的源事件序号（合并重试等来源）。
    const sources = event.sourceEventSeqs
    // 消息组起点默认为自身序号。
    let groupStart = event.seq
    if (sources !== undefined) {
      // 存在源引用时取最小序号，保证整组消息同页。
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    // 达到消息预算：在消息组起点处切页并停止。
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      break
    }
  }
  // 返回切出的页面与是否仍有更早的历史。
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/**
 * Convert a committed event to its wire entry.
 * @param event - committed Session event.
 * @returns the wire event entry.
 */
// 把一条已提交事件转换成线上（wire）事件条目。
export function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    // 条目类型：事件。
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    // 事件数据在发布前已由 Session.append 校验并冻结为 JSON，这里直接断言为线上事件。
    event: event as unknown as SessionWireEvent,
  }
}

/**
 * Encode one bounded logical page without changing its pagination cut.
 * @param events - page events.
 * @returns the wire records.
 */
// 把一页事件编码成线上记录序列，不改变分页切点。
export function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return events.map(entryFor)
}
