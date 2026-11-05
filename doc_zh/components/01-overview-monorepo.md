# 01 · 总体架构与 monorepo 布局

DeepSeek Harness（`dsh`）是一个 pnpm workspace 的 TypeScript monorepo，用「分组目录 + 品牌化包名」组织约 60 个 `@deepseek-ai/dsh-*` 包。根 `package.json` 的 `workspaces` 声明了六类成员：`vendor/*`（内嵌框架源码）、`packages/*/*`（核心包，两层目录=分组/包名）、`native/system`（Node 原生插件）、`apps/*`（可执行应用）、`website`（文档站）与 `python/sdk-runtime`（Python 运行时闭包）（package.json:5-18；pnpm-workspace.yaml:1-10）。

仓库布局的总地图在 `AGENTS.md:17-78`：`vendor/` 是内嵌的 Cordis 框架与地基库（cosmokit、schemastery），以源码复制代替 npm 依赖，从而「完全拥有框架层」（可审计、可补丁、版本钉死，见 vendor/README.md:1-7 与其清单表）；`packages/` 按职责分组——`core/` 是代理与会话 API、`llm/` 是模型供给方、`shell`/`subprocess`/`sandbox` 管执行、`session/` 是持久化家族、`boot/` 管启动与插件管理、`host/`+`client/` 是 GUI 两端、`bundle/` 是产品组合层；`apps/cli` 拥有唯一的 `dsh` bin。

两个贯穿全局的分层原则：

1. **Source 平面与 artifact 平面永不混合**（AGENTS.md:149）。静态门禁与测试通过 tsconfig `paths` 把 workspace 导入解析到 `src/`；发布包则编译到 `lib/`。这让「读源码」与「跑构建产物」两条路径互不污染。
2. **Profile → Bundle → 插件行** 的组合链（docs/architecture.md:15-29）。一个运行的 `dsh` 是一棵插件树：profile（`web`/`headless`/`sdk`/`sdk-minimal`/`acp`）按序叠加若干 bundle（如 `dsh-base` 是四类 profile 共享的第一层），bundle 只是「Cordis 配置行 + 所挂代码」的分发格式；每层都可以被下一层 patch 按 id 改写。`dsh --profile web --dump-config`（docs/architecture.md:34）能打印你机器上真实启动的整棵树——任何一行都能被你自己的 patch 替换，这是理解本仓库的最佳入口。

包之间不用直接 import 互通，而是通过 Cordis 服务名（`ctx.sessions`、`ctx.tools`、`ctx.llm`……）与类型化事件对话；服务注册表、事件表都靠声明合并扩展（见 02、03 篇）。核心包与 `ctx` 键的对应表在 docs/architecture.md:57-65。

> 关键索引：AGENTS.md:17（布局）、package.json:5（workspaces）、vendor/README.md:9（清单）、docs/architecture.md:15（profiles and bundles）。
