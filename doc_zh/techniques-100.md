# TypeScript 高级技法与重要库 100 讲

> 本文恰含 **100 条**，每条都锚定本仓库（deepseek-harness v0.2.2-rc.1）真实代码或 `package.json` 依赖，不写空泛理论。行号为当前工作区状态。索引：A. Monorepo 与包管理（1-10）｜B. 模块系统与构建（11-20）｜C. 类型级编程（21-35）｜D. 运行时符号与元编程（36-45）｜E. 生命周期与资源管理（46-55）｜F. 异步与并发（56-65）｜G. 不可变与校验边界（66-73）｜H. 事件系统与插件协议（74-80）｜I. Web/RPC/流（81-88）｜J. 门禁与生态库（89-100）。

## A. Monorepo 与包管理（pnpm workspace）

**1. 多 glob workspace 声明。** 根 `package.json` 用六条 glob 组合成员：`vendor/*`、`packages/*/*`（分组/包名两层目录）、`native/system` 及其子包、`apps/*`、`website`、`python/sdk-runtime`。两层目录让「分组」成为文件系统事实而不是元数据（package.json:5-18）。

**2. `workspace:*` 与 `workspace:~` 的语义分工。** DSH 包之间用 `workspace:*`（精确锁版本），vendored/原生包用 `workspace:~`（同 minor 内允许补丁更新）——发布序列规则写在 AGENTS.md:132。

**3. pnpm `overrides` 重定向到 vendor。** `'@deepseek-ai/cosmokit': 'link:vendor/cosmokit'` 强制全仓统一使用内嵌副本，防止 npm 上的同名包混入（pnpm-workspace.yaml「overrides」段）。

**4. `peerDependencyRules.allowedVersions`。** 允许 `typescript: '>=5 <7'` 这类宽 peer 范围，不触发 pnpm 告警（pnpm-workspace.yaml）。

**5. strictDepBuilds 拒绝安装脚本。** pnpm 10+ 默认拦截带 install/build 脚本的依赖；仓库在 workspace 文件里显式白名单（esbuild、lefthook），其余一律拒绝——供应链审计点（pnpm-workspace.yaml 尾注）。

**6. 引擎钉死 Node 24.9+。** `"engines": { "node": ">=24.9.0" }` 与 `packageManager: pnpm@11.28.5`——Monorepo 用引擎字段而非文档约定来保证 `node:` 前缀、ESM 特性可用（package.json:7-9）。

**7. 私有根 + 发布元数据下沉。** 根包 `private: true`，可发布的叶子包各自带 `publishConfig.access: 'public'` 与 `repository.directory`（packages/bundle/base/package.json）。

**8. 脚本即 TypeScript。** 全部仓库脚本用 `tsx scripts/*.ts` 编写而不是 shell/bash——构建门禁 `scripts/run-gates.ts` 是一个分派器，每个门禁独立可测（package.json scripts 段）。

**9. 双面 tsconfig。** `tsconfig.base.json`（共享）、`tsconfig.host.json`（Node 侧）、`tsconfig.client.json`（浏览器侧）+ solution-style 根：Host/Client 双编译面通过「leaf 配置 + solution-only 根」隔离（AGENTS.md:150）。

**10. `paths` 指向 src 的静态平面。** 静态门禁与测试通过 tsconfig `paths` 把 `@deepseek-ai/dsh-*` 解析到 `src/`，构建产物走 `lib/`——源平面与工件平面永不混合（AGENTS.md:149；tsconfig.base.json）。

## B. 模块系统与构建（ESM / NodeNext / tsdown）

**11. 全仓 ESM。** 每个 package `"type": "module"`；dsh CLI 源码启动走 `node --import tsx/esm`，要求可达模块全部 ESM（AGENTS.md:133）。

**12. `.ts` 后缀导入。** 内部相对导入写 `./fiber.ts`：TypeScript 发射 JS 时改写为 `.js`，声明文件保留显式 `.ts` 说明符，实现 NodeNext 安全（vendor/README.md V4）。

**13. `import type` 与内联 `type` 修饰符。** 类型依赖一律显式，保证 ESM 输出不残留被擦除的接口 import（vendor/README.md V4；如 vendor/cordis/src/fiber.ts 的 `import type { Plugin }`）。

