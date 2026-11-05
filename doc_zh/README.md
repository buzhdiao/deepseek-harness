# DeepSeek Harness 中文学习文档（doc_zh）

本目录是面向中文读者的**学习型文档工程**，与仓库官方文档（`docs/`、各包 `README.zh.md`）互为补充：官方文档描述「现在是什么」，本目录解释「为什么这样设计、代码里在哪里落地」。所有内容基于 master 分支（v0.2.2-rc.1）的真实代码编写，引用均带 `文件:行号` 定位。

## 目录

### 组件原理（components/）

| 编号 | 主题 | 文件 |
|---|---|---|
| 01 | 总体架构与 monorepo 布局 | [components/01-overview-monorepo.md](components/01-overview-monorepo.md) |
| 02 | Cordis 内核原理：上下文/服务/插件生命周期 | [components/02-cordis-kernel.md](components/02-cordis-kernel.md) |
| 03 | 「一切皆插件」设计如何落地 | [components/03-everything-is-a-plugin.md](components/03-everything-is-a-plugin.md) |
| 04 | Session 与 preset 体系 | [components/04-session-and-preset.md](components/04-session-and-preset.md) |
| 05 | Web UI 与 server 架构（`npx @deepseek-ai/dsh web` 启动链路） | [components/05-web-and-server.md](components/05-web-and-server.md) |
| 06 | agent 循环与工具调用 | [components/06-agent-loop-and-tools.md](components/06-agent-loop-and-tools.md) |
| 07 | 插件生态与 `dsh-plugin` 话题 | [components/07-plugin-ecosystem.md](components/07-plugin-ecosystem.md) |
| 08 | 安全须知（SAFETY.md）与 developer preview 边界 | [components/08-safety-and-preview.md](components/08-safety-and-preview.md) |

### 翻译（translations/）

- [README.zh.md](translations/README.zh.md)：根 README 中文翻译。**校订说明**：仓库根目录已有官方 `README.zh.md`，本文以其为对照基础，按当前英文 `README.md` 逐段校订，差异点（社区入口、锚点结构等）均在文中注明。
- [architecture.zh.md](translations/architecture.zh.md)：`docs/architecture.md` 中文翻译。仓库官方中文版为 `docs/architecture.zh.md`，本文为独立学习型译本并注明与官方版的对应关系。

### 技法（根目录）

- [techniques-100.md](techniques-100.md)：《TypeScript 高级技法与重要库 100 讲》——恰好 100 条，每条结合本仓库真实代码或依赖（pnpm workspace、ESM/NodeNext、声明合并、品牌类型、标准 schema、Proxy 元编程、WebSocket/SSE、生成器 effect 等）。

## 核心代码逐行中文注释覆盖范围

学习注释以「注释只增不改」方式插入源码（`git diff` 零删除行），共 17 个文件、约 1350 行中文注释：

| 模块 | 文件 | 说明 |
|---|---|---|
| 插件内核 | `vendor/cordis/src/`（context / index / service / registry / events / reflect / fiber / utils / logger，9 文件） | Cordis 4.0.0-rc.11 内核全量逐行注释；已在 `vendor/README.md` 本地修改日志登记为 V28 |
| 作用域原语 | `packages/core/scope/src/index.ts`、`store.ts` | 每 agent 注册作用域（dsh-scope） |
| Session | `packages/core/session/src/index.ts`、`types.ts` | 事件溯源会话与事件词汇表（核心 2 文件全量） |
| Preset | `packages/preset/agent-preset-registry/src/index.ts`、`mount.ts`；`packages/preset/persona/src/index.ts` | 预设注册表、挂载与隔离审计、人设组合行 |

未覆盖说明：`packages/core/session/src/surface.ts`（表面折叠，712 行）与 `packages/core/tools`、`packages/core/agent-loop` 的实现未做逐行注释——本仓库源码总量远超 3000 行，按任务约定聚焦「插件内核 + Session + preset」；表面折叠机制在组件篇 04 中有文字讲解，agent 循环与工具管线在组件篇 06 中有文字讲解。

## 阅读建议

1. 先读 01 建立地图，再读 02/03 理解内核与「一切皆插件」。
2. 04 是数据流主线（日志 → 派生历史 → 投影 → UI）。
3. 05/06 是两条执行链路（Web 启动、回合循环）。
4. 07/08 面向想写插件或部署使用的人。
5. 配合 `docs/cordis-primer.md`（内核五思想）与 `docs/architecture.md`（回合流图）食用。
