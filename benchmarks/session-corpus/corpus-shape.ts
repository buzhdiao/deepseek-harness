/** Per-Session length targets for the synthetic Session corpus. */
// 文件头（JSDoc 补充）：合成会话语料（corpus）中每个会话的长度目标。

/**
 * Upper-quantile anchors, in percent, of the measured corpus distribution.
 * Each anchor pairs with one entry of every dimension table below.
 */
// 中文补充（JSDoc）：实测语料分布的上侧分位点锚点（anchor），单位为百分位。
// 中文补充（JSDoc）：每个锚点与下方各维度表中的一条数据一一配对。
const QUANTILES = [10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 92, 94, 96, 97, 98, 99, 99.3, 99.6, 99.8, 99.9, 100] as const

/**
 * Aggregate quantiles of 1,650 local DSH Sessions measured on 2026-09-28
 * (newest generation per Session; top-level and subagent Sessions together).
 * Only counts and byte totals were extracted; no content, identity, or path.
 */
// 中文补充（JSDoc）：2026-09-28 对 1650 个本地 DSH 会话实测的聚合分位数
// 中文补充（JSDoc）：（每个会话取最新一代；顶层会话与子代理会话合并统计）。
// 中文补充（JSDoc）：仅提取计数与字节总量；不含任何内容、身份或路径信息。
const MEASURED = {
  /** Logical events, expanding compact delta rows to their event count. */
  // 中文补充（字段 JSDoc）：逻辑事件数——把压缩的 delta 行展开为其对应的事件数。
  events: [22, 22, 27, 32, 53, 63, 84, 154, 251, 387, 709, 975, 1398, 2398, 2652, 3492, 7229, 11620, 21995, 26580, 60699, 84467],
  /** Decompressed JSONL bytes including the header line. */
  // 中文补充（字段 JSDoc）：解压后 JSONL 的字节数（含头行）。
  logicalBytes: [
    37_233, 46_642, 54_432, 67_432, 86_195, 95_561, 184_414, 572_320, 882_968, 1_250_060, 1_849_503,
    2_341_019, 2_849_779, 3_902_295, 4_874_426, 6_691_370, 8_479_554, 10_570_582, 13_024_700, 17_646_397,
    21_225_976, 48_139_877,
  ],
  /** Started turns. */
  // 中文补充（字段 JSDoc）：已开始的回合数。
  turns: [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 4, 5, 7, 9, 11, 18, 20, 23, 39, 118, 2181],
} as const

/** Minimum length of one synthetic Session. */
// 中文补充（接口 JSDoc）：单个合成会话的最小长度要求。
export interface SessionShape {
  /** Index of the measured anchor; Sessions with one anchor share one shape. */
  // 中文补充（字段 JSDoc）：实测锚点下标；共用一个锚点的会话形态相同。
  readonly anchor: number
  /** Logical events the Session must contain at least. */
  // 中文补充（字段 JSDoc）：会话至少要包含的逻辑事件数。
  readonly events: number
  /** Decompressed log bytes the Session must contain at least. */
  // 中文补充（字段 JSDoc）：会话至少要包含的解压日志字节数。
  readonly logicalBytes: number
  /** Completed turns. */
  // 中文补充（字段 JSDoc）：已完成的回合数。
  readonly turns: number
}

/** Number of measured anchors, and therefore of distinct Session shapes. */
// 中文补充（常量 JSDoc）：实测锚点数量，也就是不同会话形态（shape）的数量。
export const ANCHOR_COUNT = QUANTILES.length

/**
 * Read the length targets of one measured anchor.
 * @param anchor - zero-based anchor index.
 * @returns the anchor's minimum event, byte, and turn counts.
 */
// 中文补充（JSDoc）：读取某个实测锚点的长度目标。
// 中文补充（JSDoc）：@param anchor —— 从 0 起算的锚点下标。
// 中文补充（JSDoc）：@returns —— 该锚点的最小事件数、字节数与回合数。
export function anchorShape(anchor: number): SessionShape {
  // 下标必须是非负整数且落在锚点范围内。
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= ANCHOR_COUNT) {
    throw new Error(`corpus anchor ${String(anchor)} does not exist`)
  }
  // 从实测表中取出三个维度的最小值。
  return {
    anchor,
    events: MEASURED.events[anchor] as number,
    logicalBytes: MEASURED.logicalBytes[anchor] as number,
    turns: MEASURED.turns[anchor] as number,
  }
}

/**
 * Select the length targets for one rank of an ascending corpus.
 *
 * Every dimension uses the next measured anchor at or above the rank's
 * quantile, so each quantile of the generated corpus is at least the measured
 * one. Dimensions share the rank, so a long Session is long in every dimension.
 * @param rank - zero-based ascending length rank.
 * @param count - corpus size.
 * @returns the rank's minimum event, byte, and turn counts.
 */
// 中文补充（JSDoc）：为升序语料中的某个名次（rank）选取长度目标。
// 中文补充（JSDoc）：每个维度都取"不小于该名次分位数"的下一个实测锚点，
// 中文补充（JSDoc）：因此生成语料的每个分位数都不低于实测值；各维度共享名次，长会话在每个维度都长。
// 中文补充（JSDoc）：@param rank —— 从 0 起算的升序长度名次。
// 中文补充（JSDoc）：@param count —— 语料总量。
// 中文补充（JSDoc）：@returns —— 该名次的最小事件数、字节数与回合数。
export function sessionShape(rank: number, count: number): SessionShape {
  // 名次换算为百分位分位数（1..100 区间上的位置）。
  const quantile = (100 * (rank + 1)) / count
  // 找到第一个不小于该分位数的实测锚点。
  const anchor = QUANTILES.findIndex(value => value >= quantile)
  // 名次非法或超出语料规模时抛错。
  if (!Number.isInteger(rank) || rank < 0 || anchor === -1) {
    throw new Error(`corpus rank ${String(rank)} is outside a ${String(count)}-Session corpus`)
  }
  return anchorShape(anchor)
}