**14. exports 条件映射。** 包导出表 `"." : { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }` 把类型入口与运行时入口分离，还导出 `./cordis.patch.yml` 与 `./src/*`（packages/bundle/base/package.json exports 段）。

**15. tsdown 双格式。** schemastery / logger-console 用仓库级 tsdown 配置产出双 ESM+CJS 入口，其余包纯 ESM——按需给「浏览器+Node 双消费」的包做双面（vendor/README.md V5）。

**16. `--config-loader native`。** 根构建调用 tsdown 时用原生配置加载器执行 TS 配置文件（package.json build:bench 等脚本）。

**17. tsc 项目引用。** `tsc -b tsconfig.client.json` 增量构建引用图；`build:lib:host` 先跑 `compile-referenced-projects.ts` 再 `tsc -p tsconfig.host.json`（package.json scripts）。

**18. tsx 作为脚本运行时。** `tsx` 兼做「脚本解释器」与「ESM loader hook」，省去单独的 ts-node 配置（package.json：`"dsh": "node --import tsx/esm apps/cli/src/bin.ts"`）。

**19. 顶层 await 禁令。** `verify-no-top-level-await` 门禁禁止源码顶层 await——配置子进程要在纯 Node 下跑 `lib/`（package.json scripts；AGENTS.md:133）。

**20. 单文件可执行。** `@yao-pkg/pkg` 把运行时闭包打成单 exe；`python/sdk-runtime` 的 manifest 包恰好描述 exe 内闭包与 Python 分发面（package.json devDeps；pnpm-workspace.yaml 尾注）。

## C. 类型级编程

**21. 声明合并做服务类型。** `declare module './context.ts' { interface Context { sessions: SessionStore } }`——服务键进入 Context 类型全靠接口合并，这是「泛型注入」的类型基础（packages/core/session/src/index.ts:38-42；vendor/cordis/src/reflect.ts:7-71）。

**22. 品牌类型（Branded types）。** `type SessionId = Branded<'SessionId'>`：跨边界的 id 一律品牌化，禁止裸 string（packages/core/session/src/types.ts:21；AGENTS.md:146）。

**23. 校验式品牌铸造。** `SessionSeq(value)` 在铸造点校验非负安全整数并显式拒绝 `-0`——把运行时校验收窄到一个函数（types.ts:40-45）。

**24. 幻影类型参数。** `Service<out T = never>` 的 `declare [symbols.config]: T` 让 T 只存在于类型层（无运行时字段），供 `InjectKey` 推导（vendor/cordis/src/service.ts:27-31）。

**25. 映射类型 + as 子句过滤键。** `InjectKey` 用 `{ [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any }` 筛出「带拦截配置类型」的服务名（vendor/cordis/src/registry.ts:22-24）。

**26. 条件类型 + infer 提取插件配置。** `GetPluginConfig<P>` 先匹配 `Plugin.Transform<infer S, any>` 再回落参数表第一项；`Spread<T>` 生成 `[config?: T]` 变长元组让可选配置免传（registry.ts:148-162）。

**27. 变长元组做条件参数。** `append<T, ...>(type, data, ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : [])`——表面元数据只在消息型事件上出现，编译器强制（packages/core/session/src/index.ts:962-966）。

**28. `NoInfer` 防推断泄漏。** `data: NoInfer<PluginRecordMap[K]>` 阻止 TS 从第二个参数反推 K，保证键与载荷一致（session/src/index.ts:495-499）。

**29. 模板字面量类型。** ``type PluginRecordType = `plugin:${string}` `` 用类型系统表达事件命名文法，配合正则做运行时同构校验（types.ts:532；index.ts 的 PLUGIN_RECORD_TYPE）。

**30. merge-extensible map 类型。** `SessionEventMap`、`TurnEndReasonMap`、`Events` 都是可以被插件合并扩展的接口表；closed union 才用 `assertNever` 守卫（AGENTS.md:135-136；types.ts:206-238）。

**31. 判别联合 + 无断言收窄。** `SessionEvent` 是对 `type` 的正规映射联合：`switch (event.type)` 自动收窄 `event.data`，全仓禁止 `as unknown`（AGENTS.md:148；types.ts:624-624 区段）。

