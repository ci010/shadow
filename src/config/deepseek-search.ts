import type { Config } from './schema.ts'
import { providerType, resolveProviderSettings } from '../providers/factory.ts'

export type SearchProviders = Config['providers']

/** Only official endpoints opt into the official Search API. Never export custom-endpoint credentials. */
export function resolveDeepSeekSearch(providers: SearchProviders = {}): { providerId: string; apiKey: string } | undefined {
  const config = { providers }
  // Prefer the canonical instance, then stable code-point order, independent of model and insertion order.
  const ids = Object.keys(providers).sort((a, b) => a === b ? 0 : a === 'deepseek' ? -1 : b === 'deepseek' ? 1 : a < b ? -1 : 1)
  for (const id of ids) {
    if (providerType(config, id) !== 'deepseek') continue
    const { apiKey, baseUrl } = resolveProviderSettings(config, id)
    if (!apiKey.trim() || !baseUrl) continue
    try {
      const url = new URL(baseUrl)
      if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash
        || !['', '/v1'].includes(url.pathname.replace(/\/+$/, ''))) continue
      return { providerId: id, apiKey: apiKey.trim() }
    } catch { /* Invalid or custom endpoint: unavailable, never reroute its credentials. */ }
  }
  return undefined
}
