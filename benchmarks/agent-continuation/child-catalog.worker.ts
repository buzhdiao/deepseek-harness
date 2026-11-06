/** Cold parent-catalog observations beside fork children with tool-heavy inherited histories. */
// 文件头（JSDoc 补充）：测量"冷启动读取父会话目录（catalog）"——父会话旁边挂着多个带工具密集继承历史的 fork 子会话。

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, syntheticHistory, TIME_ZERO, WORKLOAD } from './workload.ts'

/** Two complete catalog reads in one fresh Host, with each parent observation released. */
// 中文补充（接口 JSDoc）：在一个全新 Host 中做两次完整目录读取，且每次父会话观察（observation）都被及时释放。
export interface CatalogReport {
  // 两次读取的总耗时（毫秒）。
  readonly totalMs: number
  // 第一次（冷）读取耗时。
  readonly firstMs: number
  // 第二次（重复）读取耗时，用于验证缓存效果。
  readonly repeatMs: number
  // 用户态 CPU 时间（毫秒）。
  readonly cpuUserMs: number
  // 内核态 CPU 时间（毫秒）。
  readonly cpuSystemMs: number
  // 目录中发现的子会话数量。
  readonly children: number
  // 进程峰值常驻内存 RSS（MB）。
  readonly peakRssMb: number
}

// 目录查询引擎（query engine）子类：把搜索能力显式禁用——搜索不在本基准范围内，误用时立即报错。
class CatalogQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is outside the child-catalog benchmark'))
  }
  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is outside the child-catalog benchmark'))
  }
}

// 播种（seed）：构造 WORKLOAD.children 个 fork 子会话事件流与父会话目录事件。
async function seed(ctx: Context): Promise<void> {
  // 每个子会话继承的历史事件（工具密集的合成历史），预先构造一次以便复用。
  const inherited = syntheticHistory(WORKLOAD.childHistoryTurns)
  // 待写入父会话的目录（catalog）事件列表。
  const catalog: SessionEvent[] = []
  // 逐个创建子会话。
  for (let child = 0; child < WORKLOAD.children; child++) {
    // 子会话 ID 按序号命名。
    const id = SessionId('bench-child-' + String(child))
    // 在父会话目录里登记一条 subagent/catalog 事件，声明该子会话可续跑（continuable）。
    catalog.push({
      type: 'subagent/catalog', seq: SessionSeq(child), time: TIME_ZERO + child,
      data: { version: 0, childId: id, childCreatedAt: TIME_ZERO + child,
        mode: 'continuable', label: 'Synthetic child ' + String(child) },
    })
    // 子会话自身的事件流 = 继承历史 + 结束种子标记 + subagent 描述符。
    const events: SessionEvent[] = [
      ...inherited,
      // session/end-seed 标记继承段结束，序号与时间顺延。
      { type: 'session/end-seed', seq: SessionSeq(inherited.length), time: TIME_ZERO + inherited.length, data: { inherited: true } },
      // subagent/descriptor 声明该子会话来自 fork 提供方、可续跑。
      { type: 'subagent/descriptor', seq: SessionSeq(inherited.length + 1), time: TIME_ZERO + inherited.length + 1, data: {
        version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'fork', label: 'Synthetic child ' + String(child),
      } },
    ]
    // 创建子会话存储：父会话指向 PARENT_ID，origin 标记为 subagent，委托深度 1；继承段被记录为已持久化的日志偏移（offset）。
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id, createdAt: TIME_ZERO + child, cwd: '/bench',
      parentSession: PARENT_ID, isSeeded: true, origin: 'subagent', delegationDepth: 1,
    }, { inheritedEventCount: SessionLogOffset(inherited.length) })
    try {
      // 追加全部事件并刷盘。
      await handle.append(events)
      await handle.flush()
    } finally { await handle.close() }
  }
  // 创建父会话存储（不含目录事件，目录由上面 catalog 列表提供）。
  const parent = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: PARENT_ID, createdAt: TIME_ZERO, cwd: '/bench',
    isSeeded: false,
  })
  try {
    // 把目录事件写入父会话并刷盘。
    await parent.append(catalog)
    await parent.flush()
  } finally { await parent.close() }
}

// 运行器：seed 模式返回确认；catalog 模式执行两次目录读取并产出报告。
async function run(root: string, mode: string): Promise<CatalogReport | { seeded: true }> {
  const ctx = new Context()
  try {
    // 注册会话存储、投影（projection）注册表、JSONL 持久化与目录查询引擎。
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await ctx.plugin(CatalogQuery)
    // 提供工作目录夹具，满足子代理运行时对 cwd 的依赖。
    provideWorkingDirectoryFixture(ctx, '/bench')
    // 注册子代理（Subagent）运行时，目录投影由此服务生成。
    await ctx.plugin(SubagentRuntime)
    // seed 模式：播种后直接返回确认。
    if (mode === 'seed') {
      await seed(ctx)
      return { seeded: true }
    }
    // 单次目录读取：以 observeSession 打开观察（using 自动释放），取子代理目录投影。
    const readCatalog = async () => {
      using observation = await ctx.sessionQuery.observeSession(PARENT_ID)
      const catalog = observation.projections?.values.subagentCatalog
      // 投影缺失说明运行时装配有误，直接报错。
      if (catalog === undefined) throw new Error('child-catalog projection is unavailable')
      return catalog
    }
    // CPU 与墙钟计时起点。
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    // 第一次（冷）读取。
    const first = await readCatalog()
    const firstDone = performance.now()
    // 第二次（重复）读取。
    const repeated = await readCatalog()
    const end = performance.now()
    // 计算 CPU 时间差。
    const cpu = process.cpuUsage(cpuStart)
    // 完整性校验：两次读取都必须拿到全部 WORKLOAD.children 个子会话。
    if (first.length !== WORKLOAD.children || repeated.length !== WORKLOAD.children) {
      throw new Error('child-catalog benchmark did not reach the complete healthy catalog')
    }
    // 汇总报告。
    return {
      totalMs: end - start, firstMs: firstDone - start, repeatMs: end - firstDone,
      cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
      children: first.length, peakRssMb: process.resourceUsage().maxRSS / 1_024,
    }
  } finally { await ctx.fiber.dispose() }
}

// 断言以构建产物运行时关键模块从真实解析地址加载。
assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-persistence-jsonl',
].map(name => [name, import.meta.resolve(name)])))
// 从命令行参数取运行目录与模式。
const [root, mode] = process.argv.slice(2)
// 参数缺失或模式非法时报用法错误。
if (root === undefined || (mode !== 'seed' && mode !== 'catalog')) {
  throw new Error('usage: child-catalog.worker.js <root> <seed|catalog>')
}
// 执行并输出 JSON 结果。
process.stdout.write(JSON.stringify(await run(root, mode)) + '\n')
