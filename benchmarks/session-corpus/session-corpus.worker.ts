/** Isolated worker that seeds the synthetic corpus or measures one Session-controller operation over it. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache, { checkpointRecord, projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { serializeRecord } from '../../packages/storage/storage-json/src/format.ts'
import { ANCHOR_COUNT } from './corpus-shape.ts'
import { createBenchmarkSessionController } from './session-controller.ts'
import {
  anchorHeader,
  corpusSessionId,
  forEachConcurrently,
  SEARCH_QUERIES,
  SyntheticCorpusWriter,
  type AnchorBodyFacts,
  type SyntheticCorpusFacts,
  type WrittenSession,
} from './synthetic-corpus.ts'

/** Process memory after the measured endpoint, with its result still reachable. */
// 测量端点结束后的进程内存（此时端点结果仍保持可达）。
export interface CorpusMemory {
  // 已用堆内存（heap used，MB）。
  readonly heapUsedMb: number
  // 常驻内存（RSS，MB）。
  readonly rssMb: number
  // 进程生命周期内的峰值 RSS（MB）。
  readonly peakRssMb: number
}

/** Anchor preparation report: authoring, replay validation, and projection folding of one anchor group. */
// 锚点准备报告：对一个锚点组完成撰写、回放验证与投影折叠。
export interface AnchorsReport {
  // 报告模式判别字段。
  readonly mode: 'anchors'
  // 本组准备的锚点编号列表。
  readonly anchors: readonly number[]
  // 准备总耗时（毫秒）。
  readonly prepareMs: number
}

/** Seeding report: facts of one named corpus written from prepared anchors, and the time spent writing it. */
// 播种报告：由预备锚点写出的一个命名语料库的事实与耗时。
export interface SeedReport {
  // 报告模式判别字段。
  readonly mode: 'seed'
  // 语料库名称。
  readonly name: string
  // 写出语料库的物理/逻辑事实。
  readonly corpus: SyntheticCorpusFacts
  // 播种耗时（毫秒）。
  readonly seedMs: number
}

/** Process CPU milliseconds, user plus system, over the same intervals as the wall-clock endpoints. */
// 与墙钟端点同区间的进程 CPU 毫秒（用户态 + 内核态）。
export interface PhaseCpu {
  // 启动区间 CPU 毫秒。
  readonly bootMs: number
  // 首次调用区间 CPU 毫秒。
  readonly firstMs: number
  // 重复调用区间 CPU 毫秒。
  readonly repeatMs: number
}

/** List report: Host boot, then a cold and a repeated Session list. */
// 列表报告：宿主启动，然后一次冷与一次重复的会话列表调用。
export interface ListReport {
  // 报告模式判别字段。
  readonly mode: 'list'
  // 宿主启动耗时（毫秒）。
  readonly bootMs: number
  // 首次列表调用耗时（毫秒，冷路径）。
  readonly firstMs: number
  // 重复列表调用耗时（毫秒，热路径）。
  readonly repeatMs: number
  // 各区间的 CPU 毫秒。
  readonly cpu: PhaseCpu
  // 首次调用返回的会话数。
  readonly items: number
  // 其中带投影数据的会话数。
  readonly itemsWithProjections: number
  // 测量后的进程内存。
  readonly memory: CorpusMemory
}

/** Search report: the first search builds the in-memory index; the second reuses it. */
// 搜索报告：首次搜索建立内存索引；第二次复用它。
export interface SearchReport {
  // 报告模式判别字段。
  readonly mode: 'search'
  // 宿主启动耗时（毫秒）。
  readonly bootMs: number
  // 首次搜索耗时（毫秒，含建索引）。
  readonly firstMs: number
  // 重复搜索耗时（毫秒，复用索引）。
  readonly repeatMs: number
  // 各区间的 CPU 毫秒。
  readonly cpu: PhaseCpu
  // 首次搜索的命中数。
  readonly firstItems: number
  // 重复搜索的命中数。
  readonly repeatItems: number
  // 测量后的进程内存。
  readonly memory: CorpusMemory
}

