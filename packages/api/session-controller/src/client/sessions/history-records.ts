// 对齐的 Session 历史记录（history record）的客户端范围访问与类型收窄。
/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'

// 把对齐的线记录收窄为客户端事件类型，不产生任何分配。
/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  // 记录结构与事件条目完全对齐：直接断言复用同一数组，零拷贝。
  return records as unknown as readonly SessionEventLikeEntry[]
}

// 读取一条线记录表示的首个逻辑序号。
/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  // 当前记录与事件一一对应：首序号即事件 seq。
  return record.event.seq
}

// 读取一条线记录表示的最后一个逻辑序号。
/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  // 同上：末序号也是事件 seq。
  return record.event.seq
}
