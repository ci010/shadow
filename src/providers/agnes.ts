import { OpenAICompatibleProvider } from './openai-compatible.ts'
import type { ModelInfo } from './provider.ts'

/** Documented API IDs, not the 30/25 documentation URL slugs. */
const MODELS = ['agnes-3.0-flash', 'agnes-2.5-flash']

export class AgnesProvider extends OpenAICompatibleProvider {
  constructor(model: string, options: { apiKey: string; baseUrl?: string }) {
    super('agnes', options.apiKey, options.baseUrl ?? 'https://apihub.agnes-ai.com/v1', model)
  }

  override async listModels(): Promise<string[]> { return [...MODELS] }

  async listModelInfos(): Promise<ModelInfo[]> {
    return MODELS.map(id => ({
      id, name: id === MODELS[0] ? 'Agnes 3.0 Flash' : 'Agnes 2.5 Flash',
      vision: true, contextWindow: 512_000,
      // The 2.5 page only gives rounded 65.5K, not an exact token limit.
      ...(id === MODELS[0] ? { maxOutputTokens: 65_536 } : {}),
      supportedEndpoints: ['/chat/completions'],
    }))
  }
}
