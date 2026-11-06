/** Plain-Node Session-list measurements with large persisted projections and small wire summaries. */
// 文件头（JSDoc 补充）：在纯 Node 环境下测量会话列表——持久化投影（projection）很大、线上传输（wire）摘要却很小。

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { scheduler, setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import { generationLogPath, sessionDir, toHeaderLine } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { createBenchmarkSessionController } from './session-controller.ts'

// 合成投影在注册表中的键名。
const KEY = 'syntheticProjectionList'
// 合成会话的统一工作目录。
const CWD = '/synthetic-projection-benchmark'
// 固定时间基准，保证时间戳确定。
const BASE_TIME = 1_700_000_000_000
// 每个会话的事件行数取 baseRows 的这些百分比档位（按会话序号循环取模）。
const ROW_PERCENTAGES = [50, 75, 100, 175] as const
// 三种负载：modest（50 会话/100 基础行/不活跃）、tail（300 会话/1000 行）、cheap（3000 会话/0 行/活跃创建）。
const WORKLOADS = {
  modest: { sessions: 50, baseRows: 100, live: false },
  tail: { sessions: 300, baseRows: 1_000, live: false },
  cheap: { sessions: 3_000, baseRows: 0, live: true },
} as const

// 投影状态（state）的 schema：会话序号、事件数组、请求汇总数组与总计。
const stateSchema = z.object({
  sessionOrdinal: z.number().int(),
  events: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    category: z.enum(['input', 'output', 'tool']),
    metrics: z.object({ tokens: z.number().int(), bytes: z.number().int(), elapsedMs: z.number().int() }),
    content: z.array(z.object({ kind: z.enum(['text', 'metadata']), text: z.string() })),
    tags: z.array(z.string()),
  })),
  requests: z.array(z.object({
    ordinal: z.number().int(), firstRow: z.number().int(), lastRow: z.number().int(),
    route: z.object({ provider: z.string(), model: z.string(), options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), cache: z.object({ hit: z.number().int(), miss: z.number().int() }) }),
    references: z.array(z.object({ ordinal: z.number().int(), weight: z.number() })),
  })),
  totals: z.object({ rows: z.number().int(), requests: z.number().int(), tokens: z.number().int() }),
})
// 线视图（wire view）的 schema：只保留会话序号与三个汇总数字，保证传输摘要很小。
const viewSchema = z.object({ sessionOrdinal: z.number().int(), rows: z.number().int(), requests: z.number().int(), tokens: z.number().int() })
// 投影状态类型。
type ProjectionState = z.infer<typeof stateSchema>

// 把合成投影键注册进会话投影的视图映射（模块声明合并）。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { syntheticProjectionList: z.infer<typeof viewSchema> }
}

// 内存快照结构。
interface Memory {
  // 已用堆字节。
  readonly heapUsedBytes: number
  // 常驻内存（RSS）字节。
  readonly rssBytes: number
  /** Process lifetime peak, including fixture creation and Host mounting. */
  // 中文补充（字段 JSDoc）：进程全生命周期的 RSS 峰值（含夹具创建与 Host 装配）。
  readonly peakRssBytes: number
}

// 单次列表采样包含的全部指标。
interface ListSample {
  // 仅列表调用耗时（毫秒）。
  readonly listMs: number
  // 列表调用 + JSON 序列化耗时（毫秒）。
  readonly listAndJsonMs: number
  // 列表调用 CPU 时间。
  readonly listCpuMs: number
  // 列表 + JSON 的 CPU 时间。
  readonly listAndJsonCpuMs: number
  // 首个视图批次被 setImmediate 推迟的回调延迟。
  readonly callbackDelayMs: number
  // 所有批次中的最大回调延迟。
  readonly maxCallbackDelayMs: number
  // 单批次内的最大视图调用数。
  readonly maxViewsPerBatch: number
  // 列表期间的让渡（yield）调用次数。
  readonly yieldCalls: number
  // 事件循环单次阻塞最大时长（毫秒）。
  readonly eventLoopMaxMs: number
  // 列表条目数。
  readonly items: number
  // 线视图调用次数。
  readonly wireViews: number
  // 响应 JSON 的字节数。
  readonly responseJsonBytes: number
  // 相对基线的保留堆增量（字节）。
  readonly retainedHeapDeltaBytes: number
  // 该时点的内存快照。
  readonly memory: Memory
}

