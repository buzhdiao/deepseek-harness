/** End-to-end SDK continuation through built dsh sdk-minimal with an explicitly mounted file editor. */
// 文件头（JSDoc 补充）：端到端（end-to-end）SDK 续跑基准——通过构建产物 dsh 的 sdk-minimal 配置（profile）运行，并显式挂载文件编辑器工具。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, resultText, WORKLOAD } from './workload.ts'

/** Parent-observed wall time, including profile launch and SDK shutdown. */
// 中文补充（接口 JSDoc）：由父进程观察到的墙钟耗时，包含 profile 启动与 SDK 关闭。
export interface ProfileReport {
  // 全程总耗时（毫秒）。
  readonly totalMs: number
  // 启动（boot）阶段耗时。
  readonly bootMs: number
  // 跑完所有回合的耗时。
  readonly turnsMs: number
  // 关闭（close）阶段耗时。
  readonly closeMs: number
  // 模型请求次数。
  readonly requests: number
  // 工具调用次数。
  readonly toolCalls: number
}

// 核心运行：在 root 目录下准备 home/workspace，写补丁文件，启动 harness 并跑完 profile 回合。
async function run(root: string): Promise<ProfileReport> {
  // SDK 的 HOME 目录与进程工作目录（cwd）分别放在 root 下的子目录中，保证隔离。
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  // 写入被读取的目标文件 synthetic.txt，内容为固定合成文本。
  await writeFile(join(cwd, 'synthetic.txt'), resultText(0))
  // 补丁（patch）文件路径：用于对 profile 做插件级覆盖。
  const patch = join(root, 'profile.patch.yml')
  await writeFile(patch, [
    // 禁用默认的 deepseek LLM 插件，换成基准合成模型。
    '- id: llm-deepseek', '  disabled: true',
    // 覆盖 sessions 插件配置：会话根目录指向本仓库隔离区，使用 zstd 压缩。
    '- id: sessions', '  config:', '    root: ' + JSON.stringify(join(root, 'profile-sessions')), '    compression: zstd',
    // 插入本地文件系统插件与生产版 str-replace-editor 工具（工具走真实生产插件）。
    '- insert:',
    '    - id: fs-local', "      name: '@deepseek-ai/dsh-fs-local'",
    '    - id: str-replace-editor', "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
    // 插入基准模型适配器（指向本目录编译产物 profile-adapter.js）。
    '    - id: benchmark-model', '      name: ' + JSON.stringify(join(import.meta.dirname, 'profile-adapter.js')),
    '',
  ].join('\n'))
  // 为 SDK 子进程构造受控环境变量：HOME/USERPROFILE 都指向隔离 home。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
  }
  // 实例化 SDK 客户端：指定 dsh 可执行文件、sdk-minimal profile、工作目录与超时参数。
  const harness = new DeepSeekHarness({
    dshBin: join(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'lib', 'bin.js'),
    profile: 'sdk-minimal', dshHome: home, processCwd: cwd, cwd,
    provider: 'bench', model: 'bench', patches: [patch], env,
    initializeTimeoutMs: 15_000, requestTimeoutMs: 15_000,
  })
  // 关闭动作只执行一次：closing 缓存首次 close 的 Promise，后续调用复用。
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= harness.close()
  // 是否因 40 秒截止时间（deadline）到而触发过取消。
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    // The awaited finally close below reports shutdown failures; this only requests cancellation.
    void close().catch(() => undefined)
  }, 40_000)
  // 本地统计的模型请求数与工具调用数。
  let requests = 0
  let toolCalls = 0
  // 墙钟计时起点。
  const start = performance.now()
  try {
    // 启动 SDK（含 profile 装配），记录启动完成时间。
    await harness.start()
    const booted = performance.now()
    // 逐个回合运行：每回合发一条"读取合成文件"的指令。
    for (let turn = 0; turn < WORKLOAD.profileTurns; turn++) {
      const result = await harness.run('Read the synthetic file ' + String(turn), { sessionId: PARENT_ID })
      // 统计 assistant/message 事件数，即本回合产生的模型请求数。
      requests += result.events.filter(event => event.type === 'assistant/message').length
      // 校验每个工具结果：必须是成功读取且内容包含标记文本的合成文件内容。
      for (const event of result.events) {
        if (event.type !== 'tool/result') continue
        const message = event.data.message
        if (message.isError || !message.content.some(block => block.type === 'text' && block.text.includes('export const synthetic = 42;'))) {
          throw new Error('profile benchmark did not read the synthetic file')
        }
        toolCalls++
      }
    }
    // 回合结束时间点。
    const turnsDone = performance.now()
    // 正常关闭 SDK。
    await close()
    const end = performance.now()
    // 完整性校验：不得超时，且请求数/工具调用数必须与负载定义完全一致。
    if (expired || requests !== WORKLOAD.profileTurns * 2 || toolCalls !== WORKLOAD.profileTurns * WORKLOAD.toolsPerLiveTurn) {
      throw new Error('profile benchmark did not finish every model request and real tool call')
    }
    // 汇总各阶段耗时报告。
    return { totalMs: end - start, bootMs: booted - start, turnsMs: turnsDone - booted, closeMs: end - turnsDone, requests, toolCalls }
  } finally {
    // 清理截止定时器，并兜底确保 harness 被关闭。
    clearTimeout(deadline)
    await close()
  }
}

// 断言以构建产物运行时 dsh-sdk-client 从真实解析地址加载。
assertBuiltBenchmarkRuntime(import.meta.url, { '@deepseek-ai/dsh-sdk-client': import.meta.resolve('@deepseek-ai/dsh-sdk-client') })
// 从命令行参数取运行目录。
const [root] = process.argv.slice(2)
// 缺参时报用法错误。
if (root === undefined) throw new Error('usage: profile-continuation.worker.js <root>')
// 执行并输出 JSON 报告。
process.stdout.write(JSON.stringify(await run(root)) + '\n')
