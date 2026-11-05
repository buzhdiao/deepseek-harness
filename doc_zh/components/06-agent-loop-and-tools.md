# 06 · agent 循环与工具调用

**步与回合。** docs/architecture.md:83 定义：一个 **step（步）** = 一次模型请求 + 它调用的工具；一个 **turn（回合）** = 零或多个步，回合在「认领下一条输入」前打开，在「无所欠」时关闭。权威流程图在 docs/architecture.md:85-106：`turn/start` → 认领输入 + 快照模型选择 → `agent/pre-step`（监听器可改写或拒绝认领消息）→ `step/start` → `agent/request`/`prepareCall`（取消发生在这两个异步阶段则什么都不提交）→ 组装提示词 + 冻结模型历史 → 绑定的调用开始流式输出（`llm/stream` → `agent/assistant-stream` 分帧）→ `tool/call*` → `tools/pre-execute → tools/execute → tools/post-execute → tool/result*` → `step/end`；工具还欠一次请求或来了新输入就继续下一步，否则 `agent/turn-stopping` → `turn/end`。

**驱动器。** 默认实现 `AgentLoop`（packages/core/agent-loop/src/index.ts:290，`extends Service implements AgentFactory`）在 `ctx.agents` 背后供给驱动：配置声明式 agent 随插件加载自动启动（agent-loop README 的 YAML 示例：`agents: [{ id, provider, model, cwd }]`），编程式创建/恢复走 `ctx.agents` API。重要语义：重试不重复组装与 `agent/pre-step`；取消保留已送达用户的流式文本；失败步骤会为缺失的工具结果补记录（docs/architecture.md:116-118）。

**工具管线。** 工具注册在 `ctx.tools`（`ToolsService`，packages/core/tools/src/index.ts:99），schema 随提示词组装进入请求；三个 waterfall 扩展点（tools/src/events.ts:18、:29、:41）构成守卫链——`tools/pre-execute` 可否决或改写预工具决定，`tools/execute` 包裹真正执行（`ctx.tools.execute()` 接收原始批次与并发上限，docs/architecture.md:122），`tools/post-execute` 在结果定稿前介入。批内并发默认 10，`maxParallelToolCalls=1` 退化为串行（agent-loop README 配置表）。执行器的选择是又一个能力缝：本地原生执行器（`tool-executor-native`）、PTC 执行器、终端执行器等实现同一接口，dispatch/并发/取消/工具日志归当前执行器所有（agent-loop README Summary）。

**事件三域。** 会话事件（持久）、代理事件 `agent/*`（活体：inbox、step、status、request…）、能力事件（`fs/*`、`tools/*`、`telemetry/*`，把策略/适配器接到缝上而不 import 循环）——docs/architecture.md:68-74。想观察或拦截在途工作用 `agent/*`，想改持久事实必须追加会话事件。

逐行注释未覆盖这两个包（聚焦内核+Session+preset），但其 README 与 docs/tool-execution-pipeline.md 是官方级精读材料；`toolHistory()`（session/src/index.ts 的工具历史折叠）展示了日志如何反哺后续请求的工具声明投影。

> 关键索引：packages/core/agent-loop/src/index.ts:290；packages/core/tools/src/index.ts:99、events.ts:18-49；docs/architecture.md:85-122。
