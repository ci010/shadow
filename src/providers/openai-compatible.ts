import type { ToolDefinition } from '../tools/tool.ts'
import { isGptModel, type ReasoningEffort, type ThinkingConfig } from '../agent/llm-config.ts'
import { spanAttributes } from '../utils/otel.ts'
import type {
  ChatMessage,
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  ToolCall,
} from './provider.ts'
import { ProviderHttpError, TokenLimitExceededError } from './provider.ts'

// ---------------------------------------------------------------------------
//  Outbound message sanitization
// ---------------------------------------------------------------------------

/**
 * Strip fields that must never be echoed back to the provider.
 *
 * - `reasoning_text` / `reasoning` are *display-only* narration (Copilot,
 *   OpenAI o-series). Some providers reject them; all of them ignore them
 *   and they only inflate the prompt.
 * - `reasoning_content` (DeepSeek) is intentionally preserved \u2014 DeepSeek
 *   requires it on the next turn to maintain thinking-mode continuity.
 * - `usage` and `timestamp` are local bookkeeping; not part of the API.
 */
function sanitizeOutboundMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    // deno-lint-ignore no-explicit-any
    const { reasoning_text: _rt, provider_state: _ps, usage: _u, timestamp: _ts, ...rest } = msg as any
    return rest
  })
}

// ---------------------------------------------------------------------------
//  Shared fetch-based chat completion for any OpenAI-compatible API
// ---------------------------------------------------------------------------

/**
 * Perform a chat completion request against an OpenAI-compatible endpoint.
 *
 * This single function replaces the per-provider OpenAI SDK wrappers and is
 * reused by both `OpenAICompatibleProvider` and `CopilotProvider`.
 */
