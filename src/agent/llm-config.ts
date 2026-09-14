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
