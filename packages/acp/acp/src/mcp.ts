/** Standard ACP MCP-server declarations translated into Agent-scoped DSH MCP clients. */
// 把标准 ACP MCP 服务器声明翻译为 Agent 作用域（Agent-scoped）的 DSH MCP 客户端。

import type { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context 类型。
import { createHash } from 'node:crypto'
// 导入 createHash：为服务器名生成短摘要以保证唯一。
import { validateHeaderName, validateHeaderValue } from 'node:http'
// 导入 HTTP 头校验函数：校验 header 名与值。
import { isAbsolute } from 'node:path'
// 导入 isAbsolute：校验 stdio 命令为绝对路径。
import type { McpServer } from '@agentclientprotocol/sdk'
// 导入 ACP 的 MCP 服务器声明类型。
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
// 导入 DSH MCP 客户端插件（以其 Config 模式与插件形式使用）。

// 合法服务器名的白名单正则：1-32 个字母、数字、下划线或连字符。
const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Caller-correctable MCP declaration failure. */
// 调用方可修正的 MCP 声明错误（映射为 ACP invalid params）。
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    // 固定错误名，便于跨边界识别。
    this.name = 'AcpMcpConfigError'
  }
}

/**
 * Validate and mount one session's complete standard MCP server list before Agent publication.
 * @param agentCtx - unpublished Agent scope that owns the MCP clients and tools.
 * @param servers - stable ACP stdio or HTTP server declarations.
 * @param sessionCwd - canonical primary workspace used by stdio servers.
 */
// 在 Agent 发布前校验并挂载一个会话的完整标准 MCP 服务器列表。
export async function mountAcpMcpServers(
  agentCtx: Context,
  servers: readonly McpServer[],
  sessionCwd: string,
): Promise<void> {
  // 先把全部声明解析并校验为客户端配置（全部通过才挂载）。
  const configs = resolveMcpConfigs(servers, sessionCwd)
  // 逐个把 MCP 客户端插件挂载到未发布的 Agent 作用域。
  for (const config of configs) await agentCtx.plugin(McpClient, config)
}

/** Convert the stable stdio/HTTP ACP transports and reject every other transport. */
// 把 ACP 的 stdio/HTTP 两种稳定传输转换为客户端配置；其余传输一律拒绝。
function resolveMcpConfigs(servers: readonly McpServer[], sessionCwd: string): McpClient.Config[] {
  // 已用（规范化后）名称集合，用于重复检测。
  const names = new Set<string>()
  return servers.map((server, index) => {
    // 规范化服务器名（必要时附加摘要后缀）。
    const serverName = normalizeServerName(server.name)
    // 规范化后重名即报错。
    if (names.has(serverName)) {
      throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    }
    names.add(serverName)
    if (!('type' in server)) {
      // 无 type 字段即 stdio 传输：命令必须是绝对路径。
      if (!isAbsolute(server.command)) {
        throw new AcpMcpConfigError(`mcpServers[${index}].command must be an absolute path`)
      }
      // 把 env 项转换为记录（含校验）。
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, 'environment')
      // 构造 stdio 客户端配置并做模式校验；启动失败即失败。
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command: server.command,
        args: server.args,
        env,
        cwd: sessionCwd,
        failOnStartupError: true,
      }))
      // 展开后覆写 env，保留空原型对象。
      return { ...config, env }
    }
    if (server.type === 'http') {
      // HTTP 传输：先校验 URL。
      assertHttpUrl(server.url, `mcpServers[${index}].url`)
      // 把 header 项转换为记录（含校验）。
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, 'header')
      // 构造 streamable-http 客户端配置并做模式校验。
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers,
        failOnStartupError: true,
      }))
      // 展开后覆写 headers。
      return { ...config, headers }
    }
    // 其他传输类型不受支持。
    throw new AcpMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`)
  })
}

/** Convert ordered ACP name/value entries without silently accepting duplicate keys. */
// 把有序的 ACP 名称/值项转换为记录；不静默接受重复键。
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  field: string,
  kind: 'environment' | 'header',
): Record<string, string> {
  // Valid environment and header names include "__proto__"; a null prototype
  // keeps that entry as data instead of invoking Object.prototype's setter.
  // 合法的环境变量与 header 名可能包含 "__proto__"；使用空原型对象让该条目保持为
  // 纯数据，而不会触发 Object.prototype 的 setter。
  const result = Object.create(null) as Record<string, string>
  // 已见身份集合（header 不区分大小写）。
  const names = new Set<string>()
  for (const entry of entries) {
    if (kind === 'header') {
      try {
        // 用 Node 内置校验器检查 header 名与值的合法性。
        validateHeaderName(entry.name)
        validateHeaderValue(entry.name, entry.value)
      } catch (_invalidHeader) {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (
      // 环境变量条目：名非空、不含 = 或 NUL，值不含 NUL。
      entry.name.length === 0
      || entry.name.includes('=')
      || entry.name.includes('\0')
      || entry.value.includes('\0')
    ) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    // 重复判断的身份键：header 按小写折叠，env 按原名。
    const identity = kind === 'header' ? entry.name.toLowerCase() : entry.name
    if (names.has(identity)) throw new AcpMcpConfigError(`${field} contains duplicate name: ${entry.name}`)
    names.add(identity)
    // 写入键值对。
    result[entry.name] = entry.value
  }
  return result
}

/** Produce a stable DSH tool namespace from ACP's human-readable server name. */
// 从 ACP 人类可读的服务器名生成稳定的 DSH 工具命名空间。
function normalizeServerName(name: string): string {
  // 空白名或含控制字符的名字非法。
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  // 已符合白名单的名字原样使用。
  if (VALID_SERVER_NAME.test(name)) return name
  // 否则做 slug 化：NFKD 规范化、非法字符折叠为下划线、修剪首尾下划线、截断到 20 字符。
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  // 附加原名的 8 位 sha256 前缀，避免不同名字折叠成同一 slug。
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  // 拼接 slug 与摘要并截断到 32 字符。
  return `${slug}_${digest}`.slice(0, 32)
}

/** Require the stable Streamable HTTP transport URL schemes. */
// 要求 Streamable HTTP 传输使用稳定的 URL 协议（仅 http/https）。
function assertHttpUrl(value: string, field: string): void {
  try {
    // 解析 URL 并校验协议白名单。
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch (_invalidUrl) {
    // 解析失败或协议不支持统一报错。
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

/** Map the existing MCP provider's schema error into ACP invalid params. */
// 把 MCP 提供方的模式校验错误映射为 ACP 的参数非法错误。
function validateClientConfig(index: number, parse: () => McpClient.Config): McpClient.Config {
  try {
    // 执行模式解析。
    return parse()
  } catch (error: unknown) {
    // 提取错误消息（非 Error 实例兜底为字符串化）。
    /* v8 ignore next -- Schemastery validation rejects with Error instances. */
    const detail = error instanceof Error ? error.message : String(error)
    // 包装为带索引定位的配置错误。
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