/** Fork report: one fork of each requested source, in request order. */
// Fork 报告：按请求顺序对每个源会话各 fork 一次。
export interface ForkReport {
  // 报告模式判别字段。
  readonly mode: 'fork'
  // 宿主启动耗时（毫秒）。
  readonly bootMs: number
  // 各次 fork 的结果列表。
  readonly forks: readonly {
    // 源会话的长度秩。
    readonly rank: number
    // 子会话继承的事件数。
    readonly sourceEvents: number
    // 该次 fork 的墙钟耗时（毫秒）。
    readonly forkMs: number
    // 该次 fork 的 CPU 耗时（毫秒）。
    readonly forkCpuMs: number
  }[]
  // 测量后的进程内存。
  readonly memory: CorpusMemory
}

/** Any worker report. */
// 全部 worker 报告的联合类型。
export type SessionCorpusReport = AnchorsReport | SeedReport | ListReport | SearchReport | ForkReport

// 基准专用的假模型标识：测量路径不会真正调用模型。
const BENCH_MODEL = { provider: 'bench', model: 'bench' } as const
/** Bound on waiting for fire-and-forget projection-cache write-backs after seeding. */
// 播种后等待投影缓存“发后不管”式回写落盘的超时上限。
const SEED_DRAIN_TIMEOUT_MS = 120_000

function megabytes(bytes: number): number {
  // 把字节数换算为保留一位小数的 MB（104857.6 = 0.1 MiB，先除再除 10 完成四舍五入）。
  return Math.round(bytes / 104_857.6) / 10
}

// 触发完整垃圾回收（GC）后采集进程内存，返回测量后的内存快照。
async function memory(): Promise<CorpusMemory> {
  // 从全局对象取出 gc 函数（需要 --expose-gc 才存在）。
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  // 缺少 gc 说明启动参数不对，内存测量不可信。
  if (gc === undefined) throw new Error('Session corpus benchmark requires --expose-gc')
  // 第一次 GC：回收大部分垃圾。
  gc()
  // 让出事件循环，使挂起的终结器（finalizer）与缓存回写任务有机会执行。
  await scheduler.yield()
  // 第二次 GC：回收终结器释放后产生的次级垃圾。
  gc()
  // 读取当前进程内存用量。
  const usage = process.memoryUsage()
  // 组装快照：heapUsed/rss 换算为 MB，maxRSS（KB）换算为 MB。
  return {
    heapUsedMb: megabytes(usage.heapUsed),
    rssMb: megabytes(usage.rss),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

/** Mount the shipped Web Host's Session list, search, and fork dependencies. */
// 挂载与线上 Web 宿主一致的会话列表、搜索与 fork 依赖。
async function mountHost(root: string): Promise<{ readonly ctx: Context; readonly controller: SessionController }> {
  // 新建 cordis 容器（依赖注入上下文）。
  const ctx = new Context()
  // 挂载 AgentLoop 测试依赖（提供 Agent 运行所需的最小服务集）。
  await mountAgentLoopTestDependencies(ctx)
  // 挂载 JSONL 会话持久化（根目录 root/sessions，zstd 压缩）。
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
  // 挂载存储服务。
  await ctx.plugin(Storage)
  // 挂载 JSON 存储后端（根目录 root/storages）。
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  // 挂载存储域（使用 json 后端）。
  await ctx.plugin(StorageDomain, { backend: 'json' })
  // 挂载会话投影缓存（每 200 个事件或每 5 秒写盘一次）。
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  // Content search is opt-in; enabled deployments defer the in-memory index to the first search.
  // 挂载 SQLite 会话查询引擎：内存模式，且推迟到首次搜索才建立内存索引。
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
  // 注册 Agent 预设投影定义。
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  // 挂载会话标题服务（回退标题与最大标题长度限制同生产）。
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  // 挂载会话统计插件。
  await ctx.plugin(SessionStatsPlugin)
  // 挂载会话轮次大纲插件。
  await ctx.plugin(SessionTurnOutlinePlugin)
  // 挂载令牌计量服务。
  await ctx.plugin(TokenMeter)
  // 挂载 AgentLoop（agents 为空列表：只测会话操作，不执行模型调用）。
  await ctx.plugin(AgentLoop, { agents: [] })
  // Transport, upload, model-default, and Workspace services are outside every measured path.
  // 空的 dispose 函数：下方桩服务注册的回调返回它即可，无需真正清理。
  const dispose = (): void => {}
  // 提供类型注册表桩（typert）：测量路径不会用到真实实现。
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: () => dispose },
  } as never)
  // 提供文件上传桩。
  ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
  // 提供默认模型桩（总是返回基准假模型）。
  ctx.provide('agentDefaultModel', { currentSelection: () => BENCH_MODEL } as never)
  // 提供工作区注册表桩（空列表、无归档会话）。
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  // 实例化远程访问服务（构造即完成注册；其传输层不在测量路径上）。
  new RemoteAccessService(ctx)
  // 用该容器创建基准专用的会话控制器（禁用原生打开路径）。
  const controller = await createBenchmarkSessionController(ctx, { nativeOpen: false })
  // 返回容器与控制器。
  return { ctx, controller }
}

