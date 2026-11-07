// 模块说明：把活跃的 LLM 注册表共享投影为浏览器端模型目录（model catalog）。
/** Shared projection of the live LLM registry into the browser model catalog. */

// Typert 协议的远端错误：目录校验失败时抛出的业务错误类型。
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// credentialRef：把引用字符串构造为凭据引用。
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// 空类型导入：引入设置（settings）服务的模块扩充（ctx.get / settings.describe）。
import type {} from '@deepseek-ai/dsh-settings'
// LlmModelInfo（LLM 模型信息）：目录条目的来源类型。
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
// Cordis 的 Context（上下文）类型。
import type { Context } from '@deepseek-ai/cordis'
// 本包类型：模型目录、模型推理配置与模型选择。
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

// 构建浏览器模型目录，无需任何 Session。
/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
): Promise<ModelCatalog> {
  // 列出当前可用的全部提供方（provider）。
  const providers = ctx.llm.listProviders()
  // 并发构建每个提供方的目录条目：成功产出分组，失败被隔离为 failure 项。
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      // 列出该提供方下的模型。
      const models = await ctx.llm.listModels(provider.id)
      // 并发解析每个模型的详情并组装目录条目。
      const entries = await Promise.all(models.map(async (model) => {
        // 解析模型的完整信息（含推理配置）。
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        // 投影推理（reasoning）配置：档位列表与可选的默认档位。
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            // 逐个档位投影 id 与名称，描述缺省则省略该字段。
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            // 默认档位缺省则省略该字段。
            ...(resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort }),
          }
        // 组装单个模型条目：缺省字段一律省略，保持线上形状精简。
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(model.badge === undefined ? {} : { badge: model.badge }),
        }
      }))
      // 提供方成功：产出分组条目。
      return {
        kind: 'group' as const,
        group: { id: provider.id, name: provider.name, models: entries },
      }
    } catch (error) {
      // 单个提供方失败被隔离：记录其 id、名称与错误消息，不影响其他提供方。
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  // 汇总非空分组：先取出分组，再过滤掉没有任何模型的。
  const groups = catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
    .filter(group => group.models.length > 0)
  // 组装最终目录：默认选择、可路由提供方、分组与失败清单。
  return {
    // 复制一份部署默认选择。
    default: { ...defaultSelection },
    // 可路由的提供方 id 列表。
    routableProviders: groups.map(group => group.id),
    // 非空模型分组。
    groups,
    // 被隔离的提供方失败清单。
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}

// 对照当前可用的提供方目录检查一次 GUI 选择。
/**
 * Check a GUI selection against the current available provider catalog.
 * @param ctx - Host LLM registry.
 * @param selection - stored or explicitly requested selection.
 * @returns whether the exact model is currently advertised as available.
 */
export async function modelAvailable(ctx: Context, selection: ModelSelection): Promise<boolean> {
  // 提供方不存在：模型必然不可用。
  if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) return false
  // 模型列表占位。
  let models: readonly LlmModelInfo[]
  try { models = await ctx.llm.listModels(selection.provider) }
  catch (error) {
    // 列模型失败：抛出结构化的远端错误，携带提供方与模型信息。
    throw new RemoteError('session/model-unavailable',
      error instanceof Error ? error.message : String(error),
      { provider: selection.provider, model: selection.model })
  }
  // 精确匹配模型 id：当前是否被宣告可用。
  return models.some(model => model.id === selection.model)
}

// 独立于模型可用性，检查各提供方已配置的 API-key 引用。
/**
 * Check configured provider API-key references independently of model availability.
 * @param ctx - Host registry, settings, and credential services.
 * @returns whether any API-key provider has a configured credential.
 */
export async function hasProviderApiKey(ctx: Context): Promise<boolean> {
  // 取设置与凭据服务。
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  // 服务缺失：凭据能力整体不可用，抛结构化错误。
  if (settings === undefined || credentials === undefined) {
    throw new RemoteError('session/provider-credentials-unavailable', 'provider credentials are unavailable', {})
  }
  // 读取设置命名空间描述（机密已脱敏）。
  const namespaces = settings.describe({ redactSecrets: true })
  // 逐个检查可配置提供方。
  for (const provider of ctx.llm.listConfigurableProviders()) {
    // DeepSeek 账号提供方不在此检查范围内。
    if (provider.provider === 'deepseek-account') continue
    // 定位该提供方的设置命名空间值。
    let profile = namespaces.find(namespace => namespace.ns === provider.settingsNs)?.value
    // 沿设置路径逐层下钻到提供方配置。
    for (const key of provider.settingsPath) {
      profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    }
    // 未下钻到配置对象：该提供方没有可检查的配置，跳过。
    if (typeof profile !== 'object' || profile === null) continue
    // 取 API-key 环境引用字段。
    const ref: unknown = Reflect.get(profile, 'apiKeyEnv')
    // 引用非空字符串且对应凭据已配置：认为该提供方具备 API key。
    if (typeof ref === 'string' && ref.length > 0
      && (await credentials.describe(credentialRef(ref))).configured) return true
  }
  // 没有任何提供方配置了凭据。
  return false
}
