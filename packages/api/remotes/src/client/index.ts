// 模块说明：与平台无关的生成 Host 远端贡献装配（assembly）。
/** Platform-neutral assembly of generated Host Remote contributions. */

// Cordis 的 Context（上下文）类型：Client 插件装配目标。
import type { Context } from '@deepseek-ai/cordis'
// 以下各 import 为各能力包生成的远端贡献（Remote contribution）默认导出，
// 将在本装配中按顺序挂载到 Client。
import productAnalyticsRemote from '@deepseek-ai/dsh-client-product-analytics/remote'
// 该贡献的类型面同时导出，供消费方引用。
export type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
// Agent 预设注册表远端。
import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'
// 用户提问远端。
import userQuestionsRemote from '@deepseek-ai/dsh-user-questions/remote'
// 命令（commands）远端。
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
// Agent 团队远端。
import agentTeamsRemote from '@deepseek-ai/dsh-agent-team/remote'
// 其类型面同时导出。
export type {} from '@deepseek-ai/dsh-agent-team/remote'
import accountRemote from '@deepseek-ai/dsh-deepseek-account/remote'
import settingsControllerRemote from '@deepseek-ai/dsh-api-settings-controller/remote'
import officeKitRemote from '@deepseek-ai/dsh-office-kit/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
// 计划任务（schedule）远端。
import scheduleRemote from '@deepseek-ai/dsh-schedule/remote'
// LLM 远端。
import llmRemote from '@deepseek-ai/dsh-llm/remote'
// Cordis 宿主运行器（动态插件）远端。
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
// 插件管理器远端。
import pluginManagerRemote from '@deepseek-ai/dsh-plugin-manager/remote'
// MCP 管理器远端。
import mcpManagerRemote from '@deepseek-ai/dsh-mcp-manager/remote'
// 轨迹工具结果远端。
import toolResultsRemote from '@deepseek-ai/dsh-client-ui-trajectory/remote'
// 插件注册表探针远端。
import pluginRegistryProbeRemote from '@deepseek-ai/dsh-client-ui-plugin-manager/remote'
// 插件市场远端。
import pluginMarketRemote from '@deepseek-ai/dsh-plugin-market/remote'
// 宿主插件清单远端。
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
// 消息反馈远端。
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
// 权限预设远端。
import permissionPresetsRemote from '@deepseek-ai/dsh-permission-presets/remote'
// 命令反馈（会话反馈）远端。
import sessionFeedbackRemote from '@deepseek-ai/dsh-command-feedback/remote'
// 文件上传远端。
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'
// 会话引用远端。
import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote'
// 子代理远端。
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
// 会话控制远端。
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
// 任务控制远端。
import jobRemote from '@deepseek-ai/dsh-api-job-controller/remote'
// 工作区控制远端。
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
// 终端控制远端。
import terminalRemote from '@deepseek-ai/dsh-api-terminal-controller/remote'
// 工作区文件远端。
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'
// Web 能力远端。
import webRemote from '@deepseek-ai/dsh-web/remote'
// 网关客户端的 ClientRemote 类型：装配后 Context.remote 的形状。
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'