/** Run one operation against the projection-cache table stored under `root`. */
// 在 `root` 下的投影缓存表上执行一次操作（独立的临时容器环境）。
async function withCacheTable<Value>(
  root: string,
  operation: (table: KvTable<SessionId, CheckpointRecord>) => Promise<Value>,
): Promise<Value> {
  // 为本次操作新建独立容器，避免污染调用方的容器状态。
  const ctx = new Context()
  try {
    // 挂载存储服务。
    await ctx.plugin(Storage)
    // 挂载 JSON 存储后端。
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    // 挂载存储域（json 后端）。
    await ctx.plugin(StorageDomain, { backend: 'json' })
    // 打开投影缓存所属的存储域。
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    // 操作完成后必须关闭域，释放底层文件句柄。
    try {
      // 取出 sessions 表并执行操作。
      return await operation(domain.table('sessions'))
    } finally {
      // 关闭存储域。
      await domain.close()
    }
  } finally {
    // 销毁容器（等待全部后台任务结束）。
    await ctx.fiber.dispose()
  }
}

function anchorFactsPath(root: string, anchor: number): string {
  // 计算某个锚点的事实 JSON 文件路径（bodies/anchor-NN.json，编号补零到两位）。
  return join(root, 'bodies', `anchor-${String(anchor).padStart(2, '0')}.json`)
}

/** Author, validate, and fold one group of anchors, saving bodies and projection records for `seed`. */
// 撰写、验证并折叠一组锚点：保存正文与投影记录，供后续 seed（播种）进程使用。
async function prepareAnchors(root: string, anchors: readonly number[]): Promise<AnchorsReport> {
  // 记录起始时刻，用于统计准备总耗时。
  const started = performance.now()
  // 新建合成语料写入器。
  const writer = new SyntheticCorpusWriter()
  // 折叠输出目录：fold-<锚点列表>，隔离每个锚点组的投影产物。
  const foldRoot = join(root, `fold-${anchors.join('-')}`)
  // 锚点编号 → 该锚点正文事实（帧数/事件数/逻辑字节）的映射。
  const facts = new Map<number, AnchorBodyFacts>()
  // 挂载一个宿主用于回放验证与投影折叠。
  const host = await mountHost(foldRoot)
  // 无论成败都要销毁宿主容器。
  try {
    // 逐个锚点：撰写正文、验证并折叠投影。
    for (const anchor of anchors) {
      // 取该锚点的专用会话头。
      const header = anchorHeader(anchor)
      // 撰写该锚点的事件日志。
      const log = await writer.author(anchor)
      // Replay validation, as in `sessionQuery.readSession`, rejects an invalid authored body before any write.
      // 以 0 偏移回放整个日志：非法正文会在任何写入之前被拒绝（与 sessionQuery.readSession 一致）。
      Session.create(header.id, log, header, SessionLogOffset(0), currentSessionMessageProjections)
      // The production cold-read write-back folds each shared body once.
      // 生产冷读回写：把共享正文折叠成投影缓存记录（每个正文只折叠一次）。
      host.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), log)
      // 保存正文事实（帧数等），稍后由 seed 进程读取。
      facts.set(anchor, await writer.saveBody(join(root, 'bodies'), anchor))
    }
    // Write-backs are fire-and-forget; the cache serves a record only after it is durable.
    // 计算等待回写落盘的最后期限。
    const deadline = performance.now() + SEED_DRAIN_TIMEOUT_MS
    // 轮询直到每个锚点的投影记录都已持久化（缓存可读到）。
    while (anchors.some(anchor => host.ctx.sessionProjectionCache.cachedSnapshot(anchorHeader(anchor)) === undefined)) {
      // 超过截止时间仍未落盘则失败，避免无限等待。
      if (performance.now() > deadline) throw new Error('projection-cache write-back did not become durable')
      // 每 20ms 轮询一次。
      await scheduler.wait(20)
    }
  } finally {
    // 销毁宿主容器。
    await host.ctx.fiber.dispose()
  }
  // 在独立的缓存表环境中，把每个锚点的投影记录与其正文事实一并写入 facts 文件。
  await withCacheTable(foldRoot, async (table) => {
    // 遍历锚点。
    for (const anchor of anchors) {
      // 从缓存表读取该锚点已落盘的投影记录。
      const record = table.get(anchorHeader(anchor).id)
      // 把正文事实与投影记录合并写成 JSON 文件。
      await writeFile(anchorFactsPath(root, anchor), JSON.stringify({ ...facts.get(anchor), record }))
    }
  })
  // 返回锚点准备报告：模式、锚点列表与总耗时。
  return { mode: 'anchors', anchors, prepareMs: performance.now() - started }
}

