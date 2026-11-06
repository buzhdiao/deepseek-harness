/** Current-generation benchmark seeds retain the system head across continuation. */
// 文件头（JSDoc 补充）：校验新一代基准的种子（seed）数据在续跑（continuation）后仍保留受保护的系统头部（system head）。
import { expect, it } from 'vitest'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { syntheticHistory as browserHistory } from '../long-session-browser/synthetic-history.ts'
import { syntheticHistory } from './workload.ts'

// 两种合成历史共用的会话头记录：固定版本、ID、时间戳、工作目录、未播种与零委托深度。
const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'benchmark-seed-check', createdAt: 1_700_000_000_000, cwd: '/bench', isSeeded: false, delegationDepth: 0 }

// 分别对两种合成历史生成器（continuation 场景与 browser 场景）跑同一套断言。
for (const [name, generate] of [
  // continuation 历史：会话头 + 2 个回合的事件序列化后拼接。
  ['continuation', () => [JSON.stringify(header), ...syntheticHistory(2).map(event => JSON.stringify(event))].join('\n')],
  // browser 历史：来自 long-session-browser 的生成器（已是字符串）。
  ['browser', browserHistory],
] as const) {
  it(name + ' seed preserves a protected head when the next prompt replaces it', () => {
    // 把会话日志文本解析为事件列表。
    const events = parseSessionLog(generate())
    // 种子前 4 个事件必须依次为：回合开始、步骤开始、系统消息、用户消息。
    expect(events.slice(0, 4).map(event => event.type)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message'])
    // 用这些事件创建会话对象。
    const session = Session.create(SessionId(header.id), events)
    // 表面（surface）视图的首节点即受保护的系统头部。
    const head = session.surface.nodes[0]!
    // 校验头部节点对应的事件确为系统消息（第 1 回合第 1 步、内容为空的角色 system）。
    expect(session.eventAt(head)).toMatchObject({ type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: [] } } })
    // 记录替换前的派生消息（deriveMessages）基线。
    const history = session.deriveMessages()
    // 新回合编号 = 现有回合数 + 1。
    const turn = events.filter(event => event.type === 'turn/start').length + 1
    // 追加新回合的开始事件与步骤开始事件。
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    // 用新的系统消息做 replace 面操作（surfaceOp）：把旧的系统头部替换掉，并注明来源事件序号。
    const replacement = session.append('system/message', {
      turn, step: 1, message: createSystemMessage('Next synthetic prompt'),
    }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] })
    // 把替换后的会话快照重新序列化，再完整重放创建"恢复后的会话"。
    const restored = Session.create(SessionId(header.id), parseSessionLog([
      JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify(event)),
    ].join('\n')))
    // 恢复后的表面首节点必须是新的替换系统消息——证明头部保护在续跑后仍然生效。
    expect(restored.surface.nodes[0]).toBe(replacement.seq)
    // 恢复后的派生消息首条必须就是新的系统提示词内容。
    expect(restored.deriveMessages()[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'Next synthetic prompt' }] })
    // 其余消息必须与替换前的基线完全一致——只换了头部，历史原封不动。
    expect(restored.deriveMessages().slice(1)).toEqual(history)
    // 最后做引用一致性抽查：标题与工具结果事件都能正确回指其源事件。
    for (const event of events) {
      // session/title 事件的 messageSeqs 首项应指向一条 user/message。
      if (event.type === 'session/title') expect(session.eventAt(event.data.messageSeqs[0]!)?.type).toBe('user/message')
      // tool/result 事件的 sourceEventSeqs 首项应指向一条 tool/call。
      if (event.type === 'tool/result') expect(session.eventAt(event.sourceEventSeqs![0]!)?.type).toBe('tool/call')
    }
  })
}
