/**
 * The JavaScript API over the prebuilt `landlock-run` launcher: resolve the
 * binary for this host, build its grant argv, and run its functional probe.
 *
 * This module owns the launcher's CLI contract (`docs/cli-contract.md`) so
 * consumers never parse launcher output or spell launcher flags themselves —
 * the contract and the binaries version together in one package family,
 * which makes probe-parsing drift against the binary structurally
 * impossible. Policy stays with the consumer: this package does not know
 * what a "sandbox mode" is, only which paths are granted read or write.
 *
 * Deliberately no environment-variable overrides anywhere in this module:
 * which binary confines a process must never be decidable by the ambient
 * environment. Test injection is by function parameter.
 */
// 本模块是预构建 `landlock-run` 启动器之上的 JavaScript API（详见上方英文说明）：
// 负责为本主机解析二进制、构造授权 argv、运行功能探针，并独占启动器的 CLI 契约；
// 刻意不提供任何环境变量覆盖——哪个二进制来限制进程绝不能由环境决定。
import { spawnSync } from 'node:child_process'
// 导入 spawnSync：同步启动探针子进程。
import { createRequire } from 'node:module'
// 导入 createRequire：在 ESM 中解析平台包的 package.json。
import { dirname, join } from 'node:path'
// 导入路径工具：取目录名与拼接路径。
import { fileURLToPath } from 'node:url'
// 导入 fileURLToPath：把 file: URL 转成本地路径（用于构造回退路径）。

/** The launcher binary's file name inside each platform package's `bin/`. */
// 启动器二进制在各平台包 `bin/` 目录内的文件名。
export const LAUNCHER_BIN = 'landlock-run'

/**
 * The exit code for every launcher-level failure (usage error, unenforcing
 * kernel, unopenable grant root, failed exec). After a successful `exec`, the
 * wrapped command may also return 125, so consumers also require a matching
 * launcher-owned fatal diagnostic to attribute launcher failure. Part of the
 * CLI contract.
 */
// 启动器级失败的统一退出码（CLI 契约的一部分；成功 exec 后被包裹命令也可能返回 125，
// 因此消费方还需匹配启动器自有的致命诊断才能归因为启动器失败）。
export const LAUNCHER_FAILURE_EXIT = 125

/**
 * The probe's verdict on this host: `full` when the running kernel enforces
 * every access the launcher can govern, `partial` when an older Landlock ABI
 * governs only a subset (still confined for everything it supports), and
 * `unusable` when nothing can be enforced — a kernel without Landlock, a
 * disabled LSM, or a missing binary, all indistinguishable on purpose
 * because the consumer's answer is the same: do not trust this launcher.
 */
// 探针对当前主机的判定：full 完全强制；partial 旧版 Landlock ABI 仅强制子集；
// unusable 完全无法强制（无 Landlock、LSM 被禁用或二进制缺失，刻意不区分）。
export type LandlockEnforcement = 'full' | 'partial' | 'unusable'

/**
 * Filesystem grants for one confined run. Everything not granted is denied —
 * Landlock rulesets are allow-lists.
 */
// 一次受限运行的文件系统授权：Landlock 规则集是允许清单（allow-list），未授权即拒绝。
export interface LauncherGrants {
  /** Roots granted read + execute beneath (the launcher's `--ro`). */
  readonly readOnly?: readonly string[]
  /** Roots granted full filesystem access beneath (the launcher's `--rw`). */
  readonly readWrite?: readonly string[]
}

/**
 * Path of the launcher binary for this host: resolved from the per-platform
 * npm package `@deepseek-ai/node-addon-system-<platform>-<arch>` (npm's
 * `os`/`cpu` fields make installers fetch only the matching one). When the
 * package is not resolvable — a platform without one, or an install that
 * skipped the optional dependency — the returned fallback path points inside
 * this package's own `node_modules` and simply never exists. Existence is
 * deliberately not checked either way: {@link probe} is the single
 * availability signal (a missing binary probes `unusable` the same way an
 * unenforcing kernel does).
 * @param resolvePackageJson - test hook over `require.resolve` (the default
 *   covers real installs); receives the platform package's `package.json`
 *   specifier and returns its absolute path, throwing when unresolvable.
 * @returns the absolute launcher path to probe and exec.
 */