/** Parse one prepared anchor file written by a sibling `anchors` process. */
// 解析兄弟 anchors 进程写下的一个预备锚点文件。
async function readPreparedAnchor(root: string, anchor: number): Promise<AnchorBodyFacts & { readonly record: CheckpointRecord }> {
  // 读取并解析该锚点的事实 JSON 文件。
  const value: unknown = JSON.parse(await readFile(anchorFactsPath(root, anchor), 'utf8'))
  // 解析结果必须是对象。
  if (typeof value !== 'object' || value === null) throw new Error(`prepared anchor ${String(anchor)} is not an object`)
  // 解构出正文事实与投影记录。
  const { frameCount, events, logicalBytes, record } = value as Record<string, unknown>
  // 校验三个计数字段都是安全整数。
  for (const count of [frameCount, events, logicalBytes]) {
    // 任一字段非法即报错（兄弟进程产物被破坏）。
    if (!Number.isSafeInteger(count)) throw new Error(`prepared anchor ${String(anchor)} has invalid body facts`)
  }
  // 返回事实与经过 schema 校验的投影记录。
  return {
    frameCount: frameCount as number,
    events: events as number,
    logicalBytes: logicalBytes as number,
    record: checkpointRecord.parse(record),
  }
}

/** Write one named corpus from prepared anchors, rebinding each projection record to its Session header. */
// 由预备锚点写出一个命名语料库：把每条投影记录重绑定到其会话头。
async function seed(root: string, name: string, count: number): Promise<SeedReport> {
  // 记录起始时刻。
  const started = performance.now()
  // 新建写入器（本进程独立使用）。
  const writer = new SyntheticCorpusWriter()
  // 锚点 → 已折叠投影记录 的映射。
  const records = new Map<number, CheckpointRecord>()
  // 读取全部锚点的预备产物（正文 + 投影记录）。
  for (let anchor = 0; anchor < ANCHOR_COUNT; anchor++) {
    // 读出投影记录与正文事实。
    const { record, ...facts } = await readPreparedAnchor(root, anchor)
    // 从磁盘载入该锚点的压缩正文。
    await writer.loadBody(join(root, 'bodies'), anchor, facts)
    // 记录投影记录供稍后重绑定。
    records.set(anchor, record)
  }
  // 目标语料目录：corpus-<名称>。
  const corpusRoot = join(root, `corpus-${name}`)
  // 按 count 个长度秩写出全部会话文件。
  const written = await writer.writeCorpus(join(corpusRoot, 'sessions'), count)
  // Sessions of one anchor share events, so their records differ only in the header-bound identity.
  // Per-record documents are written directly: the domain's one-fsync-per-put chain would dominate seeding,
  // and the list endpoint rejects a corpus whose rows the cache does not serve.
  // 投影缓存表所在的存储目录。
  const table = join(corpusRoot, 'storages', projectionCacheDomainSpec.name, 'sessions')
  // 直接创建缓存表目录（绕过存储域逐条 fsync 的写入链）。
  await mkdir(table, { recursive: true })
  // 并发地为每个会话写出与其头部重绑定后的投影记录文档。
  await forEachConcurrently(written.sessions.length, async (rank) => {
    // 取该秩对应的会话头与锚点编号。
    const { header, anchor } = written.sessions[rank] as WrittenSession
    // 取该锚点已折叠的投影记录。
    const source = records.get(anchor)
    // 缺记录说明锚点未准备，直接失败。
    if (source === undefined) throw new Error(`corpus anchor ${String(anchor)} has no folded projection record`)
    // 写出记录文档：身份字段改绑到该会话头部，行数据保持共享。
    await writeFile(join(table, `${header.id}.json`), serializeRecord(projectionCacheDomainSpec.version, {
      identity: { ...source.identity, createdAt: header.createdAt, cwd: header.cwd },
      rows: source.rows,
    }))
  })
  // 返回播种报告。
  return { mode: 'seed', name, corpus: written.facts, seedMs: performance.now() - started }
}

