/** Private production entry bundled into the plain-Node terminal I/O worker. */
// 私有生产入口：把 LocalPtySession（本地 PTY 会话实现）转出，供纯 Node 终端 I/O 基准 worker（worker 子进程）打包使用。
export { LocalPtySession } from '../../packages/terminal/terminal-bash/src/session.ts'