// 解析本主机启动器二进制的绝对路径（详见上方英文说明）；不可解析时回退到一个
// 必然不存在的包内路径，可用性判断统一交给 probe。
export function launcherPath(
  resolvePackageJson: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string {
  // 按平台与架构拼出可选依赖包名（npm 的 os/cpu 字段保证只安装匹配平台的包）。
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`
  try {
    // 解析平台包的 package.json，并指向其 bin 目录下的启动器二进制。
    return join(dirname(resolvePackageJson(`${platformPackage}/package.json`)), 'bin', LAUNCHER_BIN)
  } catch {
    // Unresolvable platform package: no such package exists for this host, or
    // it was not installed. Fall back to the path pnpm's layout WOULD use —
    // absolute, inside this package's boundary (never cwd-relative: a
    // spawnable relative path here would hand cwd control over which binary
    // confines), and nonexistent exactly when the package is absent.
    // 平台包不可解析（本主机没有对应包或未安装可选依赖）时，回退到 pnpm 布局
    // “本应使用”的绝对路径：位于本包边界内、绝不相对 cwd，且仅在包缺失时不存在。
    return fileURLToPath(new URL(`../node_modules/${platformPackage}/bin/${LAUNCHER_BIN}`, import.meta.url))
  }
}

/**
 * The launcher grant arguments for one set of filesystem grants — everything
 * before the `--` argv separator. A caller spawns
 * `[launcherPath(), ...grantArgs(grants), '--', ...command]`; the flag
 * spellings stay private to this package.
 * @param grants - the read-only and read-write roots to allow.
 * @returns the `--ro <path>` / `--rw <path>` argument list, read-only roots
 *   first, in the caller's order.
 */
// 为一组文件系统授权生成启动器参数（`--` 分隔符之前的部分）；参数拼写仅本包可见。
export function grantArgs(grants: LauncherGrants): string[] {
  return [
    // 把只读根展开为成对的 `--ro <路径>` 参数。
    ...(grants.readOnly ?? []).flatMap(root => ['--ro', root]),
    // 把读写根展开为成对的 `--rw <路径>` 参数。
    ...(grants.readWrite ?? []).flatMap(root => ['--rw', root]),
  ]
}

/**
 * Functional probe: `landlock-run --probe` builds and enforces a maximal
 * ruleset in a short-lived child and exits 0 only when the running kernel
 * actually enforces it — `--version`-style checks would miss a kernel that
 * has the syscalls but refuses enforcement. The probe's one report line is
 * part of the CLI contract and distinguishes complete from per-ABI-subset
 * enforcement; a zero exit without the partial marker reads as `full`. A
 * failed or timed-out spawn (missing binary, wrong architecture, unenforcing
 * kernel) probes `unusable`. Synchronous by design: consumers run it once
 * and cache the verdict.
 * @param launcher - the launcher path to probe; defaults to
 *   {@link launcherPath}'s resolution for this host.
 * @param options - `timeoutMs` bounds the probe child (default 2000).
 * @returns the enforcement verdict for this host.
 */
// 功能探针：真正构建并强制一个最大规则集，而不是仅查版本（详见上方英文说明）；
// 同步执行，消费方只跑一次并缓存结论。
export function probe(
  launcher: string = launcherPath(),
  options: { timeoutMs?: number } = {},
): LandlockEnforcement {
  // 同步启动探针子进程：只捕获 stdout，忽略 stdin/stderr，并施加超时。
  const result = spawnSync(launcher, ['--probe'], {
    timeout: options.timeoutMs ?? 2000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // 非零退出（二进制缺失、架构不符、内核不强制或超时）一律判定为不可用。
  if (result.status !== 0) return 'unusable'
  // 报告行含 partial 标记则为部分强制；零退出且无该标记读取为完全强制。
  return /partially enforced/.test(result.stdout) ? 'partial' : 'full'
}
