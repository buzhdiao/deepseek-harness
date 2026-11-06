/** Terminal output ingestion and readiness with a deterministic provider boundary. */
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { LocalPtySession } from './session-adapter.ts'

// 1 MiB 的字节数。
const MIB = 1024 * 1024
// 默认数据块大小：16 KiB。
const CHUNK_BYTES = 16 * 1024

/** One fresh-session sample; retained heap includes the live session and returned output. */
// 一次全新会话的采样报告；保留堆包含存活会话与返回的输出。
export interface TerminalIoReport {
  // 本次运行的模式（steady/full/tiny/filtered）。
  mode: string
  // 被测的保留容量（字节）。
  capacityBytes: number
  // 实际使用的数据块大小（字节）。
  chunkBytes: number
  // 预填充（prefill）字节数。
  prefillBytes: number
  // 计时区间内发出的字节数。
  timedBytes: number
  // 摄取（ingest，发出全部数据）耗时（毫秒）。
  ingestMs: number
  // 到达就绪的完成耗时（毫秒）。
  completeMs: number
  // 相对测量前的保留堆增量（字节）。
  retainedHeapBytes: number
  // 结果视口（viewport）文本的字节数。
  viewportBytes: number
  // read 返回文本的字节数。
  readBytes: number
  // 输出是否被截断到有界窗口。
  truncated: boolean
}

