/** Compiled production Client fold for a reconnect during a long Assistant attempt. */
// 文件头（JSDoc 补充）：本 worker 是"长回复流（Assistant 尝试）中途重连"场景下、编译产物形态的 Client 折叠（fold）基准。
import { performance } from 'node:perf_hooks'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionAssistantStreamBaseline } from '@deepseek-ai/dsh-api-session-controller/types'
// The Client implementation has no plain-Node export; only this adapter is bundled.
import { ClientAssistantStream } from '../../packages/api/session-controller/src/client/sessions/assistant-stream.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** Measurements of replace() only; fixture construction and forced GC are excluded. */
// 中文补充（接口 JSDoc）：报告只统计 replace() 的耗时与内存；夹具（fixture）构造和强制 GC 不计入。
export interface ReconnectReport {
  // 灌入的 delta（增量片段）总数。
  readonly deltas: number
  // 基线快照里保留的记录（records）条数。
  readonly records: number
  // 替换后对调用方可见的条目（entries）数量。
  readonly entries: number
  // replace() 全量替换的耗时（毫秒）。
  readonly replaceMs: number
  // 替换并强制 GC 后保留（retained）的额外堆内存（MB）。
  readonly retainedMb: number
  // 替换后接受下一帧时返回的帧类型（用于断言流仍是活跃接续状态）。
  readonly nextFrame: string | undefined
}

// 断言基准运行时正确性：确认本文件以构建产物形式运行、且各模块按解析出的真实地址被加载。
assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-llm/assistant-stream': import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'),
})
// 合成数据规模：100000 条 delta，模拟一次超长推理（reasoning）流。
const deltas = 100000
// 累加器（accumulator）负责把流式 chunk 折叠成快照结构，先拿空实例。
const accumulator = new AssistantStreamAccumulator()
// 推入首帧：block-start，声明第 0 个块为 reasoning（推理）类型。
accumulator.push({ time: 1700000000000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
// 循环推入 deltas 条 reasoning-delta 文本片段，构成完整的推理前缀。
for (let index = 0; index < deltas; index++) {
  accumulator.push({ time: 1700000000001 + index, chunk: { type: 'reasoning-delta', index: 0, text: 'token ' } })
}
// 为这次合成会话造一个品牌化的尝试（attempt）ID。
const attemptId = LlmAttemptId('synthetic-reconnect')
// 基线里尚未确认的帧序号：所有 delta 之后的位置。
const nextIndex = deltas + 1
// 构造会话侧的基线（baseline）：客户端将用它整体替换本地状态。
const baseline: SessionAssistantStreamBaseline = {
  // revision 取 nextIndex+1，代表服务器已确认到的修订版本。
  revision: nextIndex + 1,
  // activeAttempt 表示仍在进行中的那次回复尝试。
  activeAttempt: {
    attemptId, startedAfterSeq: -1, turn: 1, step: 1, nextIndex,
    // 用深拷贝（JSON 序列化往返）得到纯数据快照，模拟网络序列化后的基线流内容。
    stream: JSON.parse(JSON.stringify(accumulator.snapshot())) as NonNullable<SessionAssistantStreamBaseline['activeAttempt']>['stream'],
  },
}
// 内存测量依赖显式 GC：缺少 --expose-gc 启动参数时直接报错，避免测出假数据。
if (globalThis.gc === undefined) throw new Error('reconnect benchmark requires --expose-gc')
// 先强制回收一次，清掉夹具构造阶段的临时对象。
globalThis.gc()
// 记录 GC 后的初始堆用量，作为内存基线。
const before = process.memoryUsage().heapUsed
// 新建一个空的 Client 流实例，模拟刚重连、本地无任何状态的客户端。
const client = new ClientAssistantStream()
// 开始计时：下面的 replace() 就是本基准要测量的核心操作。
const start = performance.now()
// 用空历史 + 服务器基线整体替换 Client 状态，重建未完成的回复前缀。
const visible = client.replace([], baseline)
// 计时结束，得到替换耗时。
const replaceMs = performance.now() - start
// 再次强制 GC，回收替换过程中产生的临时对象。
globalThis.gc()
// 计算 GC 后仍保留的堆内存增量，换算为 MB——这就是"重连后驻留内存"指标。
const retainedMb = (process.memoryUsage().heapUsed - before) / 1048576
// 替换成功后接受一条新的推理 delta 帧，验证流还能继续接续（revision、index 均顺延）。
const next = client.acceptFrame({ type: 'chunk', attemptId, revision: nextIndex + 2, index: nextIndex, time: 1700000000001 + deltas, chunk: { type: 'reasoning-delta', index: 0, text: 'suffix' } })
// 汇总所有测量结果为报告对象，供父进程断言。
const report: ReconnectReport = { deltas, records: baseline.activeAttempt!.stream.length, entries: visible.length, replaceMs, retainedMb, nextFrame: next?.type }
// 以 JSON 行形式把报告写到标准输出，交给基准客户端解析。
process.stdout.write(JSON.stringify(report) + '\n')