function cpuMs(): number {
  // 读取当前进程的 CPU 用量（用户 + 内核，微秒）。
  const usage = process.cpuUsage()
  // 换算为毫秒返回。
  return (usage.user + usage.system) / 1_000
}

// 测量会话列表端点：宿主启动 + 冷/热两次调用。
async function measureList(root: string, expected: number): Promise<ListReport> {
  // 记录起始时刻与起始 CPU 时间。
  const started = performance.now()
  const cpuStarted = cpuMs()
  // 挂载被测宿主。
  const { ctx, controller } = await mountHost(root)
  // 无论成败都要销毁宿主。
  try {
    // 记录宿主启动完成时刻（启动区间结束）。
    const booted = performance.now()
    const cpuBooted = cpuMs()
    // 复用一个不可中止的信号（基准不受取消影响）。
    const signal = new AbortController().signal
    // 第一次 list：冷路径（含缓存与目录初始化）。
    const first = await controller.list({}, signal)
    // 记录首次完成时刻。
    const firstDone = performance.now()
    const cpuFirstDone = cpuMs()
    // 第二次 list：热路径（复用缓存）。
    const repeated = await controller.list({}, signal)
    // 记录重复完成时刻。
    const done = performance.now()
    const cpuDone = cpuMs()
    // 两次调用都必须返回期望数量的会话，否则语料不完整。
    if (first.items.length !== expected || repeated.items.length !== expected) {
      throw new Error(`Session list returned ${String(first.items.length)} of ${String(expected)} Sessions`)
    }
    // 汇总各区间墙钟与 CPU 耗时及测量后内存。
    return {
      mode: 'list',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      cpu: { bootMs: cpuBooted - cpuStarted, firstMs: cpuFirstDone - cpuBooted, repeatMs: cpuDone - cpuFirstDone },
      items: first.items.length,
      itemsWithProjections: first.items.filter(item => item.projections !== undefined).length,
      memory: await memory(),
    }
  } finally {
    // 销毁宿主容器。
    await ctx.fiber.dispose()
  }
}

// 测量会话搜索端点：首次搜索建索引，第二次复用。
async function measureSearch(root: string): Promise<SearchReport> {
  // 记录起始时刻与起始 CPU 时间。
  const started = performance.now()
  const cpuStarted = cpuMs()
  // 挂载被测宿主。
  const { ctx, controller } = await mountHost(root)
  // 无论成败都要销毁宿主。
  try {
    // 记录宿主启动完成时刻。
    const booted = performance.now()
    const cpuBooted = cpuMs()
    // 复用一个不可中止的信号。
    const signal = new AbortController().signal
    // 第一次 search：冷路径，此时才建立内存索引。
    const first = await controller.search({ query: SEARCH_QUERIES[0] }, signal)
    // 记录首次完成时刻。
    const firstDone = performance.now()
    const cpuFirstDone = cpuMs()
    // 第二次 search：热路径，复用已建索引（换一个查询词）。
    const repeated = await controller.search({ query: SEARCH_QUERIES[1] }, signal)
    // 记录重复完成时刻。
    const done = performance.now()
    const cpuDone = cpuMs()
    // 两次搜索都必须命中至少一个合成会话，否则语料或索引有问题。
    if (first.items.length === 0 || repeated.items.length === 0) {
      throw new Error('Session search matched no synthetic Session')
    }
    // 汇总各区间墙钟与 CPU 耗时及测量后内存。
    return {
      mode: 'search',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      cpu: { bootMs: cpuBooted - cpuStarted, firstMs: cpuFirstDone - cpuBooted, repeatMs: cpuDone - cpuFirstDone },
      firstItems: first.items.length,
      repeatItems: repeated.items.length,
      memory: await memory(),
    }
  } finally {
    // 销毁宿主容器。
    await ctx.fiber.dispose()
  }
}