export async function openaiChat(params: {
  url: string
  apiKey: string
  headers?: Record<string, string>
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  providerName?: string
  signal?: AbortSignal
  thinking?: ThinkingConfig
  reasoningEffort?: ReasoningEffort
}): Promise<LLMResponse> {
  spanAttributes({
    'llm.provider': params.providerName ?? 'unknown',
    'llm.model': params.model,
    'llm.input_messages': params.messages.length,
    'llm.input_tools': params.tools.length,
  })

  const body: Record<string, unknown> = {
    model: params.model,
    messages: sanitizeOutboundMessages(params.messages),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  }

  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens
  }

  if (params.tools.length > 0) {
    body.tools = params.tools
  }

  const thinkingDisabled = params.thinking?.type === 'disabled'
  const gpt = isGptModel(params.model)
  const openaiThinkingDisabled = thinkingDisabled &&
    (gpt || params.providerName === 'openai' || params.providerName === 'copilot')
  if (params.thinking && !gpt && !openaiThinkingDisabled) {
    body.thinking = params.thinking
  }
  // Native OpenAI uses effort for opt-out; other compatible APIs retain their thinking switch.
  if (openaiThinkingDisabled) {
    body.reasoning_effort = 'none'
  } else if (params.reasoningEffort && !thinkingDisabled) {
    body.reasoning_effort = params.reasoningEffort
  }

  console.debug(`Calling LLM`)

  // Retry up to 5 extra times for transient network errors (TLS, connection reset, etc.)
  const MAX_RETRIES = 5
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * attempt
      console.warn(
        `LLM fetch attempt ${attempt + 1} after ${delay}ms (${
          lastErr instanceof Error ? lastErr.message : lastErr
        })`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
    try {
      const res = await fetch(params.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${params.apiKey}`,
          ...params.headers,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        let code: string | undefined
        // Detect token-limit errors so the agent loop can trigger a forced handoff
        try {
          const errJson = JSON.parse(text)
          if (typeof errJson?.error?.code === 'string') code = errJson.error.code
          if (errJson?.error?.code === 'model_max_prompt_tokens_exceeded') {
            throw new TokenLimitExceededError(
              `${
                params.providerName ?? 'LLM'
              } chat failed: ${res.status} ${text}`,
            )
          }
        } catch (e) {
          if (e instanceof TokenLimitExceededError) throw e
        }
        throw new ProviderHttpError(res.status,
          `${params.providerName ?? 'LLM'} chat failed: ${res.status} ${text}`,
          code,
        )
      }

      // deno-lint-ignore no-explicit-any
      const json = (await res.json()) as any

      const contentParts: string[] = []
      const allToolCalls: ToolCall[] = []
      let reasoningContent: string | null = null
      let reasoningText: string | null = null

      for (const choice of json.choices ?? []) {
        if (choice.message?.content) {
          contentParts.push(choice.message.content)
        }
        // Round-trippable reasoning (DeepSeek/OpenRouter)
        const msg = choice.message ?? {}
        if (msg.reasoning_content) {
          reasoningContent = msg.reasoning_content
        }
        // Display-only reasoning narration (Copilot `reasoning_text`,
        // OpenAI o-series `reasoning`). Must NOT be echoed back to the
        // provider — we drop it before the next request.
        const text = msg.reasoning_text ??
          (typeof msg.reasoning === 'string' ? msg.reasoning : null)
        if (text) {
          reasoningText = text
        }
        if (choice.message?.tool_calls) {
          // deno-lint-ignore no-explicit-any
          for (const tc of choice.message.tool_calls as any[]) {
            allToolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}'),
            })
          }
        }
      }

      return {
        content: contentParts.length > 0 ? contentParts.join('\n') : null,
        reasoningContent,
        reasoningText,
        toolCalls: allToolCalls,
        model: json.model ?? params.model,
        usage: json.usage
          ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
          : undefined,
      }
    } catch (err) {
      lastErr = err
      // Non-network errors (e.g. JSON parse, API 4xx) — don't retry
      if (!(err instanceof TypeError)) throw err
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
//  Generic provider for any OpenAI-compatible API
// ---------------------------------------------------------------------------

/**
 * A single provider class that handles OpenAI, DeepSeek, Gemini, Groq,
 * OpenRouter, and any other OpenAI-compatible endpoint. No SDK needed.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string
  private _modelsCache: string[] | null = null
  private _modelsCacheTime = 0

  constructor(
    name: string,
    protected apiKey: string,
    protected baseURL: string,
    protected defaultModel: string,
  ) {
    this.name = name
  }

  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    const base = this.baseURL.replace(/\/+$/, '')
    return openaiChat({
      url: `${base}/chat/completions`,
      apiKey: this.apiKey,
      model: options.model,
      messages,
      tools,
      maxTokens: options.maxTokens,
      temperature: options.temperature ?? 0.7,
      providerName: this.name,
      signal: options.signal,
      thinking: options.thinking,
      reasoningEffort: options.reasoningEffort,
    })
  }

  async listModels(): Promise<string[]> {
    const CACHE_TTL = 5 * 60_000 // 5 minutes
    if (this._modelsCache && Date.now() - this._modelsCacheTime < CACHE_TTL) {
      return this._modelsCache
    }
    try {
      const base = this.baseURL.replace(/\/+$/, '')
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      })
      if (!res.ok) {
        console.warn(
          `[${this.name}] /v1/models returned ${res.status}, falling back to default`,
        )
        return [this.defaultModel]
      }
      // deno-lint-ignore no-explicit-any
      const json = (await res.json()) as any
      const data: { id: string }[] = json.data ?? []
      const ids = data.map((m) => m.id).sort()
      if (ids.length === 0) return [this.defaultModel]
      this._modelsCache = ids
      this._modelsCacheTime = Date.now()
      return ids
    } catch (err) {
      console.warn(
        `[${this.name}] Failed to fetch /v1/models: ${
          err instanceof Error ? err.message : err
        }`,
      )
      return [this.defaultModel]
    }
  }
}
