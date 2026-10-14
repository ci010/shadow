import type { ToolDefinition } from '../tools/tool.ts'
import { env } from 'node:process'
import { OpenAICompatibleProvider, openaiChat } from './openai-compatible.ts'
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

/** DeepSeek Chat Completions with thinking continuity and Flash image input. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    defaultModel: string = 'deepseek-flash',
    options: { apiKey?: string; baseUrl?: string } = {},
  ) {
    super('deepseek', options.apiKey ?? env.DEEPSEEK_API_KEY ?? '', options.baseUrl ?? 'https://api.deepseek.com', defaultModel)
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
      supportedEndpoints: ['/chat/completions'],
      reasoningEfforts: ['low', 'high', 'max'],
    }))
  }
}