**32. const enum 做零成本状态机。** `export const enum FiberState` / `LoggerLevel`——内联枚举避免运行时对象（vendor/cordis/src/fiber.ts:147-154、logger.ts:22-27）。

**33. 唯一符号静态字段。** `static readonly init: unique symbol = symbols.init` 把全局符号「别名化」为类成员，调用点获得精确类型（service.ts:13-25）。

**34. `declare` 字段与确定性初始化。** `public name!: string`、`declare [symbols.config]: T`、`ctx!: Context`——用 `declare`/`!` 表达「由构造逻辑赋值」而不生成多余初始化代码（service.ts:30；logger.ts:197）。

**35. 私有类字段 `#`。** `#appendRecord` 用真私有方法（非 TS private），从静态块经模块级桥调用，杜绝外部访问（session/src/index.ts:839-841、896 区段）。

## D. 运行时符号与元编程

**36. `Symbol.for` 全局符号注册表。** symbols 表全部 `Symbol.for('cordis.*')`——多份 cordis 副本跨 realm 互操作（vendor/cordis/src/utils.ts:50-74）。

**37. `Symbol.hasInstance` 自定义。** Service 的静态 `[Symbol.hasInstance]` 沿（可能被代理的）构造链匹配，让 `instanceof` 在包装后仍成立（service.ts:104-114）。

**38. `Symbol.toPrimitive` 标记技巧。** `Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')` 让判定函数自身也能被当符号识别（context.ts 静态块）。

**39. Proxy 静态 handler 共享。** `ReflectService.handler` 是一个静态 ProxyHandler，所有 Context 代理共享同一组 get/set/has trap（vendor/cordis/src/reflect.ts:143-219）。

**40. get trap 实现服务解析。** 「属性读取 → 沿 fiber 父链找实现 → `internal/get` waterfall → 报错增强」全部在 get trap 内完成；set trap 走 `internal/set`（reflect.ts:144-210）。

**41. 可追踪代理（traceable proxy）。** `createTraceable` 给带 Tracker 的服务对象套代理：`ctx.foo.bar()` 调用时 def site（定义点）管服务解析、use site（使用点）管拦截/隔离/effect（vendor/cordis/src/utils.ts:170-225）。

**42. 影子上下文（shadow context）。** `createShadow`/`withProp` 在 receiver 上叠加只读属性视图，把 def site 藏进 `symbols.shadow`——「同一函数两种语义」的实现载体（utils.ts:150-165）。

**43. 可调用服务对象。** `createCallable` 造一个函数，原型链合并「服务原型 + Function.prototype」，调用经 `symbols.invoke` 分发——`ctx.logger('name')` 由此可行（utils.ts:233-240；logger.ts:208）。

**44. 原型链拼接。** `joinPrototype(proto1, proto2)` 递归合并两条链并保留 proto1 描述符——多重身份对象的最小实现（utils.ts:93-100）。

**45. Node inspect 自定义。** `[Symbol.for('nodejs.util.inspect.custom')]()` 让 Context/Fiber 在控制台只打印名字而不是无限展开（context.ts；utils.ts:37-39）。

## E. 生命周期与资源管理

**46. Effect 模式（注册即可逆）。** 一切注册返回 disposer 并被 fiber 收集：`ctx.effect(execute, label)` 支持「函数 / Promise / 同步迭代器 / 异步迭代器」四种产物形态（vendor/cordis/src/fiber.ts 的 `effect()` 与 `_execute()`）。

**47. 生成器 effect 的回滚语义。** `ctx.effect(function* () { yield disposerA; announce(); })`——生成器体抛错时已 yield 的 disposer 被自动逆序回滚（fiber.ts `_execute` 的 iterator 分支；session/src/index.ts:1345-1350 的 create）。

**48. 异步迭代器 + epoch 取消。** 异步 effect 每轮检查 `runner.epoch`，代次变化即停止继续收集——用 epoch 替代 AbortSignal 的轻量取消（fiber.ts `_execute` asyncIterator 分支）。