/** One fresh Host's fixture dimensions, retained memory, and first plus three repeated list samples. */
// 中文补充（接口 JSDoc）：一个全新 Host 的夹具规模、保留内存，以及首次 + 三次重复的列表采样。
export interface ProjectionListReport {
  // 负载名。
  readonly workload: keyof typeof WORKLOADS
  // 夹具规模信息：会话数、基础行数、总行数、总请求数、状态 JSON 字节数。
  readonly fixture: { sessions: number; baseRows: number; totalRows: number; totalRequests: number; stateJsonBytes: number }
  // 装配完成后的内存基线。
  readonly baselineMemory: Memory
  // 4 次列表采样。
  readonly samples: readonly ListSample[]
  // 额外的响应性探测采样（全程保留回调探针）。
  readonly responsiveness: ListSample
}

// 视图观察器：记录视图调用次数与可选的批间探针回调。
interface ViewObservation {
  calls: number
  onView: (() => void) | undefined
}

// 按序号构造会话头。
function headerOf(ordinal: number): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(`projection-bench-${ordinal}`),
    createdAt: BASE_TIME + ordinal, cwd: CWD, isSeeded: false, delegationDepth: 0 }
}

// 构造确定性的投影状态：事件数按行百分比档位缩放，内容/指标由序号取模生成。
function makeState(sessionOrdinal: number, baseRows: number): ProjectionState {
  // 该会话的事件行数 = baseRows × 对应档位百分比。
  const count = Math.floor(baseRows * ROW_PERCENTAGES[sessionOrdinal % ROW_PERCENTAGES.length]! / 100)
  // 生成 count 条事件：类别/指标/内容/标签全部由取模决定，保证确定性与多样性。
  const events: ProjectionState['events'] = Array.from({ length: count }, (_, ordinal) => ({
    ordinal, category: (['input', 'output', 'tool'] as const)[ordinal % 3]!,
    metrics: { tokens: 32 + ordinal % 97, bytes: 128 + ordinal % 257, elapsedMs: ordinal % 41 },
    content: [
      { kind: 'text', text: `Generated observation ${sessionOrdinal}:${ordinal}. ` + 'Synthetic text. '.repeat(4 + ordinal % 4) },
      { kind: 'metadata', text: `bucket-${ordinal % 11}` },
    ],
    tags: [`group-${sessionOrdinal % 7}`, `kind-${ordinal % 3}`],
  }))
  // 每 8 行事件汇总成一个请求记录，含路由、用量与引用。
  const requests = Array.from({ length: Math.ceil(count / 8) }, (_, ordinal) => ({
    ordinal, firstRow: ordinal * 8, lastRow: Math.min(count - 1, ordinal * 8 + 7),
    route: { provider: 'synthetic', model: 'generated-model', options: { temperature: 0, streaming: true, tier: 'fixed' } },
    usage: { inputTokens: 100 + ordinal % 500, outputTokens: 30 + ordinal % 200, cache: { hit: ordinal % 100, miss: 20 } },
    references: Array.from({ length: Math.min(8, count - ordinal * 8) }, (_, index) => ({ ordinal: ordinal * 8 + index, weight: (index + 1) / 8 })),
  }))
  // 汇总总计。
  return { sessionOrdinal, events, requests,
    totals: { rows: count, requests: requests.length, tokens: events.reduce((sum, event) => sum + event.metrics.tokens, 0) } }
}

// 在 context 上装配存储栈：通用 Storage、JSON 后端与 JSON 领域配置。
async function mountStorage(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
}

// 播种夹具：按负载在磁盘上创建会话与投影状态，返回夹具规模统计。
async function seed(root: string, workload: typeof WORKLOADS[keyof typeof WORKLOADS]): Promise<ProjectionListReport['fixture']> {
  const ctx = new Context()
  const fixture = { ...workload, totalRows: 0, totalRequests: 0, stateJsonBytes: 0 }
  try {
    // live 负载（cheap）：不落盘，仅统计状态字节数（会话由 Host 挂载时创建）。
    if (workload.live) {
      for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
        fixture.stateJsonBytes += Buffer.byteLength(JSON.stringify(makeState(ordinal, workload.baseRows)))
      }
      return fixture
    }
    // 非活跃负载：装配存储栈并打开投影缓存所属的领域。
    await mountStorage(ctx, root)
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    try {
      const table = domain.table('sessions')
      // 逐个会话：写头部 JSONL（zstd 压缩）并把投影状态放入存储表。
      for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
        const header = headerOf(ordinal)
        const directory = sessionDir(join(root, 'sessions'), header.cwd, header.id)
        await mkdir(directory, { recursive: true })
        await writeFile(generationLogPath(join(root, 'sessions'), header.cwd, header.id, SESSION_FORMAT_VERSION, 'zstd'),
          await compressZstdFrame(JSON.stringify(toHeaderLine(header)) + '\n'), { flag: 'wx' })
        const state = makeState(ordinal, workload.baseRows)
        await table.put(header.id, {
          identity: { formatVersion: header.version, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false, inheritedEventCount: SessionLogOffset(0) },
          rows: {
            // 合成投影行：版本 1、无事件序号（-1）。
            [KEY]: { ver: 1, seq: -1, val: state },
            // 会话列表元数据行：空白会话、无最近提示时间。
            sessionListMetadata: { ver: 1, seq: -1, val: { blank: true, lastPromptAt: null } },
          },
        })
        // 累计夹具统计。
        fixture.totalRows += state.events.length
        fixture.totalRequests += state.requests.length
        fixture.stateJsonBytes += Buffer.byteLength(JSON.stringify(state))
      }
    } finally {
      await domain.close()
    }
  } finally {
    // 释放 context 生命周期。
    await ctx.fiber.dispose()
  }
  return fixture
}

