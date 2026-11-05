// 【中文逐行注释 · Cordis 内核 2/9：index.ts —— 内核公共出口（桶文件）】
// 这是 @deepseek-ai/cordis 包的公共 API 入口。DSH 各插件包在 peerDependencies
// 中声明 `@deepseek-ai/cordis`，再从这里 import { Context, Service, ... }。
// 出口顺序也大致反映了内核的分层：上下文 → 事件 → 生命周期 → 日志 → 注册表 → 服务 → 工具。
/** Core context type and root context implementation. */
// 上下文：类型接口（供声明合并）+ 根实现（Proxy 化的服务容器）。
export * from './context.ts'
/** Event bus, dispatch modes, and event augmentation types. */
// 事件总线：emit/parallel/serial/bail/waterfall 五种派发模式与 Events 事件表增强类型。
export * from './events.ts'
/** Plugin fiber lifecycle, effects, and config validation helpers. */
// 插件生命周期：Fiber 状态机、effect 收集与清理、config 校验（标准 schema）助手。
export * from './fiber.ts'
/** Logger facade, logger service, message, exporter, and formatting types. */
// 日志：Logger 门面、LoggerService、结构化 Message、Exporter 沉淀槽与格式化类型。
export * from './logger.ts'
/** Plugin registry, dependency injection, and plugin entrypoint types. */
// 插件注册表：RegistryService、Inject 依赖注入声明（含 @Inject 装饰器）与 Plugin 入口类型。
export * from './registry.ts'
/** Base service class and service lifecycle symbols. */
// 服务基类：Service 抽象类及其生命周期符号（init/check/invoke/extend 等）。
export * from './service.ts'
/** Shared internal helpers used by context, services, and plugin fibers. */
// 共享内部工具：符号表、DisposableList、原型合并、可追踪代理等，供内核各模块使用。
export * from './utils.ts'
/** Readonly references returned by volatile config schemas. */
// cosmokit 里易失（volatile）配置 schema 返回的只读引用类型，仅转发类型，不产生运行时代码。
export type { Volatile, VolatileSnapshot } from '@deepseek-ai/cosmokit'
