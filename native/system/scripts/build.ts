/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; flock uses stable Node-API with separate Linux libc builds.
 * Node headers come from the Node installation running this script.
 */
// 构建本主机声明要构建的系统二进制（详见上方英文说明）：landlock-run 是静态 musl
// 可执行文件；flock 使用稳定版 Node-API，Linux 上按 C 库分别构建；Node 头文件取自
// 运行本脚本的 Node 安装。
import { spawnSync } from 'node:child_process'
// 导入 spawnSync：同步调用编译器。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
// 导入文件系统工具：存在性检查、建目录、临时目录、列目录、读文件、原子重命名与删除。
import { basename, dirname, join, resolve } from 'node:path'
// 导入路径工具。
import { parseArgs } from 'node:util'
// 导入 parseArgs：解析命令行参数。

// 仓库根目录（本脚本位于 scripts/ 下，取上一级）。
const root = resolve(import.meta.dirname, '..')
// 解析命令行；仅允许 --host-addon-only 布尔开关，不接受位置参数。
const { values } = parseArgs({ options: { 'host-addon-only': { type: 'boolean' } }, allowPositionals: false })
const hostAddonOnly = values['host-addon-only'] === true
// 工具名到 C 源文件路径的映射。
const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  flock: 'packages/entry/src/flock.c',
}

// prebuilds.json 中单个二进制目标的描述。
interface Binary {
  tool: string
  // 使用的工具名（映射到 sources 中的源文件）。
  kind: string
  // 目标种类：static-musl（静态可执行）或 node-api（Node-API 插件）。
  path: string
  // 产物相对包目录的输出路径。
  napi?: number
  // 要求的 Node-API 版本。
  libc?: string
  // Linux 下要求的 C 库（glibc/musl）。
}

// 本脚本只支持在 Linux/macOS 上运行；host-addon-only 模式下静默退出，否则报错。
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  if (hostAddonOnly) process.exit(0)
  throw new Error('build: system binaries are built on Linux or macOS; no native target for this host')
}
// 主机标识：平台-架构。
const host = `${process.platform}-${process.arch}`
// Linux 上按运行时 glibc 版本判定 libc（有版本即 glibc，否则 musl）；非 Linux 为 undefined。
const libc = process.platform === 'linux'
  ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
  : undefined
// Node 开发头文件目录（node_api.h 所在），来自当前 Node 安装。
const headers = resolve(dirname(process.execPath), '../include/node')
// 已构建目标计数。
let built = 0

// 遍历 packages/ 下每个包（按名称排序保证构建顺序确定）。
for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name)
  // 包的预构建声明文件路径。
  const metadata = join(dir, 'prebuilds.json')
  // 未声明预构建的包直接跳过。
  if (!existsSync(metadata)) continue
  // 读取声明：目标平台与二进制目标列表。
  const spec = JSON.parse(readFileSync(metadata, 'utf8')) as { platform: string; binaries: Binary[] }
  // 声明平台与本主机不符的包跳过。
  if (spec.platform !== host) continue

  for (const binary of spec.binaries) {
    // host-addon-only 模式下只保留 node-api 且 libc 匹配（或未指定 libc）的目标。
    if (hostAddonOnly && (binary.kind !== 'node-api' || (binary.libc !== undefined && binary.libc !== libc))) continue
    // 查找工具对应的源文件；未知工具直接报错。
    const source = sources[binary.tool]
    if (source === undefined) throw new Error(`build: unknown tool ${binary.tool}`)
    // 计算产物输出路径，并确保其目录存在。
    const output = join(dir, binary.path)
    mkdirSync(dirname(output), { recursive: true })
    let compiler: string
    let flags: string[]

    // 分支一：Linux 上 landlock-run 的静态 musl 可执行文件。
    if (binary.kind === 'static-musl' && process.platform === 'linux' && binary.tool === 'landlock-run') {
      compiler = 'musl-gcc'
      // C11 标准、体积优先优化、全部警告视为错误、静态链接并剥离符号。
      flags = ['-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-static', '-s']
    } else if (binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8) {
      // 分支二：flock 的 Node-API 8 插件；先确认开发头文件存在。
      if (!existsSync(join(headers, 'node_api.h'))) {
        throw new Error(`build: Node-API headers missing at ${headers}; use a Node installation with development headers`)
      }
      // Linux 的 musl 目标用 musl-gcc 编译，其余用系统 cc。
      compiler = process.platform === 'linux' && binary.libc === 'musl' ? 'musl-gcc' : 'cc'
      // C11、O2、警告即错误、位置无关代码、隐藏符号可见性、固定 NAPI 版本并指定头文件目录。
      flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers]
      if (process.platform === 'darwin') {
        // macOS：不允许为插件选择 Linux libc；以 bundle 方式链接并动态查找符号。
        if (binary.libc !== undefined) throw new Error('build: macOS flock does not select a Linux libc')
        flags.push('-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0')
      } else {
        // Linux：必须显式选择 glibc 或 musl，并构建共享库。
        if (binary.libc !== 'glibc' && binary.libc !== 'musl') {
          throw new Error('build: Linux flock must select glibc or musl')
        }
        flags.push('-shared')
      }
    } else {
      // 其余工具/种类组合在本主机上不受支持。
      throw new Error(`build: unsupported ${binary.tool}/${binary.kind} target on ${host}`)
    }

    // 在 .release 下创建一次性临时目录：先编译到临时位置，再原子落位到最终路径。
    mkdirSync(join(root, '.release'), { recursive: true })
    const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
    try {
      // 临时产物路径（与最终产物同名）。
      const pending = join(temporary, basename(output))
      // 同步调用编译器输出到临时路径；继承 stdio 以实时透传编译输出。
      const result = spawnSync(compiler, [...flags, '-o', pending, join(root, source)], { stdio: 'inherit' })
      // spawn 本身失败（如编译器不存在）直接抛出。
      if (result.error) throw result.error
      // 编译器以非零状态退出则报构建失败。
      if (result.status !== 0) throw new Error(`build: ${compiler} failed for ${binary.path}`)
      // Readers never see a truncated addon when source checks build concurrently.
      // 同一文件系统内原子重命名落位：并发构建时读取者绝不会看到被截断的插件。
      renameSync(pending, output)
    } finally {
      // 无论成败都清理临时目录。
      rmSync(temporary, { recursive: true, force: true })
    }
    // 打印构建结果并累加计数。
    console.log(`build: built ${basename(dir)}/${binary.path}`)
    built++
  }
}
// 一个目标都没构建说明声明与本主机不匹配，视为配置错误。
if (built === 0) throw new Error(`build: no declared binaries for ${host}`)
