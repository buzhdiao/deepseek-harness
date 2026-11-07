// 合并权威基线（baseline），但不挪动客户端已可见的身份；仅基线持有的身份按后继已知身份就近插入，基线中消失的身份被移除。
/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  // 基线行按身份键建索引。
  const baselineByKey = new Map<unknown, T>()
  // 后写覆盖先写：同一身份以基线末次出现的行为准。
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  // 第一遍：按现有顺序保留仍存在于基线的行，并替换为基线值。
  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  // 已合并身份集合，用于跳过重复插入。
  const mergedKeys = new Set(merged.map(keyOf))

  // 第二遍：按基线顺序插入仅基线持有的身份。
  for (let index = 0; index < baseline.length; index++) {
    // 当前基线行。
    const value = baseline[index]
    // 跳过空槽与已合并过的身份。
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    // 默认插到末尾（没有更靠后的已知身份时）。
    let insertion = merged.length
    // 向后扫描基线，寻找第一个已在合并结果中的身份。
    for (let following = index + 1; following < baseline.length; following++) {
      // 后继基线行。
      const candidate = baseline[following]
      // 跳过空槽。
      /* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
      if (candidate === undefined) continue
      // 该后继身份在合并结果中的位置。
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        // 找到已知后继：插到它前面，保持与基线的相对顺序。
        insertion = known
        break
      }
    }
    // 插入该身份。
    merged.splice(insertion, 0, value)
    // 标记为已合并。
    mergedKeys.add(keyOf(value))
  }
  return merged
}