**49. disposer 惯性（inertia）与 join。** `effectInertia: WeakMap<Disposable, () => Promise>` 让「结构所有者」能加入别人已开始的清理，同时保持公开 disposer 单次语义（fiber.ts:112-117 上游注释）。

**50. 卸载顺序契约。** 提供方等待全部依赖方卸载完才销毁服务（`_unload` 开头 `while (provisions.some(impl => impl.dependents.size)) await`）——清理拓扑与依赖拓扑同向（fiber.ts `_unload`）。

**51. 引用计数代（generation）。** preset 挂载的 Generation 用 `users` 计数 + `retired` 标记：新代就位、旧代等最后一人离开才 `scope.dispose()`（packages/preset/agent-preset-registry/src/index.ts:33-40、314-330）。

**52. WeakMap 存生命周期边带。** `attachments: WeakMap<Session, SessionEntry | null>` 用「键存在值 null」表达「已交商店未进入」，对象被 GC 即自动清理（session/src/index.ts:433）。

**53. `Symbol.asyncDispose` 租约。** `acquireScope()` 返回带 `[Symbol.asyncDispose]` 的对象，调用方可用 `await using` 自动归还引用计数（agent-preset-registry/src/index.ts:389-398）。

**54. Promise 惯性等待收敛。** `quiesceFiber` 用 `while (fiber.inertia !== undefined) await fiber.inertia` 等到所有迁移静止——比「猜一个超时」诚实（packages/core/scope/src/index.ts:115-118）。

**55. 状态机驱动的重载/卸载。** epoch 指纹串（修订号 + 各依赖实现 uid）决定 LOADING/UNLOADING 迁移；FAILED 只能经 `update()` 恢复（fiber.ts `_refresh`/`_setEpoch`）。

## F. 异步与并发

**56. 五种事件派发模式。** emit（同步广播）/ parallel（并发等全部）/ serial（串行可中止）/ bail（同步可中止）/ waterfall（洋葱）——派发模式是事件公共契约的一部分，用 `@mode` 标注（vendor/cordis/src/events.ts:31；docs/cordis-primer.md 派发表）。

**57. `Promise.allSettled` + AggregateError。** parallel 收集全部结果后聚合抛错：既不吞错也不让单个监听器打断同伴（events.ts 的 `parallel`）。

**58. 监听器快照先行。** `collectSessionCallbacks` 在入日志前解析监听器数组、回调在入日志后执行——快照与执行分离防重入（session/src/index.ts:396-414）。

**59. 逐观察者错误隔离。** `invokeContainedSessionObservers` 对每个回调 try/catch + `void Promise.resolve(returned).catch(log)`——同步抛错与异步 reject 都只记日志（session/src/index.ts:401-418）。

**60. Promise 链做 per-agent 串行队列。** `switches.get(id) ?? Promise.resolve()` 先链前次再排队本次，`guard = turn.catch(() => undefined)` 保证失败不阻塞后续（agent-preset-registry/src/index.ts:453-470 的 select）。

**61. 「无人消费的 rejection」显式吞掉。** `task.catch(() => {})` 模式：错误已由 fiber 记录，丢弃返回值的调用方不应制造 unhandled rejection（fiber.ts `update()` 尾部）。

**62. `-0` 与安全整数防御。** 所有偏移/序号铸造点用 `Number.isSafeInteger(v) && !Object.is(v, -0)`——`-0` 在 JSON 往返后会变 `0`，提前拒绝避免索引歧义（types.ts:41-44）。

**63. 弱引用防泄漏。** Logger 元数据带 `fiber: new WeakRef(fiber)`，诊断工具可反查来源插件而不阻止 GC（vendor/cordis/src/logger.ts:262-266）。

**64. 长栈拼接。** `composeError`/`buildOuterStack` 把外部调用点栈帧拼进异步抛出的错误栈——插件启动错误能「看到」装载者（vendor/cordis/src/utils.ts:247-294）。

**65. while-await 收敛循环。** fiber dispose 与 scope dispose 都用 `while (inertia) await inertia` 而非单次 await——迁移可能在等待期间再入队（fiber.ts dispose 清理路径）。

## G. 不可变与校验边界

**66. 深冻结 + 快照读。** `deepFreeze`（cosmokit）冻结事件载荷与派生 Message；`snapshotEvents` 返回冻结数组且历史快照永不改变（session/src/index.ts:666、728-737）。

