/** ACP wire-content admission and projection owned by the ACP adapter. @module */
// ACP 线上内容（wire-content）的准入与投影模块，由 ACP 适配器（adapter）负责。

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
// 导入 ACP 的内容块（ContentBlock）类型，重命名为 AcpContentBlock。
import type { Context } from '@deepseek-ai/cordis'
// 导入 Cordis 的 Context：用于从桥接上下文获取服务。
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
// 导入图片准入错误的判别函数。
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
// 导入附件相关类型：图片引用、图片 MIME 类型、待保存图片。
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
// 导入模型选择（ModelSelection）类型：provider + model 路由。
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// 导入核心 LLM 内容块（ContentBlock）类型。

/** Raster formats shared by ACP image blocks and the core attachment vocabulary. */
// ACP 图片块与核心附件词汇表共享的位图（raster）格式白名单。
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
// 规范（canonical）RFC 4648 base64：不允许空白字符与 URL 安全别名（-、_）。
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Content-admission failure category used by the protocol handler. */
// 内容准入失败的类别：invalid（协议层参数非法）或 internal（内部错误）。
export type AcpContentFailureKind = 'invalid' | 'internal'

/** Error with a stable ACP request-failure category and no raw binary payload. */
// 带稳定 ACP 请求失败类别、且不携带原始二进制载荷的错误。
export class AcpContentError extends Error {
  /** Whether the bridge should report invalid params or an internal failure. */
  readonly kind: AcpContentFailureKind

  /**
   * @param message - safe protocol-facing detail without inline binary data.
   * @param kind - request-failure category.
   * @param options - optional causal chain for diagnostics.
   */
  constructor(message: string, kind: AcpContentFailureKind, options?: ErrorOptions) {
    // 调用 Error 构造器，message 不含内联二进制数据。
    super(message, options)
    // 固定错误名，便于跨边界识别。
    this.name = 'AcpContentError'
    // 记录失败类别。
    this.kind = kind
  }
}

/** Narrow a wire MIME string to the durable raster vocabulary. */
// 把线上 MIME 字符串收窄（narrow）为持久的位图类型；不在白名单则返回 undefined。
function imageMediaType(value: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType) ? value as ImageMediaType : undefined
}

/** Strictly decode one ACP inline image without accepting base64 aliases. */
// 严格解码一个 ACP 内联图片：不接受任何 base64 别名或非规范编码。
function decodeImage(block: Extract<AcpContentBlock, { type: 'image' }>): SaveImageAttachment {
  // 先校验 MIME 类型在白名单内。
  const mediaType = imageMediaType(block.mimeType)
  if (mediaType === undefined) {
    throw new AcpContentError('image mimeType must be image/png, image/jpeg, image/webp, or image/gif', 'invalid')
  }
  // 再校验数据是规范 base64（无空白、无 URL 安全字符、填充正确）。
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  // 按 base64 解码为 Buffer。
  const data = Buffer.from(block.data, 'base64')
  // 回编码比对：防止长度非 4 的倍数等边界情形漏网。
  if (data.toString('base64') !== block.data) {
    throw new AcpContentError('image data must be canonical base64', 'invalid')
  }
  // 返回待保存的图片附件（数据 + MIME 类型）。
  return { data, mediaType }
}

/** Resolve the exact current route and require explicit image input support. */
// 解析当前确切路由，并要求模型显式声明支持图片输入。
async function assertImageRoute(ctx: Context, route: ModelSelection | undefined, signal: AbortSignal): Promise<void> {
  // 取路由中的 provider 与 model。
  const provider = route?.provider
  const model = route?.model
  // 从上下文获取 llm 服务。
  const llm = ctx.get('llm')
  // 路由或服务缺失时按参数非法处理。
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new AcpContentError('the current model route could not be resolved for image input', 'invalid')
  }
  // 模型信息类型（由 resolveModelInfo 的返回推导）。
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    // 解析模型信息（支持传入中止信号）。
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch (error: unknown) {
    // 解析失败归为内部错误，并保留因果链。
    throw new AcpContentError('the current model route could not be verified for image input', 'internal', { cause: error })
  }
  // 模型未声明图片输入模态则拒绝。
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new AcpContentError(`model "${model}" does not declare image input`, 'invalid')
  }
}