// 转发 ClientRemote：业务包从这里取 Context.remote 的类型。
export type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// 转发插件管理器命名空间的载荷词汇（类型），供业务包统一引用。
export type {
  BundleDetail, BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind,
  ManagementError, PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  PluginUpdateProgress, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, RegistryAttempt,
  ReadOnlyReason, Registry, RestartReason,
} from '@deepseek-ai/dsh-plugin-manager/types'
// 转发 MCP 管理器命名空间的受管服务器状态与视图类型。
export type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
// 以下空类型导出把各远端模块的模块扩充纳入本编译面（登记命名空间/事件类型）。
export type {} from '@deepseek-ai/dsh-plugin-manager/remote'
export type {} from '@deepseek-ai/dsh-mcp-manager/remote'
export type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/remote'
export type {} from '@deepseek-ai/dsh-client-ui-trajectory/remote'
export type {} from '@deepseek-ai/dsh-plugin-market/remote'
// 转发插件市场命名空间的词汇类型。
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort, PluginDetail, PluginDetailDocumentId, PluginDetailOrigin,
} from '@deepseek-ai/dsh-plugin-market/types'
// 转发宿主插件清单快照类型。
export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
// 以下继续为各远端模块的空类型导出（纳入其模块扩充）。
export type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
export type {} from '@deepseek-ai/dsh-user-questions/remote'
export type {} from '@deepseek-ai/dsh-commands/remote'
export type {} from '@deepseek-ai/dsh-web/remote'
export type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
export type {} from '@deepseek-ai/dsh-deepseek-account/remote'
export type {} from '@deepseek-ai/dsh-goal/remote'
export type {} from '@deepseek-ai/dsh-schedule/remote'
export type {} from '@deepseek-ai/dsh-office-kit/remote'
export type {} from '@deepseek-ai/dsh-llm/remote'
export type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote'
export type {} from '@deepseek-ai/dsh-message-feedback/remote'
export type {} from '@deepseek-ai/dsh-permission-presets/remote'
export type {} from '@deepseek-ai/dsh-command-feedback/remote'
export type {} from '@deepseek-ai/dsh-client-file-upload/remote'
export type {} from '@deepseek-ai/dsh-session-reference/remote'
export type {} from '@deepseek-ai/dsh-subagent/remote'
// 子代理客户端面整体转发（类型）。
export type * from '@deepseek-ai/dsh-subagent/client'
// 会话控制远端与类型的转发。
export type {} from '@deepseek-ai/dsh-api-session-controller/remote'
export type * from '@deepseek-ai/dsh-api-session-controller/types'
// 任务控制远端与类型的转发。
export type {} from '@deepseek-ai/dsh-api-job-controller/remote'
export type * from '@deepseek-ai/dsh-api-job-controller/types'
// 工作区控制远端与类型的转发。
export type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
export type * from '@deepseek-ai/dsh-api-workspace-controller/types'
// 工作区文件远端与类型的转发。
export type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
export type * from '@deepseek-ai/dsh-api-workspace-files/types'
// 终端控制远端与类型的转发。
export type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
export type * from '@deepseek-ai/dsh-api-terminal-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
// 转发事件白名单的“选择席位”：消费端编译面若缺少它，`TypertRemoteEvent` 会是 never，
// 每一次 `$on` 调用都会失败。
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
// 以下空类型导出把各拥有包的 `./types` 事件签名引入消费端编译面：
// `$on` 交给监听器的 Events 签名即 Host 发出的原始声明，而非压平的复述。
export type {} from '@deepseek-ai/dsh-commands/types'
export type {} from '@deepseek-ai/dsh-web/types'
export type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
export type {} from '@deepseek-ai/dsh-credentials/types'
export type {} from '@deepseek-ai/dsh-llm/types'
export type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
export type {} from '@deepseek-ai/dsh-permission-presets/types'
export type {} from '@deepseek-ai/dsh-settings/types'
export type {} from '@deepseek-ai/dsh-user-approval/types'
export type {} from '@deepseek-ai/dsh-user-questions/types'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

// 载体（carrier）的 Client 面类型，转发后业务包只需指名一个装配包，
// 而不必同时引用本门面与连接插件。纯类型：载体的运行时值仍留在自己的模块边界内。
/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@deepseek-ai/dsh-client-connection/client'
// 空类型导出：纳入网关客户端的模块扩充。
export type {} from '@deepseek-ai/dsh-api-gateway/client'
// 空类型导出：纳入 Cordis 宿主运行器远端的模块扩充。
export type {} from '@deepseek-ai/dsh-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
// 凭据命名空间的凭据状态词汇（值永远不会经此传输）。
export type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
// 设置命名空间的脱敏词汇（机密永远不会经此传输）；它随接缝同行，
// Client 面已在读取该接缝的 `./types`。
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@deepseek-ai/dsh-settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
// llm 命名空间的提供方注册与发现词汇。
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@deepseek-ai/dsh-llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
// fileReferences 与 sessionReferenceResolver 命名空间的引用发现结果词汇。
export type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
// 转发远端宿主事实（RemoteHostFacts）类型。
export type { RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'

// 模块扩充：把装配选定的远端命名空间登记到 Cordis Context。
declare module '@deepseek-ai/cordis' {
  interface Context {
    // 本 Client 装配选定的生成远端命名空间集合。
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

// 所需服务：类型化 Client 远端贡献的挂载服务。
/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

// 挂载本 Client 装配明确选定的 Host 能力。
/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  // 收集每个贡献的卸载函数。
  const disposers: Array<() => Promise<void>> = []
  try {
    // 依次挂载全部选定的远端贡献。
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, agentTeamsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, mcpManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote,
      toolResultsRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeKitRemote, userQuestionsRemote, webRemote,
    ]) {
      // 挂载并记录其卸载函数。
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    // 挂载失败：按逆序卸载已挂载的命名空间，再把错误上抛。
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  // 按挂载的逆序卸载，确保任何命名空间都不会比后挂载者活得更久。
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
