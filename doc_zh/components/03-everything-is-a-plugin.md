# 03 · 「一切皆插件」设计如何落地

「Everything is a plugin」不是口号，而是三条可执行的工程规则在支撑。

**规则一：没有特权核心，只有并列挂载。** docs/architecture.md:9-11 写明：模型适配器、工具注册表、会话日志、agent 循环本身都是插件，因此每一个都能从配置里替换。「扩展 dsh」的方式不是改内核，而是「在别的插件旁边再挂一个」。技术上由 Cordis 保证：服务的读写走 Context 代理（vendor/cordis/src/reflect.ts:180），谁 provide 谁拥有，`internal/get` waterfall 还允许在解析路径上再拦截一次。

**规则二：注册即 effect（Registrations are effects）。** AGENTS.md:134 要求每笔贡献都经 `ctx.effect()`/`ctx.on()`，registry 的 `register()` 返回 disposer。于是热重载（vendor/cordis-plugin-hmr）、插件启停（packages/boot/plugin-manager）变成纯机械操作：dispose fiber，全部注册按逆序自动回滚，不需要每个插件写 cleanup。preset 体系把这条规则用到极致——`persona` 插件只是两笔 `ctx.systemPrompt.section(...)` effect（packages/preset/persona/src/index.ts:86 的 `apply`），挂进某个 agent 的隔离作用域就替换了那个人的人设，拔掉就还原。

**规则三：能力缝（capability seam）三角色。** docs/architecture.md:138 定义：一个 seam = Service Definition（声明接口）+ Service Provider（实现）+ Consumer（使用，通常是模型工具），三角色齐备才算缝。所以「把执行环境换成远程沙箱」只是换 provider：`ctx.fs`、`ctx.subprocess`、`ctx.sandbox` 的实现者一换，Bash/PTY/LSP 全部跟着走，没有 provider fork。跨插件引用也不允许直接 import——要么声明 `inject` 等服务就绪，要么走事件的扩展点；preset 隔离组内的服务必须经 `AgentPresetRegistry.serviceFor()`（packages/preset/agent-preset-registry/src/index.ts 的 `serviceFor` 方法）这类受控通道读取，泄漏到全局作用域会被挂载审计直接拒绝（mount.ts:90 `leakedServices` + mount.ts:250 `mountPreset` 的 fail-loud 检查）。

**扩展点在哪里？** docs/architecture.md:148-171 的表是权威地图：加模型 provider → 注册 `ctx.llm` 适配器；加工具 → 注册 `ctx.tools`；给单个会话换能力集 → 组一个 agent preset（服务行需要 `isolate` realm）；拦截请求/工具/回合 → `agent/*` 或 `tools/*` 事件；注入模型可见上下文 → `agent.inject()`（下一请求生效）。新行为一律挂在文档化扩展点上，「改 agent-loop 本体」必须同步更新架构图（AGENTS.md:140）。

> 关键索引：docs/architecture.md:9（Cordis 节）、:138（capability seams）、:148（扩展点表）；AGENTS.md:134、:140、:141。
