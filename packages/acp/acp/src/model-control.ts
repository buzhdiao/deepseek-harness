/** Standard ACP session configuration over one Agent's model selection. */
// 在单个 Agent 的模型选择之上实现标准 ACP 会话配置。

import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
// 导入 ACP 的会话配置选项与选项值 id 类型。
import { type Model, type ModelSelection } from '@deepseek-ai/dsh-agent'
// 导入 Agent 的模型（Model）与模型选择（ModelSelection）类型。
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'
// 导入推理力度 id 品牌类型、调用配置与 LLM 运行时类型。

// 模型配置选项的 id。
const MODEL_CONFIG_ID = 'model'
// 推理力度配置选项的 id。
const REASONING_CONFIG_ID = 'reasoning_effort'
// DSH reasoning effort ids are non-empty, so the empty opaque ACP value is a disjoint provider-default choice.
// DSH 的推理力度 id 均非空，因此空的 ACP 不透明值可以表示互斥的“提供方默认”选择。
const PROVIDER_DEFAULT_REASONING_VALUE = ''

// 单个模型选项：模型选择与对应的不透明值。
interface ModelChoice {
  selection: ModelSelection
  value: SessionConfigValueId
}

// 配置状态：值到选择的映射，以及对外选项列表。
interface ConfigState {
  choices: Map<SessionConfigValueId, ModelSelection>
  options: SessionConfigOption[]
}

/** Caller-correctable session configuration failure. */
// 调用方可修正的会话配置错误（映射为 ACP invalid params）。
export class AcpModelConfigError extends Error {
  constructor(message: string) {
    super(message)
    // 固定错误名，便于跨边界识别。
    this.name = 'AcpModelConfigError'
  }
}

/**
 * Project and mutate one Agent's provider/model/reasoning selection through ACP
 * config options. The Session's recorded model selection is the only state; a
 * change applies from the Agent's next model step.
 */
// 通过 ACP 配置项投影并修改 Agent 的 provider/model/推理力度选择（详见上方英文说明）；
// 会话记录的模型选择是唯一状态，变更从 Agent 下一次模型步骤起生效。
export class AcpModelControl {
  // 序列化队列的尾部 Promise：保证并发变更按接收顺序执行。
  private tail = Promise.resolve()
  // 是否已成功解析过路由状态（决定路由失败时的降级策略）。
  private hasResolvedState = false

  constructor(
    private readonly llm: LlmRuntime,
    private readonly model: Model,
  ) {}

