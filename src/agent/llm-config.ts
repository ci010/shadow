import type { ModelInfo } from '../providers/provider.ts'

export interface ThinkingConfig {
  type: 'enabled' | 'disabled'
}

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some(effort => effort === value)
}

export function isGptModel(model: string): boolean {
  const unqualified = model.split('@')[0]
  return /(?:^|\/)gpt(?:-|$)/i.test(unqualified)
}

/**
 * Runtime config for the agent loop.
 */
export interface LlmRuntimeConfig {
  /** The model to use for the LLM. */
  model: string
  /** Total token budget the model can hold (prompt + completion). Used by handoff logic. */
  contextWindow: number
  /** The sampling temperature for the model. */
  temperature: number
  /** The thinking model configuration. */
  thinking?: ThinkingConfig
  /** The reasoning effort level for the model. */
  reasoningEffort?: ReasoningEffort
  /** Per-request completion budget — sent to the API as `max_tokens`. Set via agent type frontmatter. */
  maxTokens?: number
}

export type InferenceSettings = Partial<Pick<LlmRuntimeConfig,
  'model' | 'temperature' | 'maxTokens' | 'thinking' | 'reasoningEffort'>>

/** Omitted values inherit, rather than clearing the preceding configuration. */
export function inferenceSettings(value: InferenceSettings | undefined): InferenceSettings {
  return {
    ...(value?.model !== undefined ? { model: value.model } : {}),
    ...(value?.temperature !== undefined ? { temperature: value.temperature } : {}),
    ...(value?.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
    ...(value?.thinking !== undefined ? { thinking: { ...value.thinking } } : {}),
    ...(value?.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort } : {}),
  }
}

export function resolveInferenceSettings(
  defaults: LlmRuntimeConfig, agent?: InferenceSettings, session?: InferenceSettings,
): LlmRuntimeConfig {
  return { ...defaults, ...inferenceSettings(agent), ...inferenceSettings(session) }
}

export function validateInferenceCapabilities(
  settings: InferenceSettings, defaults: LlmRuntimeConfig, models: ModelInfo[],
  catalogModelId = settings.model ?? defaults.model,
): void {
  if (settings.model === undefined && settings.reasoningEffort === undefined) return
  const effective = resolveInferenceSettings(defaults, settings)
  const model = models.find(model => model.id === catalogModelId)
  if (!model) throw new Error(`Model ${effective.model} is not in the current provider catalog. Inspect available models before publishing.`)
  if (model.selectable === false) throw new Error(`Model ${effective.model} is not selectable.`)
  if (effective.reasoningEffort !== undefined && model.reasoningEfforts !== undefined &&
    !model.reasoningEfforts.includes(effective.reasoningEffort)) {
    throw new Error(`Model ${effective.model} does not support reasoningEffort ${effective.reasoningEffort}.`)
  }
}
