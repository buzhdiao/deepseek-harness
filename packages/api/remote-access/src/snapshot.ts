// 本模块定义承载页面“首次访问快照”（first access snapshot）的全局索引键：
// 由写入该键的 Host 注入行与读取该键的 Client 挂载逻辑共享。
/**
 * The index global carrying a page's first access snapshot, shared by the
 * Host row that writes it and the Client mount that reads it.
 * @module @deepseek-ai/dsh-api-remote-access/src/snapshot
 */

// 索引注入行写入页面全局对象（globalThis）时使用的属性名，作为页面打开时的基线快照存放位置。
/** `globalThis` property an index injection row assigns to the page's opening baseline. */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__DSH_REMOTE_ACCESS__'
