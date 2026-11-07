// 在完整持久化 Session（会话）上做固定尺寸的续聊资格（continuation eligibility）判定。
/** Constant-size continuation eligibility over the complete durable Session. */

// 副作用导入：拉取本包的 Session 事件类型环境。
import type {} from './types.ts'
// ProjectionDefinition（投影定义）：会话投影（session-projection）子系统对增量状态机的描述接口。
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// SessionSeq（会话序号）：事件日志中持久化序号的品牌（brand）类型。
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
// brandNumber：把普通数字收窄成品牌数字的工具。
import { brandNumber } from '@deepseek-ai/dsh-brand'
// zod：运行时模式（schema）校验库。
import { z } from 'zod'

// Explicit manual requests use a fixed product policy, independent of automatic retry configuration.
// 显式手动请求使用固定的产品策略，与自动重试配置无关。
// 可续聊失败码（continuable failures）白名单：只有这些错误码允许触发"继续生成"。
const CONTINUABLE_FAILURES: ReadonlySet<string> = new Set([
  // 限流、服务端错误、超时、传输错误、空响应、流被关闭。
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
])

// 结束序号模式：非负整数并转换为 SessionSeq 品牌，允许为 null（无资格）。
const endingSchema = z.number().int().nonnegative().transform(brandNumber<SessionSeq>).nullable()
// 状态模式：是否已有被接纳的人工输入、最近一步是否失败、资格结束序号。
const stateSchema = z.object({
  // 已接纳（admitted）：本轮是否出现过真实用户输入。
  admitted: z.boolean(),
  // 失败尝试（failedAttempt）：最近的请求步骤是否以失败收场。
  failedAttempt: z.boolean(),
  // 结束（ending）：满足续聊条件的 turn/end 事件序号，null 表示不满足。
  ending: endingSchema,
})

// 可恢复的手动续聊事实：由"已接纳的用户输入"与"空内容重试消息"共同推导。
/** Recoverable manual-continuation facts over admitted user input and empty retry messages. */
export type ContinuationState = z.infer<typeof stateSchema>

// 初始状态：未接纳、未失败、无结束序号。
const EMPTY: ContinuationState = { admitted: false, failedAttempt: false, ending: null }

// 资格判定要求：存在被接纳的人工劳动，且最近一次请求步骤以失败收场。
/** Eligibility requires admitted human work and a failed settlement in the last request step. */
export const continuationProjectionDefinition = {
  // 投影键：客户端据此读取该投影的值。
  key: 'conversationContinuation',
  // 状态版本号：状态形状变更时递增以触发重算。
  stateVersion: 4,
  // 复用上面的状态模式做校验。
  stateSchema,
  // 初始化：新会话从空状态开始。
  init: (): ContinuationState => EMPTY,
  // 逐事件折叠状态（reduce）。
  apply: (state, event) => {
    // 按事件类型分派。
    switch (event.type) {
      // 新一轮开始：重置全部续聊事实。
      case 'turn/start':
        return EMPTY
      // 步骤开始或助手消息到达：说明生成在推进，清除上一步的失败标记。
      case 'step/start':
      case 'assistant/message':
        return state.failedAttempt ? { ...state, failedAttempt: false } : state
      // 用户消息：判断是否为"被接纳的真实输入"或"空内容重试"。
      case 'user/message':
        // 仅接受追加（append）表面且尚未接纳过的情况。
        return !state.admitted && event.surfaceOp === 'append'
          && ((event.data.source.kind === 'user' && event.data.content.length > 0)
            || (event.data.source.kind === 'retry' && event.data.content.length === 0))
          ? { ...state, admitted: true } : state
      // 助手尝试事件：标记本轮出现了失败的请求步骤（幂等）。
      case 'assistant/attempt':
        return state.failedAttempt ? state : { ...state, failedAttempt: true }
      // 回合结束：综合失败码与前置条件计算结束序号。
      case 'turn/end': {
        // 只有失败原因在白名单内、且已接纳输入、且最近步骤失败时，才记录该事件序号作为资格结束点。
        const ending = event.data.reason.kind === 'error' && CONTINUABLE_FAILURES.has(event.data.reason.error.code)
          && state.admitted && state.failedAttempt ? event.seq : null
        // 无资格则回到空状态，否则带着结束序号重建（failedAttempt 已被 turn/end 消化）。
        return ending === null ? EMPTY : { ...EMPTY, ending }
      }
      // 其余事件不影响该投影。
      default:
        return state
    }
  },
  // 线上（wire）视图：对外只暴露结束序号，压缩传输体积。
  wire: {
    // 视图模式复用结束序号模式。
    viewSchema: endingSchema,
    // 视图投影函数：从完整状态中取出结束序号。
    view: (state: ContinuationState) => state.ending,
  },
} satisfies ProjectionDefinition<'conversationContinuation', ContinuationState>
