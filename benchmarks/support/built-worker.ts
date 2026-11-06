/** Plain-Node launcher for compiled benchmark workers. */

import { spawn } from 'node:child_process'

/** Process outcome and optional JSON report from one compiled benchmark worker. */
// 一次编译产物基准 worker 运行的进程结果与可选 JSON 报告。
export interface BuiltBenchmarkWorkerRun<Report> {
  // 成功退出时从标准输出解析出的报告；否则为 undefined。
  readonly report: Report | undefined
  // 退出码（被信号终止时为 null）。
  readonly exitCode: number | null
  // 终止信号（正常退出时为 null）。
  readonly signal: NodeJS.Signals | null
  // 是否因超过超时而强制终止（timed out）。
  readonly timedOut: boolean
  // 完整的标准错误输出。
  readonly stderr: string
}

/** Options for one isolated compiled benchmark process. */
// 一次隔离编译基准进程的启动选项。
export interface BuiltBenchmarkWorkerOptions {
  // 编译后的 worker 脚本路径（必须为 .js/.cjs）。
  readonly worker: string
  // 传给 worker 的命令行参数。
  readonly args?: readonly string[]
  // 超时上限（毫秒），到点强制终止。
  readonly timeoutMs: number
  // 是否附加 --expose-gc 以启用显式垃圾回收（GC）。
  readonly exposeGc?: boolean
  // V8 老生代（old space）上限（MB）。
  readonly heapLimitMb?: number
  /** Fixed semi-space size, so an allocation interval smaller than it runs without a scavenge. */
  // 固定的半空间（semi-space）大小（MB）：小于它的分配区间不会触发清理（scavenge）。
  readonly semiSpaceMb?: number
}

/**
 * Run one built JavaScript worker without a TypeScript runtime loader.
 * @param options - worker path, arguments, deadline, and optional V8 limits.
 * @returns child exit details and its final JSON-line report when successful.
 */
export function runBuiltBenchmarkWorker<Report>(
  options: BuiltBenchmarkWorkerOptions,
): Promise<BuiltBenchmarkWorkerRun<Report>> {
  // 只接受编译后的 JavaScript worker，拒绝源码路径。
  if (!options.worker.endsWith('.js') && !options.worker.endsWith('.cjs')) {
    throw new Error(`benchmark worker must be compiled JavaScript: ${options.worker}`)
  }
  // 复制当前环境变量，随后剔除会影响运行时的变量，保证测量环境纯净。
  const env = { ...process.env }
  // 清除 NODE_OPTIONS，避免外部注入的加载器或 V8 选项污染测量。
  delete env['NODE_OPTIONS']
  // 清除 tsx 的 tsconfig 指向，防止意外启用 TypeScript 运行时。
  delete env['TSX_TSCONFIG_PATH']
  // 返回 Promise：子进程结束时以完整结果 resolve。
  return new Promise((resolve, reject) => {
    // 以当前 Node 可执行文件启动 worker，并按选项附加 --expose-gc、堆上限与半空间大小。
    const child = spawn(process.execPath, [
      ...options.exposeGc === true ? ['--expose-gc'] : [],
      ...options.heapLimitMb === undefined
        ? []
        : [`--max-old-space-size=${String(options.heapLimitMb)}`],
      ...options.semiSpaceMb === undefined
        ? []
        : [`--min-semi-space-size=${String(options.semiSpaceMb)}`, `--max-semi-space-size=${String(options.semiSpaceMb)}`],
      options.worker,
      ...options.args ?? [],
    ], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 累积标准输出文本。
    let stdout = ''
    // 累积标准错误文本。
    let stderr = ''
    // 超时标记。
    let timedOut = false
    // 设置超时定时器：到点标记超时并强杀子进程。
    const timeout = setTimeout(() => {
      // 记录超时事实。
      timedOut = true
      // 以 SIGKILL 强制终止。
      child.kill('SIGKILL')
    }, options.timeoutMs)
    // 按 UTF-8 收集标准输出。
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    // 按 UTF-8 收集标准错误。
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    // 进程无法启动（spawn 失败）时清理并拒绝。
    child.once('error', (error) => {
      // 清除超时定时器。
      clearTimeout(timeout)
      // 以启动错误拒绝 Promise。
      reject(error)
    })
    // 进程退出（无论成败）时解析报告。
    child.once('close', (exitCode, signal) => {
      // 清除超时定时器。
      clearTimeout(timeout)
      // 取最后一条以 { 开头的输出行作为 JSON 报告行。
      const line = stdout.trim().split('\n').findLast(candidate => candidate.startsWith('{'))
      try {
        // 仅在成功退出且存在报告行时解析报告，否则为 undefined。
        const report = exitCode === 0 && line !== undefined
          ? JSON.parse(line) as Report
          : undefined
        // 以退出码、信号、超时标记、报告与 stderr 组成完整结果。
        resolve({ report, exitCode, signal, timedOut, stderr })
      } catch (error: unknown) {
        // 报告行不是合法 JSON 时拒绝。
        reject(error)
      }
    })
  })
}

/**
 * Reject a benchmark worker reached through source execution or a TypeScript loader.
 * @param moduleUrl - `import.meta.url` from the worker entry.
 * @param packageEntries - resolved production package entries used by the measured path.
 */
export function assertBuiltBenchmarkRuntime(
  moduleUrl: string,
  packageEntries: Readonly<Record<string, string>>,
): void {
  // worker 必须以 .js 形式从 benchmarks/.dsh-build 编译目录运行，而非源码执行。
  if (!moduleUrl.endsWith('.js') || !moduleUrl.includes('/benchmarks/.dsh-build/')) {
    throw new Error(`benchmark worker is not running from benchmarks/.dsh-build: ${moduleUrl}`)
  }
  // 检查 execArgv 中是否被注入了 tsx（TypeScript）加载器。
  const tsRuntime = process.execArgv.find(argument => /(?:^|[/\\])tsx(?:[/\\]|$)|tsx\/esm|tsx\/cjs/.test(argument))
  // 发现 TypeScript 加载器即失败：测量必须发生在编译产物上。
  if (tsRuntime !== undefined) throw new Error(`benchmark worker received a TypeScript loader: ${tsRuntime}`)
  // 逐个校验关键生产包都解析到其 lib 构建的 JavaScript 入口。
  for (const [specifier, entry] of Object.entries(packageEntries)) {
    // 未落在 lib/*.js 上说明测量路径用到了源码或中间产物，基准结果不可信。
    if (!/\/lib\/(?:[^/]+\/)*[^/]+\.js$/.test(entry)) {
      throw new Error(`benchmark package ${specifier} did not resolve to lib JavaScript: ${entry}`)
    }
  }
}
