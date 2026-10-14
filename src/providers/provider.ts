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
  /** Cache-read input tokens; absent when not reported. */
  cachedTokens?: number
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
  /** Local persisted display metadata, stripped before inference; never a provider wire field. */
  displayOnly?: boolean
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
  /** Local conversational display provenance; never sent as a provider message field. */
  responseContext?: import('../sessions/response-context.ts').ResponseContext
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
  /** Maximum generated output tokens, if documented by the provider. */
  maxOutputTokens?: number
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
  readonly retryAfter?: string | null
  readonly rejectedRequest: boolean
  constructor(readonly status: number, message: string, readonly code?: string,
    metadata?: { retryAfter?: string | null; rejectedRequest?: boolean }) {
    super(message)
    this.name = 'ProviderHttpError'
    this.retryAfter = metadata?.retryAfter
    // Only adapters observing a non-success HTTP response may authorize replay.
    this.rejectedRequest = metadata?.rejectedRequest === true
  }

}

/** Request-size rejections can be recovered by compacting session context.
 * Use structured provider errors, never response-body/message matching (413 may
 * be emitted by a proxy with an HTML or empty body).
 */
export function isContextSizeError(error: unknown): boolean {
  return error instanceof TokenLimitExceededError
    || error instanceof ProviderHttpError && error.status === 413
}

export const providerFailureKinds = ['authentication', 'network', 'proxy', 'rate-limit', 'unavailable', 'storage', 'request'] as const
export type ProviderFailureKind = typeof providerFailureKinds[number]

/** Public failure categories never carry response bodies, credentials or proxy addresses. */
export function providerFailureKind(error: unknown): ProviderFailureKind {
  let cause = error
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    const code = 'code' in cause ? cause.code : undefined
    if (code === 'SYSTEM_PROXY_UNAVAILABLE') return 'proxy'
    if (cause.name === 'CopilotAuthError') {
      if (code === 'proxy' || code === 'network' || code === 'storage') return code
      if (code === 'missing' || code === 'denied' || code === 'expired') return 'authentication'
    }
    if (cause instanceof ProviderHttpError) {
      if (cause.status === 401 || cause.status === 403) return 'authentication'
      if (cause.status === 429) return 'rate-limit'
      if (cause.status >= 500) return 'unavailable'
    }
    cause = cause.cause
  }
  if (error instanceof ProviderTransportError || error instanceof Error
    && (error.name === 'TimeoutError' || error instanceof TypeError && error.message === 'fetch failed')) return 'network'
  return 'request'
}

const transportCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])
const beforeConnectionCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])

export class ProviderTransportError extends Error {
  readonly mayHaveBeenProcessed: boolean
  constructor(readonly phase: 'connect' | 'response', readonly code?: string, cause?: unknown) {
    const uncertain = phase === 'response' || !code || !beforeConnectionCodes.has(code)
    super(`LLM ${phase === 'response' ? 'response interrupted before completion' : 'connection failed'}${code ? ` (${code})` : ''}. ` +
      (uncertain ? 'The request may have been processed or billed; it was not automatically replayed. ' : '') +
      'No incomplete tool calls were dispatched. Inspect existing work before explicitly continuing.', { cause })
    this.name = 'ProviderTransportError'
    this.mayHaveBeenProcessed = uncertain
  }
}

export function providerTransportFailure(error: unknown, phase: 'connect' | 'response', signal?: AbortSignal): unknown {
  signal?.throwIfAborted()
  if (error instanceof ProviderTransportError) return error
  let current = error
  for (let depth = 0; current instanceof Error && depth < 4; depth++, current = current.cause) {
    if ('code' in current && typeof current.code === 'string' && transportCodes.has(current.code)) {
      return new ProviderTransportError(phase, current.code, error)
    }
  }
  return error instanceof TypeError && /^(fetch failed|terminated)$/.test(error.message)
    ? new ProviderTransportError(phase, undefined, error) : error
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