  /**
   * Return the complete standard config-option state after prior mutations settle.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  // 在既有变更结算后返回完整的标准配置选项状态。
  options(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => (await this.state(signal)).options)
  }

  /**
   * Set one advertised option and return the complete resulting option state.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  // 设置一个已声明的选项，并返回变更后的完整选项状态。
  set(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => {
      // 选项值必须是不透明字符串。
      if (typeof value !== 'string') throw new AcpModelConfigError(`${configId} requires a select value`)
      // 读取当前模型选择。
      const current = this.model.current()
      if (current === undefined) throw new AcpModelConfigError('this session has no model selection')
      if (configId === MODEL_CONFIG_ID) {
        // 模型切换：先构建状态，再在选项映射中查找目标值。
        const state = await this.state(signal)
        const selected = state.choices.get(value)
        if (selected === undefined) throw new AcpModelConfigError(`unknown model option: ${value}`)
        // 校验目标路由确实可用，然后应用选择。
        await this.resolveSelection(selected, signal)
        this.model.select(selected)
      } else if (configId === REASONING_CONFIG_ID) {
        // 推理力度：先解析当前模型的推理能力信息。
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        // “提供方默认”仅在值为空且提供方未声明默认力度时成立。
        const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE
          && info.reasoning?.defaultEffort === undefined
        if (
          // 无推理能力，或值不在已声明力度中（且不是提供方默认）即非法。
          info.reasoning === undefined
          || (!providerDefault && !info.reasoning.efforts.some(effort => effort.id === value))
        ) {
          throw new AcpModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`)
        }
        // 应用选择：提供方默认时不携带 reasoningEffort 字段，否则携带品牌化力度 id。
        this.model.select(await this.resolveSelection({
          provider: current.provider,
          model: current.model,
          ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) },
        }, signal))
      } else {
        // 未知的配置项 id。
        throw new AcpModelConfigError(`unknown session config option: ${configId}`)
      }
      // 返回变更后的完整选项状态。
      return (await this.state(signal)).options
    })
  }

  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  // 让并发客户端变更按接收顺序执行；单个失败不会卡死队列。
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // 把操作接到队尾串行执行。
    const result = this.tail.then(operation)
    // 推进队尾时吞掉结果与错误，避免失败传染后续操作。
    this.tail = result.then(() => undefined, () => undefined)
    // 对外返回携带原始结果/错误的 Promise。
    return result
  }

  /** Build detached model choices and the dependent reasoning option. */
  // 构建独立的模型选项清单，以及依赖当前模型的推理力度选项。
  private async state(signal?: AbortSignal): Promise<ConfigState> {
    // 读取当前选择。
    const selected = this.model.current()
    // 无选择时返回空状态。
    if (selected === undefined) return { choices: new Map(), options: [] }
    let resolved: ModelSelection
    // 当前路由是否可用。
    let routeAvailable = true
    try {
      // 校验当前路由（同时规范化选择字段）。
      resolved = await this.resolveSelection(selected, signal)
      this.hasResolvedState = true
    } catch (error: unknown) {
      // 从未成功解析过则直接上抛；否则降级为“路由不可用”，沿用原选择。
      if (!this.hasResolvedState) throw error
      resolved = selected
      routeAvailable = false
    }
    // 不透明值到选择的映射。
    const choices = new Map<SessionConfigValueId, ModelSelection>()
    // 并发枚举每个 provider 的模型目录。
    const groups = await Promise.all(this.llm.listProviders().map(async (provider) => {
      try {
        // 列出该 provider 的模型。
        const models = await this.llm.listModels(provider.id)
        // 每个模型生成一个选项并登记到映射。
        const entries = models.map((model) => {
          const choice: ModelChoice = {
            value: modelValue(provider.id, model.id),
            selection: { provider: provider.id, model: model.id },
          }
          choices.set(choice.value, choice.selection)
          return {
            value: choice.value,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
          }
        })
        // 返回该 provider 的选项组。
        return { group: provider.id, name: provider.name, options: entries }
      } catch (_providerCatalogUnavailable) {
        // 目录不可用的 provider 保留为空组（稍后被过滤）。
        return { group: provider.id, name: provider.name, options: [] }
      }
    }))
    // 当前选择对应的不透明值。
    const currentValue = modelValue(resolved.provider, resolved.model)
    if (!choices.has(currentValue)) {
      // 当前模型不在目录中（如目录暂时不可用）：补入映射并插到选项组首位。
      choices.set(currentValue, { provider: resolved.provider, model: resolved.model })
      let group = groups.find(item => item.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    // 构造模型选择项（只保留非空组）。
    const options: SessionConfigOption[] = [{
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: groups.filter(group => group.options.length > 0),
    }]
    // 路由可用时解析模型信息，决定是否提供推理力度选项。
    const info = routeAvailable
      ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      : undefined
    if (info?.reasoning !== undefined) {
      options.push({
        id: REASONING_CONFIG_ID,
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        // 当前值：未设置力度时用空的“提供方默认”值。
        currentValue: resolved.reasoningEffort === undefined
          ? PROVIDER_DEFAULT_REASONING_VALUE
          : String(resolved.reasoningEffort),
        options: [
          // 仅当提供方未声明默认力度时才提供“Provider default”选项。
          ...info.reasoning.defaultEffort === undefined
            ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
            : [],
          // 已声明的力度逐个映射为选项。
          ...info.reasoning.efforts.map(effort => ({
            value: String(effort.id),
            name: effort.name,
            ...effort.description === undefined ? {} : { description: effort.description },
          })),
        ],
      })
    }
    // 返回完整状态。
    return { choices, options }
  }

  /** Validate an exact route and retain only Agent-owned selection fields. */
  // 校验精确路由，只保留 Agent 拥有的选择字段。
  private async resolveSelection(selection: ModelSelection, signal?: AbortSignal): Promise<ModelSelection> {
    // 交由 LLM 运行时解析完整调用配置。
    const resolved: LlmCallConfig = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
  }
}

/** Opaque ACP selector value carrying the full route identity. */
// 承载完整路由身份的 ACP 不透明选择值（JSON 数组 [provider, model]）。
function modelValue(provider: string, model: string): SessionConfigValueId {
  return JSON.stringify([provider, model])
}