// 装配完整的列表 Host：注册存储、投影、缓存、查询引擎，并给列表路径上的非列表服务打桩。
async function mountHost(ctx: Context, root: string, workload: typeof WORKLOADS[keyof typeof WORKLOADS], observation: ViewObservation, listWorkSliceMs?: number): Promise<SessionController> {
  // 注册会话存储与投影注册表、Agent 注册表。
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  // 注册合成投影：状态惰性生成（init），apply 恒等，wire 视图调用时计数并触发探针。
  await ctx.sessionProjections.register({
    key: KEY, stateVersion: 1, stateSchema,
    init: header => makeState(Number(header.id.slice('projection-bench-'.length)), workload.baseRows),
    apply: state => state,
    wire: {
      viewSchema,
      view(state) {
        observation.calls++
        observation.onView?.()
        return { sessionOrdinal: state.sessionOrdinal, ...state.totals }
      },
    },
  })
  // live 负载：在内存中直接创建全部会话。
  if (workload.live) {
    for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
      const header = headerOf(ordinal)
      ctx.sessions.create(header.id, { meta: header })
    }
  }
  // 注册 JSONL 持久化、存储栈、投影缓存与内存版 SQLite 查询引擎（永不自动打开）。
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
  await mountStorage(ctx, root)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  // No Agents, uploads, model calls, or workspace actions occur on this list path.
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: () => dispose },
  } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'generated-model' }) } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  // 实例化远程访问服务以满足控制器的服务依赖。
  new RemoteAccessService(ctx)
  // 创建基准控制器：禁用原生打开，可选地注入列表工作切片参数。
  return createBenchmarkSessionController(ctx, { nativeOpen: false, ...(listWorkSliceMs === undefined ? {} : { listWorkSliceMs }) })
}

// 强制 GC 后采集内存快照。
async function memory(): Promise<Memory> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  assert.ok(gc, 'projection-list worker requires --expose-gc')
  gc()
  // 让事件循环跑一圈，确保回收完成，再 GC 一次后读取。
  await scheduler.yield()
  gc()
  const usage = process.memoryUsage()
  return { heapUsedBytes: usage.heapUsed, rssBytes: usage.rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
}

