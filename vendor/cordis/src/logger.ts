// 【中文逐行注释 · Cordis 内核 9/9：logger.ts —— 日志服务】
// LoggerService 是 ctx.logger：既是可调用服务（ctx.logger('name') 创建命名门面），
// 也直接暴露 error/info/warn/debug 四个快捷方法。日志先格式化成结构化 Message，
// 再交给注册的 Exporter（沉淀槽）输出；DSH 的 telemetry/otel 日志导出基于此。
import { defineProperty, hyphenate } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { Fiber } from './fiber.ts'
import { createCallable, joinPrototype, symbols, type Tracker } from './utils.ts'

// 声明合并：为 logger 服务声明拦截配置类型（ctx.intercept('logger', {...}) 可用）。
declare module './context.ts' {
  interface Intercept {
    logger: LoggerService.Intercept
  }
}

/** Logger method name and severity category. */
// 日志方法名兼严重性类别。
export type LoggerType = 'error' | 'info' | 'warn' | 'debug'

/** Callable shape for one logger severity method. */
// 单个严重性方法的可调用形态（printf 风格参数）。
export type LoggerMethod = (format: any, ...param: any[]) => void

/** Formatter used to resolve a printf-style placeholder. */
// 占位符格式化器。
export type Formatter = (value: any, exporter: Exporter, message: Message) => any

/** Numeric severity used when exporters decide whether to emit a message. */
// 数值化严重级别（exporter 决定是否输出时比较）。
export const enum LoggerLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

/** Structured log record delivered to exporters. */
// 结构化日志记录：序号、时间戳、来源名、级别、参数、可选的 fiber 弱引用。
export interface Message {
  sn: number
  ts: number
  name: string
  type: LoggerType
  level: number
  args: any[]
  fiber?: WeakRef<Fiber>
}

/** Sink that receives structured log messages. */
// Exporter：日志沉淀槽——接收结构化消息并自行输出（控制台/文件/OTel 等）。
export interface Exporter {
  colors?: number | false
  maxLength?: number
  levels?: Record<string, number>
  formatters?: Record<string, Formatter>
  export(message: Message): void
}

/** Built-in placeholder formatters used by `Logger.format()`. */
// 内建占位符格式化器：%s 字符串、%d/%i 整数、%f 浮点、%o/%O JSON、%c 空实现、
// %C 按日志名着色输出。
export const defaultFormatters: Record<string, Formatter> = {
  s: (value) => String(value),
  d: (value) => Math.trunc(Number(value)),
  i: (value) => Math.trunc(Number(value)),
  f: (value) => Number(value),
  o: (value) => JSON.stringify(value),
  O: (value) => JSON.stringify(value),
  c: () => '',
  C: (value, exporter, message) => {
    return Logger.color(exporter, Logger.code(message.name, exporter.colors), value)
  },
}

/** Options used when creating a named logger facade. */
// 创建命名日志门面的选项。
export interface LoggerOptions {
  /** The logger name shown with each message. */
  // 日志名（每条消息都带，如插件名）。
  name: string
  /** Message fields merged into every record from this logger. */
  // 合并进每条记录的额外字段。
  meta?: Partial<Message>
  /** Default maximum level exported when an exporter has no own threshold. */
  // exporter 未配置阈值时的默认最高级别。
  level?: number
}

/** Logger facade identity, inherited message metadata, and optional minimum level. */
// Logger 门面：身份 + 元数据 + 可选级别。
export interface Logger extends LoggerOptions {}
/** Logger facade severity methods. */
// 门面的四个严重性方法。
export interface Logger extends Record<LoggerType, LoggerMethod> {}

// 聚合错误判定（AggregateError 形状）。
function isAggregateError(error: any): error is Error & { errors: Error[] } {
  return error instanceof Error && Array.isArray(error['errors'])
}

/** Logger facade for one named subsystem. */
// Logger：单个命名子系统的日志门面。
export class Logger {
  // color：ANSI 着色；colors 关闭时原样返回；3+ 级支持 256 色 + 装饰。
  static color(exporter: Exporter, code: number, value: any, decoration = '') {
    if (!exporter.colors) return '' + value
    return `\u001b[3${code < 8 ? code : '8;5;' + code}${exporter.colors >= 2 ? decoration : ''}m${value}\u001b[0m`
  }

