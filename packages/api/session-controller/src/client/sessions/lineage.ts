// flattenLineage：把摘要列表压平为带谱系缩进的展示列表（纯函数）。
// flattenLineage: summaries -> flat list with lineage indentation (pure function).
// The input order is authoritative; lineage only makes each child adjacent to its parent.
// Orphaned lineage degrades to root level; cycles fail soft and emit as roots.

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryValues } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionSummary } from '../../types.ts'

// 附加了最新 Session Controller 标题投影的 Host 列表摘要。
/** Host list summary enriched with the latest Session Controller title projection. */
export interface TitledSessionSummary extends SessionSummary {
  // 最新标题（可能来自标题投影）。
  title?: string
  // 该行的摘要投影值，绝不是完整投影集；已连接会话的本地存储可能持有更多值，但那些在列表契约之外。
  /**
   * The row's summary projection values, never the full projection set. A
   * connected Session's client store may hold more values from its
   * control/follow baseline; those are outside the list contract and must not
   * be read here.
   */
  projectionValues?: Readonly<Partial<SessionProjectionSummaryValues>>
}

// 带谱系（lineage）深度的压平后列表行。
/** One flattened session-list row with lineage depth. */
export interface SessionListEntry {
  // 会话身份。
  sessionId: SessionId
  // 展示标题（可选）。
  title?: string
  // 最近活动时间。
  updatedAt: number
  // Agent 是否运行中。
  running: boolean
  // 新会话呈现与复用资格，与 sessionListMetadata 调和；列表隐藏空白会话（过滤留给消费者）。
  /**
   * New Session presentation and reuse eligibility, reconciled with
   * `sessionListMetadata`; lists hide blank sessions (filtering stays with the consumer).
   */
  blank: boolean
  // 父会话 id（子代理时存在）。
  parentSessionId?: SessionId
  // 粗粒度持久来源标记，用于导航过滤；不代表续写能力。
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  // Host 列表提供的格式分类。
  /** Format classification supplied by the Host list. */
  formatStatus?: SessionSummary['formatStatus']
  // 工作目录。
  cwd?: string
  // 该行的摘要投影值，绝不是完整投影集；见 TitledSessionSummary.projectionValues。
  /**
   * The row's summary projection values, never the full projection set; see
   * `TitledSessionSummary.projectionValues`.
   */
  projectionValues?: Readonly<Partial<SessionProjectionSummaryValues>>
  // 谱系缩进深度：根为 0；UI 只需乘以缩进宽度。
  /** Lineage indent depth: root = 0; the UI just multiplies by the indent width. */
  depth: number
}

// 摘要列表 → 带谱系缩进的压平列表；根与兄弟顺序遵循既定输入顺序，绝不按可变时间戳重排已水合的列表。
/**
 * Summaries -> flat list with lineage indentation. Root and sibling order
 * follows the established input order; this projection never re-sorts a
 * hydrated list from mutable timestamps.
 * @param summaries - the host's session.list items.
 * @returns display rows in render order.
 */
export function flattenLineage(
  summaries: readonly TitledSessionSummary[],
): SessionListEntry[] {
  // 身份 → 摘要 的索引，用于父节点存在性判断。
  const byId = new Map<SessionId, TitledSessionSummary>()
  // 填充索引。
  for (const s of summaries) byId.set(s.sessionId, s)

  // 父 id → 子摘要列表。
  const children = new Map<SessionId, TitledSessionSummary[]>()
  // 根（含降级的孤儿）列表。
  const roots: TitledSessionSummary[] = []
  // 按输入顺序分拣：子代理挂到父节点，其余进根。
  for (const s of summaries) {
    // Historical ordinary forks may retain a parent id without being subagents.
    // 历史上的普通 fork 可能保留父 id 但并非子代理。
    if (s.origin === 'subagent' && s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
      // 取该父节点的子列表（无则建空数组）。
      const list = children.get(s.parentSessionId) ?? []
      // 追加到父节点的子列表。
      list.push(s)
      // 写回映射。
      children.set(s.parentSessionId, list)
    } else {
      // 根节点，或父节点不在摘要中的孤儿（降级为根，绝不丢弃）。
      roots.push(s) // root, or an orphan whose parent is absent from summaries (degrade to root, never drop)
    }
  }

  // 输出：渲染顺序的行列表。
  const out: SessionListEntry[] = []
  // 已访问集合：环（cycle）检测。
  const visited = new Set<SessionId>()
  // 深度优先遍历：先输出当前行，再递归输出子行。
  const walk = (s: TitledSessionSummary, depth: number): void => {
    // 环：该行已在更上层输出过，跳过并告警（环成员稍后作为根输出）。
    if (visited.has(s.sessionId)) {
      console.warn(`[session-controller] lineage cycle at ${s.sessionId}; emitting as root`)
      return
    }
    // 标记已访问。
    visited.add(s.sessionId)
    // 剥离仅供列表过滤使用的 agentAvailable 字段，其余原样进入行。
    const { agentAvailable: _agentAvailable, ...row } = s
    // 输出行：保留原有字段并附上缩进深度。
    out.push({
      ...row,
      depth,
    })
    // 取子列表。
    const kids = children.get(s.sessionId)
    // 叶子节点：遍历结束。
    if (kids === undefined) return
    // 递归输出子行，深度加一。
    for (const kid of kids) walk(kid, depth + 1)
  }
  // 从每个根开始遍历。
  for (const root of roots) walk(root, 0)
  // Cycle members (unreachable from any root): emit as roots so no entry is lost.
  // 环成员（从任何根都不可达）：作为根输出，保证不丢行。
  for (const s of summaries) {
    // 未被遍历到的行：作为根输出。
    if (!visited.has(s.sessionId)) walk(s, 0)
  }
  // 返回渲染顺序列表。
  return out
}
