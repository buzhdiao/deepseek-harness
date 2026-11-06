/** Stable identity and released storage location for the Session-opening workload. */

import { join } from 'node:path'

/** Session id encoded in the fixture and used for every measured open. */
// 固化在测试夹具（fixture）中、每次被测打开都会用到的会话 id。
export const SYNTHETIC_SESSION_ID = 'bench-session'
/** Stable logical working directory encoded in the fixture header. */
// 固化在夹具会话头中的稳定逻辑工作目录（cwd）。
export const SYNTHETIC_SESSION_CWD = '/bench'
/** Storage directory derived from the fixture's cwd and Session id. */
// 由夹具的 cwd 与会话 id 推导出的存储目录名。
export const SYNTHETIC_SESSION_DIRECTORY = join('--bench--', SYNTHETIC_SESSION_ID)
/** Canonical released-v0 Zstandard generation filename. */
// released-v0 代（generation）的规范 Zstandard 压缩文件名。
export const SYNTHETIC_V0_FILENAME = 'session.jsonl.zstd'
