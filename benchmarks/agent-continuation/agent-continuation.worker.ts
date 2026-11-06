/** Plain-Node measurements of active request history and cold tool-heavy continuation. */
// 文件头（JSDoc 补充）：在纯 Node 环境（无浏览器）下测量"活跃请求历史构建"与"冷启动工具密集续跑"两项指标的 worker。

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, response, resultText, syntheticHistory, TIME_ZERO, WORKLOAD } from './workload.ts'

/** Raw timing and retained-memory report from one isolated backend process. */
// 中文补充（接口 JSDoc）：单个隔离后端进程产出的原始计时与内存保留报告。
export interface ContinuationReport {
  // 全程总耗时（毫秒）。
  readonly totalMs: number
  // 会话恢复（resume）阶段耗时。
  readonly resumeMs: number
  // 跑完所有回合（turn）的耗时。
  readonly turnsMs: number
  // 持久化刷写（flush）耗时。
  readonly flushMs: number
  // 用户态 CPU 时间（毫秒）。
  readonly cpuUserMs: number
  // 内核态 CPU 时间（毫秒）。
  readonly cpuSystemMs: number
  // 保留堆内存增量（MB）。
  readonly retainedHeapMb: number
  // 进程峰值常驻内存 RSS（MB）。
  readonly peakRssMb: number
  // 模型请求次数。
  readonly requests: number
  // 工具调用次数。
  readonly toolCalls: number
  // 会话事件（seq）总数。
  readonly events: number
}

// 合成 LLM 适配器（adapter）：不发起真实网络请求，按规则生成交互式响应。
class SyntheticAdapter extends LlmAdapter {
  // 已处理的模型请求计数。
  requests = 0
  constructor(private readonly toolsPerTurn: number) { super() }

  // 模型解析直接原样返回 provider 与 model，跳过真实解析逻辑。
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  // 流式生成：偶数次请求返回带工具调用的回复，奇数次返回纯文本回复。
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = this.toolsPerTurn > 0 && this.requests % 2 === 0 ? this.toolsPerTurn : 0
    const reply = response(100_000 + this.requests++, tools)
    yield* reply.chunks
  }
}

// 收集当前堆用量（MB）：先强制 GC，让事件循环跑一圈，再 GC 一次，最后读堆用量。
async function collectHeap(): Promise<number> {
  if (globalThis.gc === undefined) throw new Error('backend benchmark requires --expose-gc')
  globalThis.gc()
  await scheduler.yield()
  globalThis.gc()
  return process.memoryUsage().heapUsed / 1_048_576
}

// 播种（seed）模式：为指定根目录创建会话并写入合成历史。
async function seed(root: string): Promise<void> {
  const ctx = new Context()
  try {
    // 挂载 agent loop 的测试依赖（模拟 llm/tools/session 等服务）。
    await mountAgentLoopTestDependencies(ctx)
    // 注册 JSONL 会话持久化（persistence）插件，指定根目录与 zstd 压缩。
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    // 创建父会话记录：固定 ID、固定时间戳、工作目录 /bench、未播种标记。
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: PARENT_ID, createdAt: TIME_ZERO, cwd: '/bench', isSeeded: false,
    }, {})
    try {
      // 追加 WORKLOAD.historyTurns 个回合的合成历史并刷盘。
      await handle.append(syntheticHistory(WORKLOAD.historyTurns))
      await handle.flush()
    } finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
}

// 让 agent 连续跑 turns 个回合：每回合发起一条后续（followup）消息并等待 agent 空闲。
async function runTurns(agent: Agent, turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue synthetic task ' + String(turn) }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
}