/**
 * Determine whether initialization may truthfully advertise inline image prompts.
 * Unknown service, route, capability, or deployment media support is negative.
 * @param ctx - bridge context carrying optional attachment and model services.
 * @param provider - configured provider route used for newly created sessions.
 * @param model - configured exact model id used for newly created sessions.
 * @returns whether this bridge can admit images at initialization time.
 */
// 判定初始化时能否如实声明支持内联图片提示（详见上方英文说明）。
export async function supportsAcpImagePrompts(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
): Promise<boolean> {
  // 获取附件服务与 llm 服务。
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  // 任一服务或路由缺失即视为不支持（未知一律回答否）。
  if (attachments === undefined || llm === undefined || provider === undefined || model === undefined) return false
  // 附件服务的媒体类型与位图白名单无交集则不支持。
  if (!attachments.imageLimits.mediaTypes.some(mediaType => IMAGE_MEDIA_TYPES.includes(mediaType))) return false
  try {
    // 查询模型信息，要求显式声明 image 输入模态。
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    // 查询失败按不支持处理。
    return false
  }
}

/** Render one baseline resource link into the core's current text vocabulary. */
// 把一个基线资源链接（resource_link）渲染为核心当前文本词汇的一段文字。
function resourceLinkText(block: Extract<AcpContentBlock, { type: 'resource_link' }>): string {
  return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
}

/**
 * Admit one ACP prompt into ordered durable core content.
 * Every wire block and image is validated before the ordered image batch starts
 * writing; cancellation after a successful content-addressed write may leave an
 * unreachable object but never queues a late user message.
 * @param ctx - bridge context carrying attachment and model services.
 * @param route - Agent model selection current at prompt admission.
 * @param prompt - untrusted ACP prompt blocks in wire order.
 * @param imageEnabled - capability result advertised during initialization.
 * @param signal - admission cancellation signal.
 * @returns core content with durable image references in wire order.
 */
