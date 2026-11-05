# 02 · Cordis 内核原理：上下文 / 服务 / 插件生命周期

Cordis 是内嵌在 `vendor/cordis`（4.0.0-rc.11）里的插件框架，DSH 的一切都跑在它上面。官方入门是 docs/cordis-primer.md 的「Cordis 五思想」；本篇对着逐行注释过的源码讲机制。

**上下文（Context）。** `Context`（vendor/cordis/src/context.ts:69）既是类型接口也是根实现。运行时它是 `new Proxy(this, ReflectService.handler)`（context.ts 构造函数内）——普通属性读取被翻译成「服务解析」：先查 accessor/自有属性，否则沿 fiber 父链找「已提交的实现」，找不到就抛「cannot get property without inject」（reflect.ts:180 的 `handler.get`，失败路径在 reflect.ts:190-222）。三个派生方法 `extend`/`isolate`/`intercept` 都返回新子上下文、不改父级：`extend` 原型继承 + 元数据遮蔽；`isolate` 给某服务换独立作用域标签；`intercept` 给某服务的子树注入额外配置。类型层面的关键技巧是**声明合并**：`declare module './context.ts'` 让每个服务/插件把自己的属性（`ctx.sessions`、`ctx.tools`…）并进 `Context` 接口——属性名即服务名，这就是「泛型注入」的类型来源。

**服务（Service）。** `Service` 基类（service.ts:22）把「一段能力」注册为命名服务：子类 `super(ctx, name)`，构造即调用 `ctx.reflect.provide(name, this, check)`（service.ts:55 附近）——注册是 fiber effect，插件卸载自动注销并唤醒等待者。`[symbols.resolveConfig]` 沿 ctx 链合并祖先的 intercept 配置（service.ts 尾部）；`Symbol.hasInstance` 穿透代理让 `instanceof` 依旧成立。

**插件与依赖注入。** 插件 = 函数/类/`{apply}` 对象三形态（registry.ts `Plugin` 联合）；`inject` 静态字段或 `@Inject` 装饰器声明依赖（registry.ts:37）。`RegistryService.plugin()`（registry.ts:256 起）解析形态、复用 Runtime 记录、创建 Fiber；`ctx.inject(deps, cb)` 是「依赖就绪才跑回调」的语法糖。依赖表在 Fiber 构造时变成该插件 ctx 的拦截配置。

**生命周期（Fiber）。** `Fiber`（fiber.ts:224）是状态机：`PENDING`（等依赖）→ `LOADING`（跑回调）→ `ACTIVE`（已提供）→ `UNLOADING`（清理中）→ `DISPOSED`；`FAILED` 需 `update()` 恢复。状态迁移由 **epoch**（依赖实现 uid 的指纹串）驱动：依赖变化 → `_refresh()` 算新 epoch → `_setEpoch` 触发 `_reload`/`_unload`。一切注册都必须经 `ctx.effect()`（fiber.ts 的 `effect()`，约 500 行处）——effect 立即执行、收集 disposer、逆序清理、随 fiber 卸载回滚；这落实了 AGENTS.md:134 的「Registrations are effects」。卸载顺序有讲究：提供方要等所有依赖方清理完才销毁自己的服务（`_unload` 开头的 while 等待，fiber.ts 尾部）。

**事件与日志。** `EventsService`（events.ts:159）提供 emit/parallel/serial/bail/waterfall 五种派发（`@mode` 标注进事件契约）；waterfall 是洋葱模型，监听器不调 `next()` 即否决（docs/cordis-primer.md「Cordis Waterfall Semantics」）。`LoggerService`（logger.ts:231）按名字哈希着色，输出结构化 Message 给可插拔的 Exporter。

> 关键索引：vendor/cordis/src/context.ts:69、reflect.ts:180、registry.ts:256、fiber.ts:224、events.ts:159。
