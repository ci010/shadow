import type { ToolDefinition } from '../tools/tool.ts'
import { env } from 'node:process'
import { OpenAICompatibleProvider } from './openai-compatible.ts'
import type {
  ChatMessage,
  LLMProviderOptions,
  LLMResponse
} from './provider.ts'

// ---------------------------------------------------------------------------
//  Generic provider for any OpenAI-compatible API
// ---------------------------------------------------------------------------

/**
 * A single provider class that handles OpenAI, DeepSeek, Gemini, Groq,
 * OpenRouter, and any other OpenAI-compatible endpoint. No SDK needed.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    defaultModel: string = 'deepseek-v4-flash'
  ) {
    super('deepseek', env.DEEPSEEK_API_KEY!, 'https://api.deepseek.com', defaultModel)
  }

  override async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    if (tools.length > 0) {
      messages = messages.map((e) => e.role === 'assistant' ? ({
        role: e.role,
        content: e.content,
        reasoning_content: e.reasoning_content ?? '',
        tool_call_id: e.tool_call_id,
        tool_calls: e.tool_calls && e.tool_calls.length > 0 ? e.tool_calls : undefined,
      }) : e)
    }
    const result = await super.chat(messages, tools, options)
    if (tools.length > 0 && !result.reasoningContent) {
      result.reasoningContent = ''
    }
    return result
  }

  override listModels(): Promise<string[]> {
    return Promise.resolve(['deepseek-v4-flash', 'deepseek-v4-pro'])
  }
}