// 核心测量：执行一次列表调用并采集耗时、CPU、队列延迟、事件循环与内存指标。
async function measure(controller: SessionController, observation: ViewObservation, sessions: number, baseline: Memory, fullProbe = false): Promise<ListSample> {
  // 以 1ms 分辨率监控事件循环延迟。
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  // 当前挂起的 immediate 句柄（每批只排一个探针）。
  let immediate: NodeJS.Immediate | undefined
  // 记录视图调用初始值。
  const initialViews = observation.calls
  // 包装 scheduler.yield 以统计列表期间的让渡次数。
  const yieldDescriptor = Object.getOwnPropertyDescriptor(scheduler, 'yield')
  const yieldWork = scheduler.yield.bind(scheduler)
  let yieldCalls = 0
  Object.defineProperty(scheduler, 'yield', {
    configurable: true,
    value: () => { yieldCalls++; return yieldWork() },
  })
  let queued: Promise<void> | undefined
  let callbackDelayMs = 0
  let maxCallbackDelayMs = 0
  let maxViewsPerBatch = 0
  // 批间探针：每个视图批次结束后用 setImmediate 测量其他回调等待的延迟。
  observation.onView = () => {
    // 已有探针在跑则跳过。
    if (immediate !== undefined) return
    // 非 fullProbe 模式只测第一批。
    if (!fullProbe) observation.onView = undefined
    const beforeView = observation.calls - 1
    const start = performance.now()
    queued = new Promise<void>((resolve) => {
      immediate = setImmediate(() => {
        const elapsed = performance.now() - start
        // 第一批的延迟单独记录。
        if (maxViewsPerBatch === 0) callbackDelayMs = elapsed
        maxCallbackDelayMs = Math.max(maxCallbackDelayMs, elapsed)
        // 统计该批次内发生的视图调用数。
        maxViewsPerBatch = Math.max(maxViewsPerBatch, observation.calls - beforeView)
        immediate = undefined
        resolve()
      })
    })
  }
  histogram.enable()
  try {
    // Arm the histogram before work, and keep it enabled through the final blocking segment.
    await delay(2)
    histogram.reset()
    const cpu = process.cpuUsage()
    const start = performance.now()
    // 执行列表调用（带中止信号）。
    const result = await controller.list({}, new AbortController().signal)
    const listDone = performance.now()
    const listYieldCalls = yieldCalls
    const listCpu = process.cpuUsage(cpu)
    // 序列化响应 JSON 并计时。
    const json = JSON.stringify(result)
    const jsonDone = performance.now()
    const jsonCpu = process.cpuUsage(cpu)
    // 完整性校验：条目数、视图调用数与投影字段都必须正确。
    assert.equal(result.items.length, sessions)
    assert.equal(observation.calls - initialViews, sessions)
    assert.ok(result.items.every(item => item.projections?.values[KEY] !== undefined))
    // No more views can arrive after list completion; drain the final armed batch.
    await queued
    await delay(2)
    const eventLoopMaxMs = histogram.max / 1_000_000
    histogram.disable()
    // 采集测量结束后的内存端点值。
    const endpoint = await memory()
    // Both endpoint values remain reachable while GC measures the retained heap.
    assert.ok(json.length > result.items.length)
    return { listMs: listDone - start, listAndJsonMs: jsonDone - start,
      listCpuMs: (listCpu.user + listCpu.system) / 1000, listAndJsonCpuMs: (jsonCpu.user + jsonCpu.system) / 1000,
      callbackDelayMs, maxCallbackDelayMs, maxViewsPerBatch, yieldCalls: listYieldCalls, eventLoopMaxMs, items: result.items.length, wireViews: observation.calls - initialViews,
      responseJsonBytes: Buffer.byteLength(json), retainedHeapDeltaBytes: endpoint.heapUsedBytes - baseline.heapUsedBytes, memory: endpoint }
  } finally {
    // 清理全部探针与包装，恢复原始 scheduler.yield。
    observation.onView = undefined
    if (immediate !== undefined) clearImmediate(immediate)
    histogram.disable()
    if (yieldDescriptor === undefined) Reflect.deleteProperty(scheduler, 'yield')
    else Object.defineProperty(scheduler, 'yield', yieldDescriptor)
  }
}

// 断言以构建产物运行时各关键模块从真实解析地址加载。
assertBuiltBenchmarkRuntime(import.meta.url, {
  controller: import.meta.resolve('@deepseek-ai/dsh-api-session-controller'),
  registry: import.meta.resolve('@deepseek-ai/dsh-session-projection'),
  cache: import.meta.resolve('@deepseek-ai/dsh-session-projection-cache'),
  persistence: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),
})
// 解析命令行参数：根目录、负载名与可选的工作切片毫秒数。
const [root, workload, sliceArgument] = process.argv.slice(2)
if (root === undefined || (workload !== 'modest' && workload !== 'tail' && workload !== 'cheap')) throw new Error('usage: projection-list.worker.js <private-root> <modest|tail|cheap> [work-slice-ms]')
const listWorkSliceMs = sliceArgument === undefined ? undefined : Number(sliceArgument)
if (listWorkSliceMs !== undefined && (!Number.isSafeInteger(listWorkSliceMs) || listWorkSliceMs < 1)) throw new Error('work-slice-ms must be a positive integer')
const ctx = new Context()
try {
  // 播种夹具并装配 Host。
  const fixture = await seed(root, WORKLOADS[workload])
  const observation: ViewObservation = { calls: 0, onView: undefined }
  const controller = await mountHost(ctx, root, WORKLOADS[workload], observation, listWorkSliceMs)
  // 装配过程不得预热线视图。
  assert.equal(observation.calls, 0, 'setup must not warm wire views')
  // 采集装配后的内存基线。
  const baselineMemory = await memory()
  // 先做 4 次常规采样，再做一次全程探针的响应性采样。
  const samples: ListSample[] = []
  for (let call = 0; call < 4; call++) samples.push(await measure(controller, observation, fixture.sessions, baselineMemory))
  const responsiveness = await measure(controller, observation, fixture.sessions, baselineMemory, true)
  // 输出完整报告 JSON。
  const report: ProjectionListReport = { workload, fixture, baselineMemory, samples, responsiveness }
  console.log(JSON.stringify(report))
} finally {
  // 释放 context 生命周期。
  await ctx.fiber.dispose()
}