// 测量 fork 端点：对每个请求的源会话秩各 fork 一次。
async function measureFork(root: string, ranks: readonly number[]): Promise<ForkReport> {
  // 记录起始时刻。
  const started = performance.now()
  // 挂载被测宿主。
  const { ctx, controller } = await mountHost(root)
  // 无论成败都要销毁宿主。
  try {
    // 记录宿主启动完成时刻。
    const booted = performance.now()
    // 按请求顺序收集各次 fork 的结果。
    const forks: ForkReport['forks'][number][] = []
    // 逐个请求的源会话秩。
    for (const rank of ranks) {
      // 记录本次 fork 的起始时刻与 CPU 时间。
      const forkStarted = performance.now()
      const forkCpuStarted = cpuMs()
      // 对该秩的合成会话发起 fork。
      const { sessionId } = await controller.fork({ sessionId: corpusSessionId(rank) })
      // 统计本次 fork 的墙钟耗时。
      const forkMs = performance.now() - forkStarted
      // 统计本次 fork 的 CPU 耗时。
      const forkCpuMs = cpuMs() - forkCpuStarted
      // 从容器中取出 fork 出的子会话。
      const child = ctx.sessions.get(sessionId)
      // 子会话必须已发布，否则 fork 未真正完成。
      if (child === undefined) throw new Error(`fork of rank ${String(rank)} did not publish its child`)
      // 记录该次 fork 的结果（含子会话继承的事件数）。
      forks.push({ rank, sourceEvents: child.inheritedEventCount, forkMs, forkCpuMs })
    }
    // 返回 fork 报告。
    return { mode: 'fork', bootMs: booted - started, forks, memory: await memory() }
  } finally {
    // 销毁宿主容器。
    await ctx.fiber.dispose()
  }
}

// 断言以编译产物运行，且关键包都解析到生产 lib 构建（防止测量到 TS 加载器或源码路径）。
assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-projection-cache',
].map(name => [name, import.meta.resolve(name)])))

// 命令行用法说明（参数错误时输出）。
const USAGE = 'usage: session-corpus.worker.js <root> <anchors anchors...|seed name count|list count|search|fork ranks...>'
// 解析命令行参数：第一个是数据根目录，第二个是模式，其余为模式参数。
const [root, mode, ...rest] = process.argv.slice(2)
// 缺少根目录参数即报错。
if (root === undefined) throw new Error(USAGE)

// 把字符串参数解析为非负整数数组，非法即报错。
function counts(values: readonly string[]): number[] {
  // 逐个转换为数字。
  const parsed = values.map(Number)
  // 任一参数不是安全整数或为负，说明用法错误。
  if (parsed.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error(USAGE)
  // 返回解析结果。
  return parsed
}

// 声明报告变量，由下方模式分支赋值。
let report: SessionCorpusReport
// 按第二个命令行参数分发到对应模式。
switch (mode) {
  case 'anchors':
    // 准备锚点：撰写、验证并折叠指定锚点组。
    report = await prepareAnchors(root, counts(rest))
    break
  case 'seed': {
    // 取语料库名称与数量参数。
    const [name, count] = rest
    // 名称必须为纯小写字母且数量参数存在，否则用法错误。
    if (name === undefined || !/^[a-z]+$/.test(name) || count === undefined) throw new Error(USAGE)
    // 从预备锚点播种指定大小的语料库。
    report = await seed(root, name, counts([count])[0] as number)
    break
  }
  case 'list':
    // 测量会话列表端点（默认期望 0 个会话）。
    report = await measureList(root, counts(rest)[0] ?? 0)
    break
  case 'search':
    // 测量会话搜索端点。
    report = await measureSearch(root)
    break
  case 'fork':
    // 测量对指定秩列表的 fork。
    report = await measureFork(root, counts(rest))
    break
  default:
    // 未知模式直接报错。
    throw new Error(`unknown Session corpus mode ${String(mode)}`)
}
// 把报告序列化为单行 JSON 输出到标准输出（父进程解析最后一行 JSON）。
process.stdout.write(JSON.stringify(report) + '\n')
