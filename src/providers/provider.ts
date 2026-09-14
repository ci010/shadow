import type { ReasoningEffort, ThinkingConfig } from '../agent/llm-config.ts'
import type { ToolDefinition } from '../tools/tool.ts'

/**
 * A single tool call request from the LLM.
 */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ResponsesOutputAnnotation =
  | { type: 'file_citation'; file_id: string; filename: string; index: number }
  | { type: 'url_citation'; start_index: number; end_index: number; url: string; title: string }
  | { type: 'container_file_citation'; container_id: string; file_id: string; filename: string; start_index: number; end_index: number }
  | { type: 'file_path'; file_id: string; index: number }

/** Supported completed Responses items, retained in their original output order. */
export type ResponsesOutputItem =
  | {
    type: 'reasoning'
    id?: string
    status?: 'completed'
    encrypted_content?: string | null
    summary: Array<{ type: 'summary_text'; text: string }>
    /** DeepSeek replays plain-text reasoning rather than encrypted state. */
    content?: Array<{ type: 'reasoning_text'; text: string }>
  }
  | {
    type: 'message'
    id: string
    role: 'assistant'
    status: 'completed'
    phase?: 'commentary' | 'final_answer' | null
    content: Array<
      | { type: 'output_text'; text: string; annotations: ResponsesOutputAnnotation[] }
      | { type: 'refusal'; refusal: string }
    >
  }
  | {
    type: 'function_call'
    id?: string
    status?: 'completed'
    call_id: string
    name: string
    arguments: string
  }

/** Provider-only stateless Responses continuity, scoped to its issuing provider/model. */
export interface ResponsesProviderState {
  provider: 'copilot' | 'deepseek'
  model: string
  reasoning: Array<{
    type: 'reasoning'
    id?: string
    encrypted_content: string
    summary: Array<{ type: 'summary_text'; text: string }>
  }>
  /** Authoritative ordered replay; older records may contain only reasoning. */
  outputItems?: ResponsesOutputItem[]
}

/**
 * Structured response from an LLM provider.
 */
export interface LLMResponse {
  /** Text content (may be empty if only tool calls). */
  content: string | null
  /**
   * Round-trippable chain-of-thought. Sent back to the provider on the next
   * turn (DeepSeek requires this for thinking-mode continuity).
   */
  reasoningContent?: string | null
  /**
   * Display-only reasoning narration (e.g. Copilot `reasoning_text`,
   * OpenAI `reasoning`). Must NOT be sent back to the provider — some
   * providers reject or ignore it, and it bloats the prompt.
   */
  reasoningText?: string | null
  providerState?: ResponsesProviderState
  /** Tool calls requested by the model. */
  toolCalls: ToolCall[]
  /** Actual model name returned by the provider, if available. */
  model?: string
  /** Usage stats. */
  usage?: LLMResponseUsage
}

export interface LLMResponseUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * A text content part in a multimodal message.
 */
export interface TextContentPart {
  type: 'text'
  text: string
}

/**
 * An image content part in a multimodal message.
 * `url` may be an https URL or a base64 data URI (`data:image/...;base64,...`).
 */
export interface ImageContentPart {
  type: 'image_url'
  image_url: {
    url: string
    /** Level of detail sent to the model. Defaults to 'auto'. */
    detail?: 'auto' | 'low' | 'high'
  }
}

/** Union of all supported content part types. */
export type ContentPart = TextContentPart | ImageContentPart

/**
 * Message in the conversation (OpenAI-compatible shape).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * Plain string content for text-only messages, or an array of content parts
   * for multimodal messages (text + images). Use `null` for assistant messages
   * that contain only tool calls.
   */
  content: string | ContentPart[] | null
  /** For assistant messages with tool calls */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  /** For tool-result messages */
  tool_call_id?: string
  name?: string
  /** Token usage for this LLM call. Only present on assistant messages loaded from history. */
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  reasoning_text?: string | null
  /** Chain-of-thought reasoning from thinking models (e.g. DeepSeek). */
  reasoning_content?: string | null
  /** Provider-only continuation data, never a chat-completions message field. */
  provider_state?: ResponsesProviderState
  /** Timestamp from session log. Only present on messages loaded from history. */
  timestamp?: string
}

export interface LLMProviderOptions {
  model: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** DeepSeek thinking mode toggle */
  thinking?: ThinkingConfig
  /** DeepSeek reasoning effort level */
  reasoningEffort?: ReasoningEffort
}

/**
 * Metadata describing a single model exposed by a provider. Used to populate
 * the model selector in the web UI (vision support, context window, …).
 */
export interface ModelInfo {
  /** Model identifier (may be suffixed with `@provider` by the aggregator). */
  id: string
  /** Human-friendly display name, if the provider supplies one. */
  name?: string
  /** False hides a model from pickers without discarding its routing capabilities. */
  selectable?: boolean
  /** Whether the model accepts image input. */
  vision?: boolean
  /** Maximum context window in tokens, if known. */
  contextWindow?: number
  /** Explicit API paths advertised by the provider; absent for legacy metadata. */
  supportedEndpoints?: string[]
  reasoningEfforts?: string[]
}

/**
 * Abstract LLM provider. Each vendor gets a dedicated implementation.
 */
export interface LLMProvider {
  readonly name: string

  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse>

  /**
   * Return the list of model IDs this provider supports.
   * Used by the debug API to populate model selectors in the observer UI.
   */
  listModels(): string[] | Promise<string[]>

  /**
   * Optionally return richer metadata (vision, context window, …) for each
   * supported model. Providers that don't implement this fall back to
   * {@link listModels}.
   */
  listModelInfos?(): Promise<ModelInfo[]>
}

// ---------------------------------------------------------------------------
//  Utility
// ---------------------------------------------------------------------------

/**
 * Thrown when the LLM provider rejects the request because the prompt exceeds
 * its token limit (e.g. Copilot's `model_max_prompt_tokens_exceeded`).
 * Catching this allows the agent loop to trigger a forced handoff and retry.
 */
export class TokenLimitExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenLimitExceededError'
  }
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

/**
 * Extract a plain text string from a message's `content` field, regardless of
 * whether it is a plain string, an array of `ContentPart`s, or `null`.
 * Text parts are joined; image parts are represented as `[image]`.
 */
export function contentText(
  content: string | ContentPart[] | null | undefined,
): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' ? p.text : '[image]'))
    .join('')
}