**67. 一次遍历快照防 TOCTOU。** `snapshotJsonValue` 用迭代式「读-校验-拷贝」一遍完成，有状态 getter 无法给校验和存储提供不同值（session/src/index.ts append 的上游注释）。

**68. 无损 JSON 作为数据边界。** 事件载荷必须能无损 JSON 序列化（BigInt/函数/循环/稀疏数组一律拒绝）；`JsonValue` 类型 + `isJsonValue` 运行时校验双保险（types.ts:379-393 的 meta 注释）。

**69. 恢复边界的原型检查。** `validateRestoredSessionHeader` 额外要求 `Object.getPrototypeOf(input)` 是 `Object.prototype` 或 null——防反序列化夹带原型（session/src/index.ts:140-148）。

**70. 标准 Schema（~standard）。** 依赖 `@standard-schema/spec`：`runtime.Config['~standard'].validate(config)` 统一 zod/schemastery 的校验入口，异步校验显式不支持（vendor/cordis/src/fiber.ts:50-62）。

**71. Schemastery 的 volatile 配置。** `z.string().volatile()` 声明「可变引用」字段：更新它不重载插件，只提交引用并派发 `loader/volatile-update`（agent-preset-registry 的 selectedDefault；vendor/README.md V22）。

**72. 幂等 undo。** `NamedEntries.insert` 返回的 undo 带 `active` 标志：重复调用无害、只删本条，且清空时换代（新 Map）让旧迭代器脱钩（packages/core/scope/src/store.ts:43-54）。

**73. 环检查的父链写入口。** `linkScopeParent` 沿父链游走检测环后才写入——所有谱系修改都收口到一个函数（packages/core/scope/src/index.ts:54-59）。

## H. 事件系统与插件协议

**74. 事件即扩展点。** 三域事件（会话持久 / `agent/*` 活体 / 能力 `fs/*`、`tools/*`）覆盖「改持久事实、观察在途工作、接策略到缝」三类需求（docs/architecture.md:68-74）。

**75. waterfall 必须委托。** 监听器不调 `next()` 即否决整条链（含内建行为）；重复调用 `next()` 抛错——洋葱模型的硬约定（vendor/cordis/src/events.ts:246-261；AGENTS.md:137）。

**76. 内建事件的拦截面。** `internal/get|set|listener|update|config|dispatch` 让内核服务也能被插件改写：例如 `internal/config` 在最外层叠加 schema 校验（events.ts:130-160、334-371）。

**77. `@Inject` 标准装饰器。** 类装饰器并入静态 inject 映射（原型链逐层合并 + checkProto 标记）；方法装饰器经 `addInitializer` 注册 initHook，等依赖就绪再调方法（vendor/cordis/src/registry.ts:37-60）。

**78. 能力缝三角色。** Service Definition / Provider / Consumer 齐备才算缝——`persona` 行演示了最小 Provider：两笔 `ctx.systemPrompt.section` effect（docs/architecture.md:138；packages/preset/persona/src/index.ts:86-99）。

**79. 隔离作用域 + 受控跨引用。** preset 服务必须住 isolate realm；`serviceForMount` 是唯一合法读取通道，泄漏审计 fail loud（packages/preset/agent-preset-registry/src/mount.ts:90-113、250-263）。

**80. 作用域事件向上流。** `scopeTarget` 载体让祖先作用域的监听器收到后代作用域的事件、反之不行——「一份常驻组合观察其下所有 agent」（packages/core/scope/src/index.ts:218-233）。

## I. Web / RPC / 流

**81. 三形态 Web 路由。** handler 型（可持有响应做 SSE）、resource 型（Fetch `Request`→`Response`，兼进程内读）、upgrade 型（WS 升级后路由自持协议）（packages/host/webserver/src/index.ts:57-90）。

**82. Fetch 抽象复用。** `WebResource = (request: Request, peer?) => Promise<Response>`：HTTP 请求与进程内读取走同一实现，Peer 作用域可选（webserver/src/index.ts:57-63）。

