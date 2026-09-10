export interface ThinkingConfig {
  type: 'enabled' | 'disabled'
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
  reasoningEffort?: 'high' | 'max'
  /** Per-request completion budget — sent to the API as `max_tokens`. Set via agent type frontmatter. */
  maxTokens?: number
}
