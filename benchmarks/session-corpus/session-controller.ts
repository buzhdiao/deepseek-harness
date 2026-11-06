/** Session-controller initialization for synthetic corpus workers without attachment I/O. */
// 文件头（JSDoc 补充）：为合成语料（corpus）worker 提供会话控制器（Session controller）的初始化——不含附件 I/O。

import { Service, type Context } from '@deepseek-ai/cordis'
import SessionController, { type Config } from '@deepseek-ai/dsh-api-session-controller'

// 基准专用的会话控制器子类：把内部初始化方法暴露为公开的 initialize()，便于 worker 手动触发。
class BenchmarkSessionController extends SessionController {
  initialize(): Promise<void> {
    return this[Service.init]()
  }
}

/**
 * Initialize the controller against the worker's partial Host services.
 * @param ctx - worker context owning service disposal.
 * @param config - native-opener and list-scheduling settings.
 * @returns controller ready for list, search, and fork calls.
 */
// 中文补充（JSDoc）：针对 worker 的部分 Host 服务初始化控制器。
// 中文补充（JSDoc）：@param ctx —— 拥有服务销毁（disposal）职责的 worker 上下文（context）。
// 中文补充（JSDoc）：@param config —— 原生打开器（native-opener）与列表调度（list-scheduling）设置。
// 中文补充（JSDoc）：@returns —— 可直接用于 list、search 与 fork 调用的控制器。
export async function createBenchmarkSessionController(ctx: Context, config: Config): Promise<SessionController> {
  // 注入一个最小化的 attachments 服务：只声明图片限制，不做真实附件读写。
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: ['image/png'],
    },
  } as never)
  // 创建控制器实例：canOpenPath 恒为 false，禁用本地路径打开能力。
  const controller = new BenchmarkSessionController(ctx, config, { canOpenPath: () => false })
  // 执行初始化并返回就绪的控制器。
  await controller.initialize()
  return controller
}