// 核心测量：在指定根目录上按场景（request-history 或 tool-continuation）跑完整流程并计时。
async function measure(root: string, scenario: string): Promise<ContinuationReport> {
  const ctx = new Context()
  // agent 句柄（handle），用于最终清理。
  let handle: AgentHandle | undefined
  // 是否为工具续跑场景（决定适配器是否产生工具调用、跑多少回合）。
  const toolHeavy = scenario === 'tool-continuation'
  // 工具密集场景下每回合产生 toolsPerLiveTurn 次工具调用，否则不产生。
  const adapter = new SyntheticAdapter(toolHeavy ? WORKLOAD.toolsPerLiveTurn : 0)
  // 本地统计的工具调用次数。
  let toolCalls = 0
  try {
    // 挂载测试依赖、持久化插件与 AgentLoop 服务。
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await ctx.plugin(AgentLoop, { agents: [] })
    // 注册合成 LLM 适配器到 'bench' provider。
    ctx.effect(() => ctx.llm.registerAdapter(['bench'], adapter))
    // 注册名为 bench_tool 的内容型工具夹具（fixture）：调用时计数并返回定长文本。
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'bench_tool', description: 'Read a bounded synthetic module.',
      parameters: { ordinal: { type: 'number', required: true } },
      isConcurrencySafe: () => true,
      execute(args) {
        toolCalls++
        return Promise.resolve([{ type: 'text', text: resultText(args.ordinal) }])
      },
    })))
    // 非工具场景：把"恢复会话"从计时区外提前执行（基线请求历史只测请求构建，不测冷恢复）。
    if (!toolHeavy) {
      handle = await ctx.agents.resume({ resumeSessionId: PARENT_ID, agentOptions: { provider: 'bench', model: 'bench' } })
    }
    // 计时开始前先收集一次堆基线。
    const beforeHeap = await collectHeap()
    // 记录 CPU 时间起点（相对当前进程的差值基准）。
    const cpuStart = process.cpuUsage()
    // 墙钟计时起点。
    const start = performance.now()
    // 工具场景在此刻才恢复会话——测量的是冷启动恢复（cold resume）耗时。
    if (handle === undefined) {
      handle = await ctx.agents.resume({ resumeSessionId: PARENT_ID, agentOptions: { provider: 'bench', model: 'bench' } })
    }
    // 恢复结束时间点。
    const resumed = performance.now()
    // 跑完指定回合数（工具场景跑 continuationTurns，基线场景跑 requestTurns）。
    await runTurns(handle.agent, toolHeavy ? WORKLOAD.continuationTurns : WORKLOAD.requestTurns)
    // 回合结束时间点。
    const turnsDone = performance.now()
    // 强制把会话状态刷写到持久层。
    await ctx.sessions.flush(handle.agent.session)
    // 墙钟计时终点。
    const end = performance.now()
    // 计算 CPU 时间差（相对 cpuStart），得到本段代码消耗的 CPU。
    const cpu = process.cpuUsage(cpuStart)
    // 保留堆内存 = 测量结束后的堆用量 - 基线。
    const retainedHeapMb = (await collectHeap()) - beforeHeap
    // 完整性校验：模型请求数与工具调用数必须与预期完全一致，否则说明流程没跑满。
    if (adapter.requests !== (toolHeavy ? WORKLOAD.continuationTurns * 2 : WORKLOAD.requestTurns)
      || toolCalls !== (toolHeavy ? WORKLOAD.continuationTurns * WORKLOAD.toolsPerLiveTurn : 0)) {
      throw new Error('backend benchmark did not complete every requested model/tool step')
    }
    // 汇总报告：各阶段耗时、CPU（微秒转毫秒）、保留堆、峰值 RSS、计数与事件总数。
    return {
      totalMs: end - start, resumeMs: resumed - start, turnsMs: turnsDone - resumed, flushMs: end - turnsDone,
      cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
      retainedHeapMb, peakRssMb: process.resourceUsage().maxRSS / 1_024,
      requests: adapter.requests, toolCalls, events: handle.agent.session.seq,
    }
  } finally {
    // 无论成败都释放 agent 句柄与整个 context 生命周期（lifecycle）。
    await handle?.dispose()
    await ctx.fiber.dispose()
  }
}

// 断言以构建产物运行时各关键模块确实从真实解析地址加载（防止误用源码路径运行）。
assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session-persistence-jsonl',
].map(name => [name, import.meta.resolve(name)])))
// 从命令行参数中取运行目录与场景名。
const [root, scenario] = process.argv.slice(2)
// 参数缺失或场景名非法时直接报用法错误。
if (root === undefined || scenario === undefined || !['seed', 'request-history', 'tool-continuation'].includes(scenario)) {
  throw new Error('usage: agent-continuation.worker.js <root> <seed|request-history|tool-continuation>')
}
// seed 模式：只播种数据并输出确认 JSON。
if (scenario === 'seed') {
  await seed(root)
  process.stdout.write(JSON.stringify({ seeded: true }) + '\n')
} else {
  // 测量模式：执行完整测量并输出 JSON 报告。
  process.stdout.write(JSON.stringify(await measure(root, scenario)) + '\n')
}
