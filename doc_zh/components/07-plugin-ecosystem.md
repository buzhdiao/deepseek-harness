# 07 · 插件生态与 `dsh-plugin` 话题

**发布与发现。** README.md:46 是官方约定：把 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题加到你的插件仓库，就能进入社区检索。一个插件本质上就是「一个含 Cordis 插件的 npm 包」：ESM-only（AGENTS.md:133）、以 `@deepseek-ai/dsh-*` 包为 peer/dev 依赖、vendored 框架走 `workspace:~`。插件声明三种入口形态皆可（函数/类/`{apply}` 对象，vendor/cordis/src/registry.ts 的 `Plugin` 联合），`inject` 静态字段声明服务依赖，`Config` 静态字段（标准 schema）声明并校验配置。

**安装与管理。** 常驻外部插件通过 `dsh plugin` 命令装进 profile（docs/architecture.md:43）；Web 界面里对应 `packages/boot/plugin-manager`（插件启停/详情/安装规格，src/index.ts 约 1300 行）与 `packages/boot/plugin-market`（市场检索、仓库缓存、详情页）。桌面版共享同一套产品数据但保持包、激活与锁文件分离（docs/architecture.md:51）。

**配置与 patch。** 插件的配置入口是 `cordis.yml` 行：`config` 字段允许 `!!js`（注意必须是 `!!js` 而非 `!js`）表达式，且仅限 `config` 与入口 `disabled`（AGENTS.md:128）；环境差异用 overlay patch 而不是内联逻辑。配置目录由 `gen-config-catalog` 从各插件的 Config schema 生成（docs/config-catalog.md）。「不得在插件里硬编码可调参数」是硬规则——部署可变的选项必须是可从 cordis.yml 修改的 Config 字段（AGENTS.md:144）。

**HMR 与生命周期。** `base` profile 启用 config-only 的 `dsh-hmr`（vendor/cordis-plugin-hmr，本地改造见 vendor/README.md V1）；改 YAML → Loader 重解析 → fiber `update()` → 只重载受影响插件。开发者工作流：`pnpm run dev:web` 一条命令构建+启动+增量重建（README.md:57）。

**写一个插件的路径。** 官方烹饪书 docs/cookbook/extension-cookbook.md 按目标索引分步指南：加包（adding-a-package）、加工具（adding-a-tool，含「每个工具的 UI 呈现要提前设计：Host presenter 保持纯函数，Web 卡片从原始事件与持久结果元数据派生」，AGENTS.md:162）、加 LLM 适配器（adding-an-llm-adapter）、加设置卡片（adding-a-settings-card）。实验性插件放在 `packages/experimental/`，其状态独立于可选交付（AGENTS.md:80）；`appendPluginRecord` 这类实验 API 也用门禁（`verify-plugin-record-callers`）限制调用方位置。

**生态位隔离。** 外部插件能触达的面就是 03 篇的扩展点表——框架刻意不提供「改内核」的后门：应用启动必须走 `dsh` profile，进程 confines 走 `ctx.sandbox`，凭据走 `ctx.credentials`（AGENTS.md:128 禁止提交凭据）。

> 关键索引：README.md:46；AGENTS.md:128、:133、:144；docs/cookbook/extension-cookbook.md；packages/boot/plugin-manager/src/index.ts；packages/bundle/base/cordis.patch.yml。
