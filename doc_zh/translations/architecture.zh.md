# DeepSeek Harness 架构（translations 版 · 学习型译本）

> **说明**：仓库官方中文版为 `docs/architecture.zh.md`（171 行，随英文版同仓维护）。本文按英文 `docs/architecture.md`（v0.2.2-rc.1，171 行）独立翻译，供 `doc_zh/` 学习体系引用；术语以官方译本为准（profile=档案、bundle=束等处本文保留英文原名以免歧义）。英文原文：[docs/architecture.md](../../docs/architecture.md)。

[English](../../docs/architecture.md) | 中文

修改 `packages/` 下任何内容前先读本文。本文假设你了解 Cordis；不了解请从[入门](https://github.com/cordiverse/cordis)或官方 `docs/cordis-primer.zh.md` / `docs/cordis-tutorial/` 开始。

## Cordis

Cordis 是 dsh 之下的框架：插件向一个共享上下文贡献服务、类型化事件与可逆 effect。产品的每一部分都是插件——模型适配器、工具注册表、会话日志、乃至 agent 循环本身——因此每一个都能从配置里替换。

没有需要打补丁的特权核心：你通过在别的插件旁边挂载一个新插件来扩展 dsh；注册都是 effect，插件卸载时按序回退。

## Profile 与 Bundle

一个运行中的 `dsh` 是一棵在启动时由有序层组合而成的插件树。

**Profile** 是存在 Harness home 里的命名组合：列出它叠加的 bundle、存放其安装的树外插件、保留用户自己的 `cordis.patch.yml`。`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 以模板形式发布。

**Bundle** 是「Cordis 配置行 + 它们挂载的代码」的分发格式，因此它插入的内容仍可被其上的层 patch。

各自在自己的 `package.json` 的 `dsh` 字段里声明：`dsh.profile` 列出 profile 的 bundle，`dsh.bundle` 指向 bundle 的 patch 文件。

[`dsh-base`](../../packages/bundle/base/README.zh.md) 是 `web`/`headless`/`sdk`/`acp` 四类 profile 共享的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。[`dsh-web-app`](../../packages/bundle/web-app/README.md) 叠加浏览器应用，[`dsh-headless`](../../packages/bundle/headless/README.md) 叠加无服务器的单发运行器，[`dsh-sdk-app`](../../packages/bundle/sdk-app/README.md) 叠加 SDK JSON-RPC 服务器，[`dsh-acp-app`](../../packages/bundle/acp-app/README.md) 叠加仅供自动化的 ACP 服务器。[`dsh-sdk-minimal`](../../packages/bundle/sdk-minimal/README.md) 是刻意的例外：单一 bundle 拥有完整显式的 SDK 树，不应用 `dsh-base`。

各层作用于空入口列表：profile 的有序 bundle、其 `cordis.patch.yml`、home 补丁、然后是 `--patch` 覆盖层。patch 按 id 定位一行并整行替换其配置，或插入新行。`preset` patch 在该声明的 `config.plugins` 内应用同样的操作，层级优先级相同。

YAML 控制 HMR：base 启用仅配置的 `dsh-hmr`；headless、SDK、ACP 禁用它；`sdk-minimal` 不含它。Profile patch 可覆盖这些默认。HMR 协调监听与重载；launcher 提供档案数据与就绪信号。

Base 为 Web 与 agent 包含[插件管理器](../../packages/boot/plugin-manager/README.md)。

查看你机器启动的树：

```sh
dsh --profile web --dump-config
```

它打印的任何一行都可以被你自己的 patch 替换。

组合机制见 [app-boot](../../packages/boot/app-boot/README.md)；配置字段见生成的[配置目录](../../docs/config-catalog.md)。

## 应用启动

受支持的 Node 应用通过命名的 `dsh` profile 启动。内置 profile 是 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`，用 `dsh --profile <name>` 或 `dsh <name>` 选择。`plugin` 是管理命令的名字；同名的 profile 需要 `--profile plugin`。TypeScript SDK 解析其同版本 `dsh` 依赖并选择 `sdk`；自定义插件组合仍然是「一个 profile + 有序 patch 文件」，不是另一个可执行文件或内联应用树。`sdk-minimal` 是同一 launcher 背后的仓库自有独立 bundle，不是调用方提供的 Cordis 树。

内嵌 CLI、仅构建/仅测试的可执行文件、直接进程内插件挂载、私有浏览器 WebWorker 预览都不是 Harness 应用启动器。[verify-application-entrypoints](../../scripts/verify-application-entrypoints.ts) 把每个包 bin、可执行源码、根 demo、根 `start:web` 与 `dev:web` 脚本归入显式类别，并拒绝绕过 `dsh` 的 Node 应用路径。

Python SDK 遵循同一应用架构：其运行时 wheel 把常规 `dsh` CLI 打包为 `deepseek-harness-sdk-runtime-<platform>-<arch>`，客户端默认以显式 Harness home 启动 `dsh --profile sdk`；最小示例选择 `sdk-minimal`。Python 暴露 profile 选择与有序 patch 文件而非完整 Cordis 树；持久外部插件经 `dsh plugin` 安装。

## 桌面应用

[Electron 桌面应用](../../apps/desktop/README.md)在签名资源中携带其精确的 dsh 生产运行时，并拥有保留的 `$DSH_HOME/profiles/desktop`。共享助手初始化 profile 文件、对账 bundle、在替换 pnpm 所属包之外解析安装与 bundle 依赖。桌面与 npm CLI 共享产品数据，但保持包、激活与锁文件分离。

Electron 以 Electron Node 模式启动私有 Desktop Host。Host 调用共享 CLI profile 运行器与完整 Web 应用；窗口立即加载打包的 Web 资产，并在同一文档里等待引导注入后激活客户端插件。Web 拥有 RPC 与流；桌面载体把本地页面连接到已认证的 Host。Node IPC 传递引导注入、就绪、致命错误与关停。桌面默认监听 OS 分配的端口，profile 配置可覆盖。

## 核心包

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| `core/session` | 只追加的 `SessionEvent` 日志与内存商店 | `ctx.sessions` |
| `core/system-prompt` | 提示词 section 与工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域化工具注册表与守卫执行管线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、活注册表与 `agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现该接口的默认驱动 | `ctx.agentLoop` |
| `core/scope` | 每 agent 的作用域化注册原语 | 库，无键 |
| `llm/llm` | 消息与流词汇 + 适配器缝 | `ctx.llm` |

## 事件

事件在三个领域提供扩展点。

- **会话事件**是追加进日志的持久事实，经 `session/event` 广播。事实需要跨重载存活时用它。
- **代理事件**（`agent/*`）携带活的 `Agent`：inbox、step、status、request、validation、continuation。观察或拦截在途工作时用它。
- **能力事件**把策略与适配器接到缝上（`fs/*`、`tools/*`、`telemetry/*`），无需 import 循环。

Subagent Activation 拥有运行时树成员关系。

AgentLoop 回滚失败的初始化，并在排队工作前等待串行的 `agent/created`；卸载经 teardown 保留资源（[排序](../../packages/core/agent-loop/README.md)）。

事件的生产者与消费者：`docs/event-producer-consumer.md`。

## 回合流

**步**是一次模型请求及其调用的工具。**回合**是零或多个步：在其第一条输入被认领前打开，在无所欠时关闭。

```text
turn/start
  认领下一步输入外加一条排队消息
  快照 Session 模型选择；组装提示词 section + 步准入的工具 schema
  -> agent/pre-step；在 fallback 处投影运行时上下文
                                     拒绝 | enter(messages, startsRequestSeries?)
     拒绝，或首个 enter 被改写为空 -> 无步关闭回合
     step/start
     agent/request -> prepareCall（取消不提交系统与用户）
     用准备调用的能力对账 system/message
     把进入的消息作为 user/message 追加；对账保留的运行时上下文
     按需记录 request/header 与 request/context
     从日志派生并冻结模型历史
     流式执行绑定的准备调用 -> llm/stream -> agent/assistant-stream start
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     工具欠下一次请求，或下一步输入已到达 -> 认领 -> 下一步
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/*` 是持久会话事件；其余是跨三个领域的活扩展点。`agent/assistant-stream` 发布进程内 start、瞬态 chunk 与 end 帧；循环在已提交的 end 帧之前，把完整压缩流作为一条消息或仅日志的 attempt 提交；Web 的 Session-follow 适配器是活事件的唯一远程消费者。`agent/pre-step`、`agent/request`、`llm/stream` 与三个 `tools/*` 事件是 waterfall，监听器必须调用 `next()` 委托；`agent/turn-stopping` 是串行的，没有 `next()`。

工厂 setup 遵循 SessionStore 进入与 `session/created`，先于 `agent/created`；关闭事件在移除前提交。

一个 inbox 喂给驱动器；注入的上下文等待唤醒消息。AgentLoop 的持久 `inbox` 投影在没有活 Agent 时也暴露待处理输入。

组装前，循环在 `AssembleContext.modelSelection` 与 `agent/pre-step.modelSelection` 快照 Session 模型选择；重试保留它；缺省的推理力度用适配器默认。`agent/pre-step` 监听器接受、改写或拒绝认领的消息；被拒绝或首个认领为空会无步关闭持久回合。enter 决定可设 `startsRequestSeries`：循环记录新 `request/header`（reason 为 `series`，或信封也变时为 `change` + `startsSeries: true`）。包装监听器用 `{ ...decision, messages }` 保留该声明。组装与 `step/start` 之后，弃用的 `agent/request` 钩子在不改变 provider/model/effort 选择的前提下调整控制；`prepareCall()` 在系统提示与已接受用户提交之前绑定适配器；两个异步阶段中的取消都不提交。准备调用的能力治理提示词准入，而非此前的 `request/context`。每次尝试刷新已注册的运行时事实、对账绑定的提示词、一次性准入用户、恢复被移除的运行时上下文、按需记录 header/context，并在流式执行绑定的调用前冻结请求。重试不重复组装或 `agent/pre-step`。附件启动后的表面替换与图像下放决定会开启新请求序列，包括首个恢复的 pre-step；不变的恢复延续序列。系统提示词以 `system/message` 历史传递：空文本清除它，有能力的路由追加更新，其余路由在首个 system 节点合并。[Agent-loop](../../packages/core/agent-loop/README.md) 拥有提示词准入与替换细节。

循环发送带活取消的不可变请求，并为冻结身份复用冻结证据；[agent-loop](../../packages/core/agent-loop/README.md) 拥有构造与取消原因。

失败步骤[记录缺失的工具结果](../../packages/core/agent-loop/README.md)。

细节：[时序图](../../docs/agent-lifecycle.md)、[工具管线](../../docs/tool-execution-pipeline.md)、[取消与错误恢复](../../docs/subsystems/core.md)。

[`ctx.tools.execute()`](../../docs/subsystems/tools.md) 接收原始批次与并发上限。

## 会话日志

会话日志是模型所见上下文的源头。`deriveMessages()` 从它投影模型历史。每条 `assistant/message` 内嵌产生其组装内容的精确压缩定时流；`assistant/attempt` 保留已落定的失败、重试、取消与流错误尝试而不增加模型历史。fork、恢复、转录、遥测与持久化全部从这些持久落定派生，活 UI 的增量来自 `agent/assistant-stream`；在落定前的硬进程损失不留下持久 attempt 流（决策记录见 `.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md`）。

会话消费者只认识当前逻辑格式。仅头的 `stat` 与 `list` 重扫每个 Session 目录、选择其数值最高的正典世代，并在不加载事件、不发布后继的前提下翻译受支持的历史头。存储会话的 `open` 选择同一世代、拒绝未来版本，或一次性解码并组合构建期静态的相邻迁移链，然后返回校验过的当前逻辑事件。读 open 使用该内存结果而不发布后继；写 open 先编码、校验并独占地在未改动的源旁边发布最终的版本命名后继。未封口的受损尾部的普通修复仍是句柄消费者的责任；迁移只为「已被后续 `turn/start` 封口的有限已发布重启」插入缺失的 `turn/end`。JSONL v0 用 `session.jsonl[.zstd]`，v1 及以后用小写 `session.vN.jsonl[.zstd]`，已提交世代路径永不改名、替换或删除。JSONL 提供者拥有物理分帧、压缩、世代选择与独占发布；每个相邻迁移包恰好拥有一个 `vN -> vN+1` 步（决策见 `.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md`）。

**模型可见即已记录。** 每个模型请求都必须能从日志重建；新的模型可见输入需要会话事件。改动既有消息内容的插件注册[纯消息投影](../../docs/subsystems/session.md)；分离读取者显式提供相同定义。工具变更是能力无关的；Session 工具历史供给 provider 声明。

**投影缝。** `dsh-session-projection` 拥有 `ctx.sessionProjections`：注册单元折叠已提交事件；载体经 `snapshot()` 读取选定的客户端视图。领域服务等待注册、保留私有句柄、暴露业务方法（[注册生命周期](../../packages/session/session-projection/README.md)）。`AgentRegistry` 经 `turnBoundaryOf(session)` 暴露回合与步状态；`AgentLoop` 拥有 `modelSelection` 与 inbox 状态。

[工作目录](../../docs/subsystems/working-directory.md)在不改变原项目身份、沙箱写根与既有进程目录的前提下供给用户上下文与执行路径。

## 能力缝

**缝**是一个可替换的能力，带三个角色：声明接口的**服务定义（Service Definition）**、实现它的**服务提供者（Service Provider）**、使用它的**消费者（Consumer）**（通常是模型工具）。一个包可以兼多角，但单角不构成缝；添加能力意味着设计全部三角（[能力图](../../docs/capability-seams.md)）。

缝是「换一个 provider 改变整个产品」的原因。文件系统与子进程 provider 共享一个执行世界，把它们指向远程沙箱，Bash、PTY 与 LSP 一起搬走，没有 provider 分叉。[子代理 provider](../../docs/subsystems/subagent.md) 同样在一个接口后面千变万化——从全新子代理到另一产品中的受托回合。

启用后，[Agent Teams](../../docs/subsystems/agent-team.md) 为根 Session 增加任务策略与共享任务板。普通子代理控制拥有身份、消息、发现、中断与 inbox 等待。

## 新行为放在哪里

新行为挂到文档化的扩展点。改动循环本体则更新此表。

| 目标 | 机制 |
|---|---|
| 加模型提供方 | 在 `ctx.llm` 注册其适配器 |
| 加模型可见能力 | 在 `ctx.tools` 注册；其 schema 加入提示词组装 |
| 给一个会话不同的能力集 | 组一个 agent preset；其中的服务行需要 `isolate` realm |
| 加 shell 执行 | 注册 `ctx.shell` 后端；本地实现经 `ctx.subprocess` 派生 |
| 加持久终端执行 | 注册 `ctx.terminals` 后端外加 `dsh-tool-terminal` |
| 加人类命令 | 在 `ctx.commands` 注册；不经模型回合即可派发 |
| 管理后台任务 | 在 `ctx.jobs` 注册；`job_*` 工具读取或停止任务 |
| 从外部 webhook 启动会话 | 在 `ctx.webhookRuntime` 注册受信规则并挂载 provider 适配器 |
| 加文件系统访问或策略 | 注册 `ctx.fs` provider 或监听 `fs/*` 事件 |
| 限制派生进程 | 用 `ctx.sandbox` 后端；消费者在 spawn 前包装 argv |
| 拦截请求、工具或回合 | 用其 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 停止回合 |
| 加模型可见上下文 | 调 `agent.inject()`；落入下一条已准入请求 |
| 加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + 带键渲染器 |
| 加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染与重放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` provider |
| 管理同会话目标 | 用 `ctx.goals`；经 `agent/*` 继续 |
| 在回合边界 fork | `ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { isSeeded: true } })`——只有 agent-loop 发布的会话会持久化 |
| 在新后端存储会话 | 在共享句柄脚手架上实现 `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） |
| 把注册限定到一个 agent | 用该 agent 的 `agent.ctx` |

[扩展烹饪书](../../docs/cookbook/extension-cookbook.md)把特性映射到能力，并索引分步指南：[加包](../../docs/cookbook/adding-a-package.md)、[加工具](../../docs/cookbook/adding-a-tool.md)、[加 LLM 适配器](../../docs/cookbook/adding-an-llm-adapter.md)、[加设置卡片](../../docs/cookbook/adding-a-settings-card.md)。[会话子系统](../../docs/subsystems/conversation.md)拥有 Chat 节点组装。
