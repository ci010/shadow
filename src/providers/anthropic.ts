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

// ---------------------------------------------------------------------------
//  Message / tool conversion (OpenAI → Anthropic shapes)
// ---------------------------------------------------------------------------

function convertMessages(
  messages: ChatMessage[],
): { system: string; converted: any[] } {
  let system = ''
  // deno-lint-ignore no-explicit-any
  const converted: any[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + (msg.content ?? '')
      continue
    }
    if (msg.role === 'user') {
      converted.push({ role: 'user', content: msg.content ?? '' })
      continue
    }
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // deno-lint-ignore no-explicit-any
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
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id!,
            content: msg.content ?? '',
          },
        ],
      })
    }
  }

  return { system, converted }
}

// deno-lint-ignore no-explicit-any
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

    // deno-lint-ignore no-explicit-any
    const body: Record<string, any> = {
      model,
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.temperature ?? 0.7,
      messages: converted,
    }

    if (system) body.system = system
    if (tools.length > 0) body.tools = convertTools(tools)

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

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Anthropic chat failed: ${res.status} ${text}`)
    }

    // deno-lint-ignore no-explicit-any
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
          promptTokens: json.usage.input_tokens,
          completionTokens: json.usage.output_tokens,
          totalTokens: json.usage.input_tokens + json.usage.output_tokens,
        }
        : undefined,
    }
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
