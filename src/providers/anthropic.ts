import { httpFailure } from './http-failure.ts'
import { withProviderRetry, providerRetryScope } from './retry.ts'
import { providerTransportFailure } from './provider.ts'
import type {
  ChatMessage,
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  ToolCall,
} from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { env } from 'node:process'

const ANTHROPIC_VERSION = '2023-06-01'

function imageContent(content: ChatMessage['content']) {
  if (!Array.isArray(content)) return content ?? ''
  return content.map(part => {
    if (part.type === 'text') return part
    const url = part.image_url.url
    const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(url)
    if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
    if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } }
    throw new Error('Anthropic image input requires PNG, JPEG, GIF or WebP data or an HTTP(S) URL.')
  })
}

// ---------------------------------------------------------------------------
//  Message / tool conversion (OpenAI → Anthropic shapes)
// ---------------------------------------------------------------------------

function convertMessages(
  messages: ChatMessage[],
): { system: string; converted: any[] } {
  let system = ''
  const converted: any[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + (msg.content ?? '')
      continue
    }
    if (msg.role === 'user') {
      converted.push({ role: 'user', content: imageContent(msg.content) })
      continue
    }
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: any[] = []
        if (msg.content) content.push({ type: 'text', text: msg.content })
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
        converted.push({ role: 'assistant', content })
      } else {
        converted.push({ role: 'assistant', content: msg.content ?? '' })
      }
      continue
    }
    if (msg.role === 'tool') {
      const block = {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id!,
            content: imageContent(msg.content),
      }
      const previous = converted.at(-1)
      if (previous?.role === 'user' && Array.isArray(previous.content) &&
        previous.content.every((part: { type: string }) => part.type === 'tool_result')) {
        previous.content.push(block)
      } else converted.push({ role: 'user', content: [block] })
    }
  }

  return { system, converted }
}

function convertTools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  private apiKey: string
  private baseUrl: string

  constructor(opts: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY ?? ''
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com/v1'
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    const model = options.model
    const { system, converted } = convertMessages(messages)

    console.debug(
      `Calling Anthropic: model=${model}, msgs=${converted.length}, tools=${tools.length}`,
    )

    const body: Record<string, any> = {
      model,
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.temperature ?? 0.7,
      messages: converted,
    }

    if (system) body.system = system
    if (tools.length > 0) body.tools = convertTools(tools)

    return withProviderRetry(async () => {
      let phase: 'connect' | 'response' = 'connect'
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })

        phase = 'response'
        if (!res.ok) throw await httpFailure(res, this.name, model, options.signal)

        const json = (await res.json()) as any

        let content: string | null = null
        const toolCalls: ToolCall[] = []

        for (const block of json.content ?? []) {
          if (block.type === 'text') {
            content = (content ?? '') + block.text
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            })
          }
        }

        return {
          content,
          toolCalls,
          model: json.model ?? model,
          usage: json.usage
            ? {
              promptTokens: json.usage.input_tokens + (json.usage.cache_read_input_tokens ?? 0) + (json.usage.cache_creation_input_tokens ?? 0),
              completionTokens: json.usage.output_tokens,
              totalTokens: json.usage.input_tokens + (json.usage.cache_read_input_tokens ?? 0) + (json.usage.cache_creation_input_tokens ?? 0) + json.usage.output_tokens,
              ...(json.usage.cache_read_input_tokens != null ? { cachedTokens: json.usage.cache_read_input_tokens } : {}),
            }
            : undefined,
        }
      } catch (error) {
        throw providerTransportFailure(error, phase, options.signal)
      }
    }, options.signal, { scope: providerRetryScope(this.baseUrl, this.apiKey), provider: this.name, model })
  }

  listModels(): string[] {
    return [
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-20250514',
      'claude-haiku-3-5-20241022',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ]
  }
}
