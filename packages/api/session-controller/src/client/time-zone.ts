// 浏览器持有的时区（time-zone）采样：为一次 prompt RPC（远程过程调用）提供服务。
/** Browser-owned time-zone sampling for one prompt RPC. */

// 解析当前浏览器的 IANA 时区，供一次出站（outbound）操作使用。
/**
 * Resolve the current browser IANA zone for one outbound operation.
 * @returns The browser-provided canonical zone.
 * @throws when the runtime cannot provide a non-empty zone.
 */
export function resolvedClientTimeZone(): string {
  // 读取运行时 Intl.DateTimeFormat 已解析的选项，取其中的 timeZone 字段。
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  // 校验时区必须是非空字符串，防止运行时返回 undefined 或空串。
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    // 时区不可得时直接抛错，让调用方感知环境异常，而不是携带缺失的时区出站。
    throw new Error('browser time zone is unavailable')
  }
  // 返回浏览器提供的规范（canonical）时区名。
  return timeZone
}
