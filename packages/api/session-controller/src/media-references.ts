// 模块说明：/api/file 媒体读取路由——把经过身份验证的 GET/HEAD 请求交给组合后的
// 文件系统提供方，返回有大小上限的文件响应；版本重定向与缓存策略在此集中处理。
/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. Paths and MIME types do not restrict access;
 * the connection service authenticates requests before this handler. A request
 * without the current `v` version is redirected, uncached, to the versioned URL,
 * whose response is cacheable indefinitely.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

// 导入 Node 的 path.isAbsolute，用于校验请求的路径必须是绝对路径
import { isAbsolute } from 'node:path'
// 导入 cordis 的 Context 类型（仅类型引用）
import type { Context } from '@deepseek-ai/cordis'
// 侧向类型引用：dsh-client-connection 提供的连接服务类型增强
import type {} from '@deepseek-ai/dsh-client-connection'
// 侧向类型引用：dsh-attachment 提供的附件服务类型增强
import type {} from '@deepseek-ai/dsh-attachment'
// 导入文件系统的错误类型 FsError 与 FileSystem 接口
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
// 导入 mime-types 库，用于根据文件扩展名推断 Content-Type
import mime from 'mime-types'

// 所有文件响应都附带的基础安全响应头
const BASE_HEADERS = {
  // 阻止浏览器对响应做 MIME 嗅探（nosniff）
  'X-Content-Type-Options': 'nosniff',
  // HTML 与 SVG 文件可能直接在经过身份验证的 API 源上被打开，因此用 sandbox 沙箱 CSP 限制其能力
  'Content-Security-Policy': "sandbox; default-src 'none'",
}
// 不允许缓存的响应头：用于无版本参数或出错的响应
const NO_STORE = { ...BASE_HEADERS, 'Cache-Control': 'private, no-store' }
// 带版本的 URL 唯一对应一个文件版本，因此其响应永远不会变化，可以永久缓存（immutable）
const VERSIONED = { ...BASE_HEADERS, 'Cache-Control': 'private, max-age=31536000, immutable' }

// 核心的文件服务函数：读取并返回受大小限制约束的文件响应
async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  // 构造失败响应的辅助函数：HEAD 请求不返回响应体，且一律使用 no-store 缓存头
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: NO_STORE })
  // 解析请求 URL 中的查询参数
  const params = new URL(request.url).searchParams
  // 取出 path 参数：要读取的文件绝对路径
  const path = params.get('path')
  // 缺少 path 或为空字符串：返回 400
  if (path === null || path.length === 0) return fail(400, 'missing path')
  // 路径包含空字节或不是绝对路径：返回 400（本接口只接受绝对路径）
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    // 在文件系统中解析路径，得到受访问策略约束的目标（target）句柄
    const target = await fs.resolve(path, { signal: request.signal })
    // 获取目标文件的元信息（类型、大小、版本等）
    const info = await fs.stat(target, request.signal)
    // 目标不存在：返回 404
    if (info === undefined) return fail(404, 'not found')
    // 目标不是普通文件（例如目录）：返回 403
    if (info.type !== 'file') return fail(403, 'not a regular file')
    // 文件大小已知且超过上限：返回 413
    if (info.size !== undefined && info.size > maxBytes) return fail(413, 'file exceeds byte limit')
    // 请求缺少当前版本号 `v`（或版本不匹配）：重定向到带正确版本的 URL
    if (params.get('v') !== info.version) {
      // 构造相对于当前请求 URL 的 Location（保持部署前缀与 Desktop 协议头不变）
      const location = `?${new URLSearchParams({ path, v: info.version }).toString()}`
      // 返回 302 重定向，且使用 no-store 头，确保浏览器总是重新校验版本
      return new Response(null, { status: 302, headers: { ...NO_STORE, Location: location } })
    }
    // 组装成功响应头：可永久缓存 + 按显示路径推断 MIME 类型（未知时回退到通用二进制类型）
    const headers: Record<string, string> = {
      ...VERSIONED,
      'Content-Type': mime.lookup(target.displayPath) || 'application/octet-stream',
    }
    // HEAD 请求只返回头部：附上 Content-Length，不读取文件内容
    if (request.method === 'HEAD') {
      if (info.size !== undefined) headers['Content-Length'] = String(info.size)
      return new Response(null, { headers })
    }
    // GET 请求：读取文件字节（读取被限制在 maxBytes 内）
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    // 以实际读到的字节数设置 Content-Length
    headers['Content-Length'] = String(bytes.byteLength)
    // bytes.slice() 复制一份缓冲，避免底层缓冲被复用或释放后响应失效
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    // 非 FsError 的异常不属于本处理器的职责，向上抛回给 fetch 基础设施
    if (!(error instanceof FsError)) throw error
    // 把 FsError 的错误码映射为对应的 HTTP 状态码
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404, // 文件未找到
      FS_NOT_REGULAR_FILE: 403, // 不是普通文件（如目录）
      FS_PERMISSION_DENIED: 403, // 权限被拒绝
      FS_SANDBOX_DENIED: 403, // 被沙箱策略拒绝访问
      FS_TOO_LARGE: 413, // 文件超出大小上限
      FS_ABORTED: 499, // 请求被客户端中止（499 为非标准的"客户端关闭连接"）
    }
    // 未映射的错误码一律按 500 处理，响应体给出错误码（no-store）
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * 文件展示（file-display）贡献项。连接服务负责提供身份验证；
 * `ctx.fs` 提供执行世界（execution world）的路径、读取能力与访问策略。
 */
export const SessionMediaReferences = {
  // 声明依赖注入的服务：connection（连接服务）、fs（文件系统）、attachments（附件配置）
  inject: ['connection', 'fs', 'attachments'],
  // 插件应用入口：向连接服务注册 /api/file 的 fetch 处理器
  apply(ctx: Context): void {
    // 从附件服务读取单张图片/文件的最大字节数限制
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    // 注册一个 effect（副作用）：生效期间登记 /api/file 路由，插件销毁时自动撤销
    ctx.effect(() => ctx.connection.fetch.register({
      // 路由路径：/api/file
      path: '/api/file',
      // 允许的 HTTP 方法：GET 与 HEAD
      methods: ['GET', 'HEAD'],
      // 请求体处理方式：缓冲（buffered）
      requestBody: 'buffered',
      // 实际处理函数：调用 serveFile，闭包捕获 fs 与 maxBytes
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
  },
}