async function measure(capacityBytes: number, mode: string): Promise<TerminalIoReport> {
  // 按模式选择块大小：filtered 用 64 KiB，tiny 用 16 字节，其余用默认 16 KiB。
  const chunkBytes = mode === 'filtered' ? 64 * 1024 : mode === 'tiny' ? 16 : CHUNK_BYTES
  // 分配一个全部填充为 x 的数据块。
  const chunk = Buffer.alloc(chunkBytes, 'x')
  // filtered 模式在块内构造 OSC（终端转义序列）负载。
  if (mode === 'filtered') {
    // Each decoded callback has 56 KiB of discarded OSC followed by an 8 KiB string slice.
    // 在块首写入 OSC 启动序列（ESC ]0;，窗口标题设置）。
    chunk.write('\x1b]0;', 0)
    // 在 56 KiB 处写入 BEL（\x07）作为 OSC 结束符。
    chunk[56 * 1024 - 1] = 7
  }
  // 稳态模式先预填充一整个容量，其余模式不预填充。
  const prefillBytes = mode === 'steady' ? capacityBytes : 0
  // 计时字节数按模式确定：filtered 为 513 块，steady 为 1 MiB，其余 5 MiB。
  const timedBytes = mode === 'filtered' ? 513 * chunkBytes : mode === 'steady' ? MIB : 5 * MIB
  // 构造一个 pull 时无事可做的可读流，作为子进程输出源。
  const output = new Readable({ read() {} })
  // 子进程结束结果的 resolver 对（promise 与 resolve 函数）。
  const ended = Promise.withResolvers<SubprocessOutcome>()
  // 首次写就绪的 resolver 对。
  const writeReady = Promise.withResolvers<void>()
  // 构造子进程终端句柄桩：仅提供输出流与最小实现，隔离真实进程。
  const terminal: SubprocessTerminalHandle = {
    // 进程号（桩值）。
    pid: 1,
    // 输出流。
    output,
    // 完成结果 Promise。
    done: ended.promise,
    // 首次写入时解决写就绪 Promise。
    async write() { writeReady.resolve() },
    // 调整尺寸：空实现。
    async resize() {},
    // 活动探测：返回未知状态。
    async inspectActivity() { return { state: 'unknown', revision: 0 } },
    // 前台进程探测：返回桩值。
    async inspectForeground() { return { processGroupId: 1, inputWaiting: false } },
    // 前台信号：返回桩值 1。
    async signalForeground() { return 1 },
    // 终止：结束输出流并解决退出结果。
    async terminate() {
      // 发出流结束事件。
      output.emit('end')
      // 以退出码 0 解决结束结果。
      ended.resolve({ exitCode: 0, signal: null })
      // 等待结果被消费。
      await ended.promise
    },
  }
  // 测量开始前触发一次垃圾回收（GC）。
  global.gc?.()
  // 记录测量前的堆用量基线。
  const heapBefore = process.memoryUsage().heapUsed
  // 创建被测的本地 PTY 会话：容量、滚动缓冲与各类宽限期参数在此指定。
  const session = new LocalPtySession(terminal, {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [],
    rows: 40, cols: 160, scrollbackLines: 10_000, scrollbackMaxBytes: capacityBytes,
    maxReadBytes: Math.min(256 * 1024, capacityBytes),
    pollIntervalMs: 1, exactProbeAfterMs: 150, idleSilenceMs: 1,
    handoffGraceMs: 1, promptTailGraceMs: 0, timeoutMs: 120_000, disposeGraceMs: 1,
  })
  try {
    // 稳态模式先灌入预填充数据，使会话进入满容量稳态。
    if (prefillBytes > 0) {
      // 发起不提交的预填充发送。
      const prefill = session.startSend({ text: 'prefill', submit: false })
      // 等待首次写就绪。
      await writeReady.promise
      // 循环发出预填充数据块（同步 emit，不计时）。
      for (let bytes = 0; bytes < prefillBytes; bytes += chunkBytes) output.emit('data', chunk)
      // 等待预填充到达就绪状态。
      const ready = await prefill.done
      // 预填充必须以“推断空闲”结束，否则会话未进入稳态。
      if (ready.waitReason !== 'inferred_idle') throw new Error('prefill did not reach readiness')
    }
    // 记录计时起点。
    const start = performance.now()
    // 发起被计时的发送操作。
    const operation = session.startSend({ text: '', submit: false })
    // 同步发出全部计时数据块（摄取阶段）。
    for (let bytes = 0; bytes < timedBytes; bytes += chunkBytes) output.emit('data', chunk)
    // 摄取耗时：全部数据发出（不含等待就绪）。
    const ingestMs = performance.now() - start
    // 等待发送完成（到达就绪端点）。
    const result = await operation.done
    // 读取当前保留窗口中的可视内容。
    const read = session.read({ count: 10_000 })
    // 完成耗时：从计时起点到读取结束。
    const completeMs = performance.now() - start
    // 必须到达有界就绪端点：推断空闲且视口与读取结果都被截断。
    if (result.waitReason !== 'inferred_idle' || !result.truncated || !read.truncated) {
      // 未到达有界端点说明行为不符合预期。
      throw new Error('output did not reach bounded ready endpoint')
    }
    // 期望的输出字节数 = min(256 KiB, 保留容量)。
    const expectedBytes = Math.min(256 * 1024, capacityBytes)
    // 视口与读取结果的字节数都必须等于期望值。
    if (Buffer.byteLength(result.viewport) !== expectedBytes || Buffer.byteLength(read.text) !== expectedBytes) {
      // 字节数不符说明有界端点行为异常。
      throw new Error('bounded output endpoint has unexpected byte count')
    }
    // 采样前再次触发 GC，排除待回收垃圾的干扰。
    global.gc?.()
    // 汇总报告：保留堆 = 当前堆 − 测量前堆。
    return {
      mode, capacityBytes, chunkBytes, prefillBytes, timedBytes, ingestMs, completeMs,
      retainedHeapBytes: process.memoryUsage().heapUsed - heapBefore,
      viewportBytes: Buffer.byteLength(result.viewport), readBytes: Buffer.byteLength(read.text),
      truncated: result.truncated && read.truncated,
    }
  } finally {
    // 无论成败都关闭会话。
    await session.close('benchmark complete')
    // 销毁输出流。
    output.destroy()
  }
}

// 断言以编译产物运行，且终端包解析到生产 lib 构建。
assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-terminal': import.meta.resolve('@deepseek-ai/dsh-terminal'),
})
// 解析第一个命令行参数：保留容量（字节）。
const capacityBytes = Number(process.argv[2])
// 解析第二个命令行参数：运行模式。
const mode = process.argv[3]
// 校验参数组合：容量只能是 128 KiB 或 4 MiB，模式只能是四种之一。
if (![128 * 1024, 4 * MIB].includes(capacityBytes) || (mode !== 'steady' && mode !== 'full' && mode !== 'tiny' && mode !== 'filtered')) {
  // 参数不合法即输出用法错误。
  throw new Error('usage: terminal-io.worker.js <131072|4194304> <steady|full|tiny|filtered>')
}
// 执行测量并把报告序列化为 JSON 输出（父进程解析最后一行 JSON）。
console.log(JSON.stringify(await measure(capacityBytes, mode)))
