import { OpenAICompatibleProvider } from './openai-compatible.ts'

const CACHE_TTL = 5 * 60_000

export class OpenRouterProvider extends OpenAICompatibleProvider {
  private models: string[] = []
  private refreshAfter = 0
  private pending?: Promise<string[]>

  override async listModels(): Promise<string[]> {
    if (this.pending) return this.pending
    if (Date.now() < this.refreshAfter) return this.models
    this.pending = this.refreshModels()
    try { return await this.pending }
    finally { this.pending = undefined }
  }

  private async refreshModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseURL.replace(/\/+$/, '')}/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Model catalog unavailable')
      }
      const payload: { data?: unknown } | null = await response.json()
      if (!Array.isArray(payload?.data)) throw new Error('Invalid model catalog')
      const ids = new Set<string>()
      for (const row of payload.data) {
        const id: unknown = row?.id
        // The aggregate appends its own @instance suffix. Keep OpenRouter's :variant suffixes.
        if (typeof id === 'string' && id.length <= 256 && /^[^/@\s\x00-\x1f]+\/[^/@\s\x00-\x1f]+$/.test(id)) ids.add(id)
      }
      if (!ids.size) throw new Error('Empty model catalog')
      this.models = [...ids].sort()
      this.refreshAfter = Date.now() + CACHE_TTL
    } catch {
      // Do not leak upstream details or invent a model from another provider's default.
      this.refreshAfter = Date.now() + 15_000
    }
    return this.models
  }
}
