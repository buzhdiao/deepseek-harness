/** Compiled synthetic model for the shipped sdk-minimal profile; tools remain production plugins. */
// 文件头（JSDoc 补充）：为随发行版附带的 sdk-minimal 配置（profile）提供的编译版合成模型；工具仍走生产插件路径。

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { response, WORKLOAD } from './workload.ts'

// 配置基准专用的合成 LLM 适配器：交替产生"纯回复"与"工具调用"两种回合。
class ProfileAdapter extends LlmAdapter {
  // 已处理请求数（用于决定本回合行为）。
  private requests = 0
  // 模型解析原样透传，并声明 100 万 token 的上下文窗口。
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 1_000_000 })
  }

  // 流式生成：奇数序号回合返回纯文本回复；偶数序号回合产生 WORKLOAD.toolsPerLiveTurn 个工具调用后结束。
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const serial = this.requests++
    if (serial % 2 === 1) {
      yield* response(200_000 + serial, 0).chunks
      return
    }
    // 每个工具回合生成 toolsPerLiveTurn 个对 str_replace_editor 工具的调用块。
    for (let index = 0; index < WORKLOAD.toolsPerLiveTurn; index++) {
      // 调用 ID 由回合序号与块序号唯一确定。
      const id = ToolCallId('profile-call-' + String(serial) + '-' + String(index))
      // 工具参数为查看当前目录下 synthetic.txt 的 view 命令（走真实文件读取路径）。
      const args = JSON.stringify({ command: 'view', path: process.cwd() + '/synthetic.txt' })
      // 声明工具调用块开始。
      yield { type: 'block-start', index, blockType: 'tool-call' }
      // 以增量（delta）形式给出调用 ID、工具名与参数。
      yield { type: 'tool-call-delta', index, id, name: 'str_replace_editor', argumentsDelta: args }
      // 完整结束该调用块，附上最终参数。
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'str_replace_editor', arguments: args } }
    }
    // 以"存在工具调用"的原因结束本轮，驱动 agent 执行工具后继续。
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Loader plugin identity. */
// 中文补充（JSDoc）：插件（plugin）加载器使用的插件名。
export const name = 'backend-profile-benchmark-model'
/** The scripted provider requires the production LLM registry. */
// 中文补充（JSDoc）：注入 llm 服务——脚本化的 provider 需要注册到生产 LLM 注册表中。
export const inject = ['llm']

/**
 * Register the synthetic provider without changing any runtime services or tools.
 * @param ctx - profile-owned plugin context.
 */
// 中文补充（JSDoc）：注册合成 provider，但不改动任何运行时服务或工具。
// 中文补充（JSDoc）：@param ctx —— profile 自有的插件上下文（context）。
export function apply(ctx: Context): void {
  // 把 ProfileAdapter 注册到 'bench' provider 名下。
  ctx.effect(() => ctx.llm.registerAdapter(['bench'], new ProfileAdapter()))
}
