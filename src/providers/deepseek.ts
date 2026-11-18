import { estimateUsageCost } from './cost.ts'
import type { ToolDefinition } from '../tools/tool.ts'
import { env } from 'node:process'
import { OpenAICompatibleProvider, openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { ProviderHttpError } from './provider.ts'
import { chatCompletionImages } from './tool-images.ts'
import type {
  ChatMessage,
  LLMProviderOptions,
  LLMResponse,
  ModelInfo,
} from './provider.ts'

const MODELS = ['deepseek-flash', 'deepseek-v4-pro']
const VISION_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])

function imageMessages(messages: ChatMessage[], model: string): ChatMessage[] {
  for (const message of messages) {
    const images = Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []
    if (!images.length) continue
    if (!VISION_MODELS.has(model)) throw new Error(`[deepseek] Model "${model}" does not support images. Select deepseek-flash.`)
    if (message.role !== 'user' && message.role !== 'tool') {
      throw new Error('[deepseek] Images are only supported in user messages or tool results.')
    }
    for (const image of images) {
      const url = image.image_url.url
      if (/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(url)) continue
      if (url.length <= 8192 && URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)) continue
      throw new Error('[deepseek] Images must be JPEG, PNG, GIF or WebP data URLs, or public HTTP(S) URLs up to 8192 characters.')
    }
  }
  return chatCompletionImages(messages)
}

const RESPONSES_URL = 'https://api.deepseek.com/responses'

/** Official V4 Pro uses Responses; Flash and custom endpoints keep Chat Completions. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    defaultModel: string = 'deepseek-flash',
    options: { apiKey?: string; baseUrl?: string } = {},
  ) {
    super('deepseek', options.apiKey ?? env.DEEPSEEK_API_KEY ?? '', options.baseUrl ?? 'https://api.deepseek.com', defaultModel)
  }

  private usesResponses(model: string): boolean {
    return model === 'deepseek-v4-pro' && /^https:\/\/api\.deepseek\.com(?:\/v1)?\/*$/.test(this.baseURL)
  }

  override async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: LLMProviderOptions,
  ): Promise<LLMResponse> {
    options.signal?.throwIfAborted()
    const reasoningEffort = options.reasoningEffort === 'medium' || options.reasoningEffort === 'xhigh'
      ? 'high' : options.reasoningEffort
    if (reasoningEffort !== undefined && !['low', 'high', 'max'].includes(reasoningEffort)) {
      throw new ProviderHttpError(400, '[deepseek] Reasoning effort must be low, high or max.', 'unsupported_reasoning_effort')
    }
    messages = imageMessages(messages, options.model)
    if (this.usesResponses(options.model)) {
      const result = await openaiResponses({
        ...options, url: RESPONSES_URL, apiKey: this.apiKey, providerName: this.name,
        messages, tools, reasoningEffort,
      })
      if (result.usage) result.usage = estimateUsageCost(this.name, result.model ?? options.model, result.usage)
      return result
    }
    if (tools.length > 0) {
      messages = messages.map((e) => e.role === 'assistant' ? ({
        role: e.role,
        content: e.content,
        reasoning_content: e.reasoning_content ?? '',
        tool_call_id: e.tool_call_id,
        tool_calls: e.tool_calls && e.tool_calls.length > 0 ? e.tool_calls : undefined,
      }) : e)
    }
    const thinkingEnabled = options.thinking?.type !== 'disabled'
    const result = await openaiChat({
      url: `${this.baseURL.replace(/\/+$/, '')}/chat/completions`,
      apiKey: this.apiKey, providerName: this.name,
      messages, tools, model: options.model,
      maxTokens: options.maxTokens,
      temperature: thinkingEnabled ? undefined : options.temperature ?? 0.7,
      thinking: options.thinking,
      reasoningEffort: thinkingEnabled ? reasoningEffort : undefined,
      signal: options.signal,
    })
    if (tools.length > 0 && !result.reasoningContent) {
      result.reasoningContent = ''
    }
    if (result.usage) result.usage = estimateUsageCost(new URL(this.baseURL).origin === 'https://api.deepseek.com' ? this.name : 'unknown', result.model ?? options.model, result.usage)
    return result
  }

  override listModels(): Promise<string[]> {
    return Promise.resolve([...MODELS])
  }

  async listModelInfos(): Promise<ModelInfo[]> {
    return MODELS.map(id => ({
      id,
      name: id === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : 'DeepSeek V4 Pro',
      vision: id === 'deepseek-flash',
      contextWindow: 1_000_000,
      supportedEndpoints: [this.usesResponses(id) ? '/responses' : '/chat/completions'],
      reasoningEfforts: ['low', 'high', 'max'],
    }))
  }
}
