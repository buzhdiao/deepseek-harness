// 模块说明：WebController——Web 端打开（opening）聚合：借出一次观测产出快照帧，
// 事件、投影与助手输出共享同一个变换缓冲（ListenerBuffer），快照之后只转发未被
// 快照覆盖的增量；可选的激活（promotion）在快照送达前启动、独立持有租约。
/** Web opening aggregation over one observation and a shared transforming buffer. */

// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 导入从任意错误中提取远程错误的工具
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// 导入 Session 观测类型
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
// 导入 HistoryController 类型
import type { HistoryController } from '../history/controller.ts'
// 导入地址解析与 404 拒绝辅助
import { addressId, rejectNotFound } from '../history.ts'
// 导入事件监听器与监听缓冲
import { EventListener, ListenerBuffer } from '../history/listener.ts'
// 导入历史分页、投影与校验辅助
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
// 导入跟随（follow）帧与请求的对外类型
import type { SessionFollowFrame, SessionFollowRequest } from '../types.ts'

/** 把打开数据与监听器变换后的输出合并到同一个队列消费。 */
export class WebController {

  /**
   * @param ctx - 携带 Session 查询与身份投影的宿主上下文。
   * @param historyController - 被动读取与监听器构造。
   * @param promote - 在打开快照送达之前请求的后台激活（activation）。
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
  ) {}

  /**
   * 打开一个历史快照并跟随（follow）未覆盖的历史与助手通知。
   * @param request - Session 身份、分页预算、助手输出与可选激活（默认 false）。
   * @param signal - 打开与流式传输的取消信号。
   * @returns 先产出打开快照，之后是未覆盖的排队增量。
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    // 解析地址得到会话 id
    const sessionId = addressId(request.address)
    // 校验并解析分页窗口（补齐消息预算）
    const spec = resolveHistoryRequest(request)
    // 创建共享的跟随帧缓冲（using：生成器退出时自动释放）
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    // 创建事件监听器：复用调用方提供的 queue 作为缓冲
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    // 取出助手输出流监听器的重连状态
    const streams = this.historyController.streamsListener
    // 请求了助手流时，把该会话绑定到同一个 queue（using：按需创建）
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    // 借出一次带投影的观测；会话不存在时映射为针对地址的 404
    using observation = await this.historyController.usingObservation({ sessionId, projection: true }, signal)
      .catch((error: unknown) => {
        // 会话不存在：映射为针对该地址的 404
        if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
        // 其余错误原样向上抛出
        throw error
      })
    // 校验地址与观测一致
    validateObservationAddress(request.address, observation)
    // 组装打开快照帧：头部、投影与历史分页数据
    let opening: SessionFollowFrame = {
      type: 'snapshot',
      header: { ...observation.header },
      projections: projections(observation),
      ...history(observation, spec),
    }
    // 把快照的游标设为监听器的开启切点：之后只转发未覆盖的增量
    listener.setCursor(opening.cursor)
    // 助手流开启时：取其基线与序号
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      // 基线并入打开快照
      opening = { ...opening, assistantStream }
      // 把序号切点设为基线末尾，之后的助手增量才进入队列
      assistantListener.setOrdinalCut(ordinal)
    }
    // Increments come from the queue, so the opening ends this lease in every branch;
    // activation continues on its own retained lease. Promotion starts before the opening is
    // delivered, so a consumer that stops after the snapshot still gets the activation it asked for.
    // 请求了激活且未取消、非 subagent、观测来自 prepared：为提升（promotion）单独保留租约
    if (request.activate === true && !signal.aborted
      && observation.header.origin !== 'subagent' && observation.source === 'prepared') {
      // 从当前观测复制一个新租约交给提升流程
      const promotion = observation.retain()
      // 立即释放本生成器自己的观测租约（增量走队列，不再需要它）
      observation[Symbol.dispose]()
      try {
        // 把保留的租约交给宿主的激活（promote）流程
        this.promote(promotion)
      } catch (error: unknown) {
        // 提升接管失败：释放租约再抛出，避免泄漏
        promotion[Symbol.dispose]()
        throw error
      }
    } else {
      // 不激活：直接释放观测租约
      observation[Symbol.dispose]()
    }
    // 产出打开快照（此时租约处理已完毕，各分支一致）
    yield opening
    // 之后转发队列中未覆盖的增量帧
    yield* queue.items()
  }
}