  // code：把日志名哈希到调色板索引——同一名字恒定同色（终端里一眼识别来源）。
  static code(name: string, level?: false | number) {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 3) - hash) + name.charCodeAt(i) + 13
      hash |= 0
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16
    return colors[Math.abs(hash) % colors.length]
  }

  // format：printf 风格格式化。首参是 Error 时替换为其 stack；首参非字符串时
  // 视为 %o；替换占位符后把剩余参数以空格拼接；超长行截断到 maxLength。
  static format(exporter: Exporter, message: Message): string {
    const args = message.args.slice()
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message
      args.unshift('%s')
    } else if (typeof args[0] !== 'string') {
      args.unshift('%o')
    }

    let format: string = args.shift()
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === '%%') return '%'
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char]
      if (typeof formatter === 'function') {
        const value = args.shift()
        return formatter(value, exporter, message)
      }
      return match
    })

    // 剩余的对象参数用 %o 格式化后拼接。
    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o
    for (let arg of args) {
      if (typeof arg === 'object' && arg) {
        arg = oFormatter(arg, exporter, message)
      }
      format += ' ' + arg
    }

    // 按行截断（默认 10240 字符），防止超长日志刷屏。
    const { maxLength = 10240 } = exporter
    return format.split(/\r?\n/g).map(line => {
      return line.slice(0, maxLength) + (line.length > maxLength ? '...' : '')
    }).join('\n')
  }

  constructor(options: LoggerOptions, private service: LoggerService) {
    // 门面构造：赋身份，并把四个方法绑定到对应级别。
    Object.assign(this, options)
    this.error = this._method('error', LoggerLevel.ERROR)
    this.info = this._method('info', LoggerLevel.INFO)
    this.warn = this._method('warn', LoggerLevel.WARN)
    this.debug = this._method('debug', LoggerLevel.DEBUG)
  }

  // _method：生成某级别的日志方法——Error 拆分（cause 递归、聚合错误逐个记录），
  // 然后按 exporter 的级别阈值过滤并构造结构化消息投递。
  private _method(type: LoggerType, level: number): LoggerMethod {
    return (...args: any[]) => {
      if (args.length === 1 && args[0] instanceof Error) {
        if (args[0].cause) {
          this[type](args[0].cause)
        } else if (isAggregateError(args[0])) {
          args[0].errors.forEach(error => this[type](error))
          return
        }
      }

      const sn = ++this.service._snMessage
      const ts = Date.now()
      for (const exporter of this.service.exporters.values()) {
        // 级别判定：exporter 针对本日志名的阈值 > 默认阈值 > 门面 level > INFO。
        const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? LoggerLevel.INFO
        if (targetLevel < level) continue
        const message: Message = { sn, ts, type, level, name: this.name, ...this.meta, args }
        exporter.export(message)
      }
    }
  }
}

/** ANSI 16-color palette indexes used for logger name coloring. */
// 16 色调色板索引。
export const c16 = [6, 2, 3, 4, 5, 1]
/** ANSI 256-color palette indexes used for logger name coloring. */
// 256 色调色板索引。
export const c256 = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62,
  63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113,
  129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168,
  169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
]

/** Logger service configuration merged from context intercepts. */
// logger 服务的拦截配置形状（名字/级别）。
export namespace LoggerService {
  export interface Intercept {
    name?: string
    level?: number
  }
}

/** Callable `ctx.logger` service shape. */
// ctx.logger 服务类型：可调用（创建命名门面）+ 四个快捷方法。
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
}

/**
 * Built-in logging service.
 *
 * Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
 * directly to log with the current fiber-derived name.
 */
// LoggerService：可调用服务——构造时把自己替换为函数对象（createCallable），
// 调用走 [symbols.invoke]。构造期间注册一个默认 exporter（内存环形缓冲）。
export class LoggerService {
  // 内存缓冲容量与当前缓冲。
  bufferSize = 1000
  buffer: Message[] = []
  ctx!: Context

  _snMessage = 0
  _snExporter = 0
  exporters = new Map<number, Exporter>()

  constructor(ctx: Context) {
    const tracker: Tracker = {
      property: 'ctx',
      noShadow: true,
    }
    // 替换为可调用对象：原型链合并 LoggerService 原型与 Function.prototype。
    const self = createCallable('logger', joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker) as unknown as LoggerService
    Object.assign(self, this)
    self.ctx = ctx
    defineProperty(self, symbols.tracker, tracker)

    // 默认 exporter：消息进内存环形缓冲（供诊断工具回放最近日志）。
    self.exporter({
      colors: 3,
      export: (message) => {
        self.buffer.push(message)
        // for better performance
        // 上游注释：性能优化——溢出量为 1 时 shift 一次即可，否则批量裁剪。
        const overflow = self.buffer.length - self.bufferSize
        if (overflow === 1) {
          self.buffer.shift()
        } else if (overflow > 1) {
          self.buffer.splice(0, overflow)
        }
      },
    })

    return self
  }

  /**
   * Register an exporter and dispose it with the current fiber.
   *
   * @param exporter — the sink that receives structured log messages.
   * @returns a disposer that removes the exporter.
   */
  // exporter：注册沉淀槽（fiber effect——插件卸载自动移除）。
  exporter(exporter: Exporter) {
    return this.ctx.effect(() => {
      const id = ++this._snExporter
      this.exporters.set(id, exporter)
      return () => this.exporters.delete(id)
    }, 'ctx.logger.exporter()')
  }

  // _resolveConfig：沿 ctx 链收集 logger 的拦截配置并合并。
  private _resolveConfig(): LoggerService.Intercept {
    let intercept = this.ctx[symbols.intercept]
    const configs: LoggerService.Intercept[] = []
    while ('logger' in intercept) {
      if (Object.hasOwn(intercept, 'logger')) {
        configs.unshift(intercept['logger'])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return Object.assign({}, ...configs)
  }

  // invoke：调用 ctx.logger(name) 时执行——解析拦截配置，缺省名取拦截配置或
  // 当前 fiber 名（连字符化），门面元数据带 fiber 弱引用（诊断工具可反查来源插件）。
  [symbols.invoke](name?: string): Logger {
    const config = this._resolveConfig()
    const caller = (this as any)[symbols.caller] as Context | undefined
    const fiber = (caller ?? this.ctx).fiber
    name ??= config.name
    name ??= hyphenate(fiber.name)
    return new Logger({
      name,
      level: config.level,
      meta: { fiber: new WeakRef(fiber) },
    }, this)
  }

  static {
    // 快捷方法：ctx.logger.error(...) 等价 ctx.logger().error(...)——
    // 名字由调用现场 fiber 推导。
    for (const type of ['error', 'info', 'warn', 'debug'] as const) {
      ;(LoggerService.prototype as any)[type] = function (this: LoggerService, ...args: any[]) {
        return (this as any)()[type](...args)
      }
    }
  }
}
