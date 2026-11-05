# 05 · Web UI 与 server 架构（`npx @deepseek-ai/dsh web` 启动链路）

从 `npx @deepseek-ai/dsh web` 到浏览器出现对话界面，链路有六步。

1. **CLI 分发。** `runCli()`（apps/cli/src/bin.ts:26）解析参数，`web` 命中 `case 'profile'`（bin.ts:32）：加载分层 `.env`（`loadLayeredEnv`），动态 import `profile-boot.ts`，交给 profile 运行器；`StartupError` 走专门的启动诊断报告。`web`/`headless`/`sdk`/`acp` 都是 profile 名——AGENTS.md:13 规定只有 `dsh` profile 能启动受支持的 Node 应用，绕过 `dsh` 的启动路径会被 `verify-application-entrypoints` 门禁拒绝（docs/architecture.md:43-45）。
2. **Boot 装配。** `@deepseek-ai/dsh-app-boot`（packages/boot/app-boot/src/index.ts:1-6 模块头）是共享启动胶水：安装 fail-loud 的 Loader 守卫、解析配置路径、按层读取 Harness home（`~/.dsh`）的补丁、驱动 Cordis Loader 直到插件树稳定。组合顺序是「profile 的有序 bundle → profile 自身 cordis.patch.yml → home 补丁 → `--patch` 覆盖层」，每层按行 id 替换或插入（docs/architecture.md:25）。
3. **Bundle 叠层。** `dsh-base`（packages/bundle/base，包描述见其 package.json）插入第一层：模型适配、工具、持久化、沙箱与审批策略、设置、凭据、遥测；`dsh-web-app` 再叠加浏览器应用。`base` 启用 config-only 的 `dsh-hmr`，让改 YAML 即热生效。
4. **HTTP 服务。** `WebServer`（packages/host/webserver/src/index.ts:357）是一个 Cordis Service：注册 `node:http`（或带 TLS 的 https）路由，可选 gzip 与 index 注入；它刻意「不服务任何文件」——dist 归组合它的应用所有。三种路由形态并存：handler 型（可持有响应，如 SSE）、resource 型（Fetch `Request`→`Response`，同时供进程内读取）、upgrade 型（WebSocket 升级后由路由自持协议协商）。`webserver/index-inject` 事件（同文件 Events 声明）让各插件在每次渲染 index 时推入自己的注入行。
5. **RPC 与流。** 浏览器客户端与宿主之间的会话面基于 Typert 协议（类型化远程服务，如 `AgentPresetRegistry` 的 `@Remote('list')`/`@Remote('select')` 导出）+ SSE/WS 流；`web/session-follow` 之类的适配器把 `agent/assistant-stream` 的活事件喂给远端（docs/architecture.md:108）。桌面版（Electron）复用同一套 Web 资产：Host 进程跑同一个 profile runner，页面与宿主用 Node IPC 传引导注入与就绪信号（docs/architecture.md:51-53）。
6. **打开页面。** 默认 `http://127.0.0.1:3080`，本机启动自动开浏览器；SSH 启动只打印宿主 URL（本地转发地址归 SSH 客户端/编辑器所有），`--no-open` 只起服务（README.md:27）。

调试利器：`dsh --profile web --dump-config` 打印最终插件树；`packages/boot/plugin-manager`、`plugin-market` 提供 Web 界面上的插件启停与安装（见 07 篇）。

> 关键索引：apps/cli/src/bin.ts:26；packages/boot/app-boot/src/index.ts:1；packages/host/webserver/src/index.ts:357；docs/architecture.md:25、:43。
