/** Lazy POSIX flock entry; importing it does not load a native addon. */
// 延迟加载的 POSIX flock 入口：仅导入本模块不会加载任何原生插件（native addon）。
import { createRequire } from 'node:module'
// 导入 createRequire：在 ESM 中解析并加载原生插件包。
import { dirname, join } from 'node:path'
// 导入路径工具：取目录名与拼接路径。
import { getSystemErrorName } from 'node:util'
// 导入 getSystemErrorName：把 errno 映射为系统错误名（如 EAGAIN）。

// 原生插件（.node 二进制）暴露的最小绑定接口。
interface FlockBinding {
  // 对描述符 fd 尝试加锁；回调携带 errno：0 表示成功，负值表示失败。
  tryLock(fd: number, callback: (errno: number) => void): void
}

let binding: FlockBinding | undefined
// 缓存已加载的原生绑定；undefined 表示尚未加载（惰性单例）。

function loadBinding(): FlockBinding {
  // 命中缓存则直接返回，保证只加载一次。
  if (binding) return binding
  // 读取当前平台与架构，用于选择对应的插件包。
  const { platform, arch } = process
  // 仅支持 Linux 与 macOS；其余平台抛出带错误码的受控错误。
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }

  let filename = 'system.node'
  // 默认要加载的插件文件名为 system.node。
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    // Linux 上需按 C 库（glibc/musl）选择子目录；Node 的 report 类型缺少 libc 字段，故做类型断言。
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    // 运行时报告携带 glibc 版本则用 glibc 子目录，否则按 musl 处理。
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  // 以本模块为基准创建 require，从而解析依赖树内的插件包。
  const require = createRequire(import.meta.url)
  // 解析平台专属插件包的 package.json 清单路径。
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  // 从该包的 bin 目录加载 .node 二进制并写入缓存。
  binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
  return binding
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
// 对调用方的描述符尝试独占、非阻塞的 POSIX flock（详见上方英文说明）。
export async function tryLockExclusive(fd: number): Promise<void> {
  // 调用原生绑定发起非阻塞 flock；Promise 以 errno 结算（0 为成功）。
  const errno = await new Promise<number>((resolve) => {
    loadBinding().tryLock(fd, resolve)
  })
  // errno 为 0 表示成功取得锁。
  if (errno === 0) return
  // 把负 errno 映射为系统错误名（如 EAGAIN/EWOULDBLOCK）。
  const code = getSystemErrorName(-errno)
  // 抛出携带 code、errno 与 syscall 字段的系统错误。
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  })
}