// 把一个 ACP 提示（prompt）准入为有序、持久的核心内容（详见上方英文说明）：
// 先整体校验所有线上块，再按序写入图片批次；取消不会产生迟到的用户消息。
export async function admitAcpPrompt(
  ctx: Context,
  route: ModelSelection | undefined,
  prompt: readonly AcpContentBlock[],
  imageEnabled: boolean,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  // 收集全部待保存图片。
  const images: SaveImageAttachment[] = []
  // 第一遍遍历：仅做校验与收集，不产生副作用。
  for (const block of prompt) {
    switch (block.type) {
      // 文本与资源链接在此通过，稍后重建。
      case 'text':
      case 'resource_link':
        break
      case 'image':
        // 能力未声明时拒绝内联图片。
        if (!imageEnabled) throw new AcpContentError('inline image prompts were not advertised by this connection', 'invalid')
        // 严格解码并收集该图片。
        images.push(decodeImage(block))
        break
      // 音频与内嵌资源一律拒绝。
      case 'audio':
        throw new AcpContentError('audio prompt content is not supported', 'invalid')
      case 'resource':
        throw new AcpContentError('embedded resource prompt content is not supported', 'invalid')
      /* v8 ignore next 2 -- ACP ContentBlock is a closed generated union. */
      default:
        throw new AcpContentError('unsupported ACP prompt content', 'invalid')
    }
  }

  // 已保存图片的持久引用，默认为空。
  let refs: readonly ImageAttachmentRef[] = []
  if (images.length > 0) {
    // 有图片时才需要附件存储服务。
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new AcpContentError('no attachment store is mounted', 'invalid')
    // 校验当前路由确实支持图片输入。
    await assertImageRoute(ctx, route, signal)
    // 写入前再次检查取消状态。
    signal.throwIfAborted()
    try {
      // 按序保存整批图片（内容寻址存储）。
      refs = await attachments.saveImages(images)
    } catch (error: unknown) {
      // 准入类错误（尺寸、格式等）透传为 invalid 并保留原因。
      if (isImageAdmissionError(error)) {
        throw new AcpContentError(error.message, 'invalid', { cause: error })
      }
      // 其余错误归为内部错误。
      throw new AcpContentError('unable to persist the prompt image batch', 'internal', { cause: error })
    }
    // 写入成功后再检查取消：可能留下不可达对象，但绝不排队迟到消息。
    signal.throwIfAborted()
  }

  // 重建出的核心内容序列。
  const content: ContentBlock[] = []
  // 待合并的连续文本缓冲。
  let pendingText = ''
  // 图片引用游标，对应 wire 顺序。
  let imageIndex = 0
  // 把累积文本作为文本块冲刷进内容序列。
  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  // 第二遍遍历：按 wire 顺序重建核心内容。
  for (const block of prompt) {
    switch (block.type) {
      // 文本追加进缓冲（相邻文本自动合并）。
      case 'text':
        pendingText += block.text
        break
      // 资源链接渲染为文本后追加。
      case 'resource_link':
        pendingText += resourceLinkText(block)
        break
      case 'image': {
        // 图片前先冲刷累积文本，保持 wire 顺序。
        flushText()
        // 取出对应位置的持久图片引用。
        const ref = refs[imageIndex++] as ImageAttachmentRef
        content.push({ type: 'image', attachment: ref })
        break
      }
      /* v8 ignore start -- the validation pass above rejects both tags before reconstruction. */
      case 'audio':
      case 'resource':
        break
      /* v8 ignore stop */
      /* v8 ignore next 2 -- validated by the first closed-union switch. */
      default:
        break
    }
  }
  // 收尾：冲刷剩余文本。
  flushText()
  // 空提示（无图片且无非空白文本）按参数非法拒绝。
  if (!content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0))) {
    throw new AcpContentError('empty prompt', 'invalid')
  }
  // 返回最终核心内容。
  return content
}

/**
 * Translate one committed assistant block to ACP wire content.
 * Images are re-read and integrity-verified before inline base64 delivery;
 * unsupported core output blocks stay off the automation wire.
 * @param ctx - bridge context carrying the authoritative attachment store.
 * @param block - committed core assistant block.
 * @returns ACP text/image content, or undefined for non-output blocks.
 */
// 把一个已提交的助手块翻译为 ACP 线上内容（详见上方英文说明）；
// 不支持的核心输出块不上自动化线路，返回 undefined。
export async function assistantBlockToAcp(
  ctx: Context,
  block: ContentBlock,
): Promise<AcpContentBlock | undefined> {
  // 文本块：空文本不产出线上内容。
  if (block.type === 'text') {
    return block.text.length === 0 ? undefined : { type: 'text', text: block.text }
  }
  // 仅支持文本与图片，其余类型返回 undefined。
  if (block.type !== 'image') return undefined
  // 图片需要权威附件存储。
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new AcpContentError('cannot deliver assistant image: no attachment store is mounted', 'internal')
  }
  // 存储读取结果类型（由 readImage 的返回推导）。
  let stored: Awaited<ReturnType<typeof attachments.readImage>>
  try {
    // 重新读取图片并做完整性校验（由存储层保证）。
    stored = await attachments.readImage(block.attachment)
  } catch (error: unknown) {
    // 读取失败（不可用或损坏）归为内部错误。
    throw new AcpContentError('cannot deliver assistant image: the attachment is unavailable or corrupt', 'internal', { cause: error })
  }
  // 以内联 base64 形式返回 ACP 图片块。
  return {
    type: 'image',
    data: Buffer.from(stored.data).toString('base64'),
    mimeType: stored.ref.mediaType,
  }
}