**83. index 注入事件。** `webserver/index-inject` 每次渲染 index / 每次 worker boot-payload 请求时触发，插件现场推行——注入数据永不陈旧（webserver/src/index.ts Events 声明）。

**84. Typert 类型化远程服务。** `@Remote('list')` 导出 RPC 方法，`RemoteError` 带结构化 details；服务 id 解析（session lookup）由 `TypertLookupMap` 声明合并注册（agent-preset-registry/src/index.ts:210、:233；session/src/index.ts:88-92）。

**85. 派生流 vs 持久落定分离。** 活 UI 增量来自 `agent/assistant-stream`（进程内瞬态帧），持久化只存提交的 `assistant/message`/`attempt`——崩溃前的流不留持久痕（docs/architecture.md:126）。

**86. IPC 边界明确。** 桌面 Host 与页面之间：Node IPC 只传引导注入、就绪、致命错误、关停；RPC 与流归 Web 通道（docs/architecture.md:53）。

**87. IP 允许表与内容协商。** webserver 用 `ipaddr.js` 做地址判定、`negotiator` 做 Accept 头协商、`compression` 做可选 gzip——经典 Node 服务端三件套各司其职（webserver/src/index.ts imports）。

**88. 只路由不服务文件。** WebServer 明确「serves no files」：dist 归组合应用所有，避免框架层吞掉静态资源所有权（webserver/src/index.ts 模块头）。

## J. 工程化门禁与生态库

**89. 门禁即脚本目录。** `scripts/verify-*.ts` 七十余个：导出 JSDoc、翻译配对、持久化目录、配置目录、模块图……每个门禁都可单独执行并被 `run-gates.ts` 聚合（package.json scripts 段）。

**90. 覆盖率 100% 门禁。** `test:coverage` 要求 `packages/*/*/src` 每文件 100%；确实不可达的分支用 `/* v8 ignore next -- 原因 */` 显式豁免并写明理由（AGENTS.md:88；session/src/index.ts:1271）。

**91. 快照重放测试。** 无 key 的录制会话经完整 profile 重放（`test:snapshot`，`DSH_SNAPSHOT=refresh` 刷新）——「每个非平凡模型可见变更都要更新快照」（AGENTS.md:161）。

**92. oxlint + tsgolint。** Rust 实现的 oxlint（1.81）配 `oxlint-tsgolint` 做类型感知规则，替代 ESLint 主链；`@stylistic/eslint-plugin` 仅留特定用途（package.json devDeps；scripts/run-oxlint.ts）。

**93. lefthook 钩子。** pre-commit 跑 `git diff --cached --check`（尾换行门禁）等轻检查；重活留给 CI（lefthook.yml；AGENTS.md:169）。

**94. jscpd 克隆检测。** `pnpm run duplication` 跨文件检测 TypeScript 重复块——大仓防腐化的机械门（package.json）。

**95. publint + NodeNext 消费检查。** `publint-all` 与 `verify-node-next-types` 校验发布包的 exports/类型可被真实 NodeNext 消费者解析（package.json scripts）。

**96. 双语门禁。** 每份英文文档带 `.i18n.yaml` 侧车；`verify-translation-pairing`、`verify-md-wrap`（每段一行）等保证中英同步（docs/*.i18n.yaml；package.json）。

**97. Mermaid 图门禁。** `verify-mermaid` 解析文档内 mermaid 块防语法漂移；`gen-doc-graphs` 从代码生成依赖图（package.json scripts）。

**98. fast-check 属性测试。** devDeps 里的 fast-check 用于不变量性质测试（如序号连续性、快照稳定性）——与逐例单测互补（package.json devDeps）。

**99. Vitest 多配置矩阵。** vitest.{web,e2e,snapshot,bench,web-stress,web-perf,expected}.config.ts 一仓七面，共享 `vitest.shared.ts`；`test:coverage:partitioned` 分片跑覆盖率（仓库根）。

**100. Electron + 原生插件边界。** 桌面版以签名资源携带 dsh 运行时，`native/system` 的 `@deepseek-ai/node-addon-system` 提供 Landlock 启动器等原生能力，Node 原生 addon 用 `node-addon-require-builtin` 在打包环境解析内建模块（package.json devDeps；vendor/README.md V2；docs/architecture.md:51-53）。
