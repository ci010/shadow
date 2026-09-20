import { z } from 'zod'

export const WEB_SEARCH_PROVIDERS = ['firecrawl', 'brave', 'exa', 'tavily'] as const
export type WebSearchProvider = typeof WEB_SEARCH_PROVIDERS[number]
export const WebSearchSelectionSchema = z.enum(['auto', ...WEB_SEARCH_PROVIDERS])
export type WebSearchSelection = z.infer<typeof WebSearchSelectionSchema>
export const WEB_SEARCH_KEY_FIELDS = ['firecrawlApiKey', 'braveApiKey', 'exaApiKey', 'tavilyApiKey'] as const
export const WEB_SEARCH_FIELDS = ['webSearchProvider', ...WEB_SEARCH_KEY_FIELDS] as const
export const WEB_SEARCH_KEYS = {
  firecrawl: 'firecrawlApiKey', brave: 'braveApiKey', exa: 'exaApiKey', tavily: 'tavilyApiKey',
} as const

export type WebSearchConfig = {
  webSearchProvider?: WebSearchSelection
} & Partial<Record<typeof WEB_SEARCH_KEY_FIELDS[number], string>>

export function resolveWebSearchProvider(config: WebSearchConfig): WebSearchProvider {
  if (config.webSearchProvider && config.webSearchProvider !== 'auto') return config.webSearchProvider
  return WEB_SEARCH_PROVIDERS.find(provider => !!config[WEB_SEARCH_KEYS[provider]]?.trim()) ?? 'firecrawl'
}

const apiKey = z.string().trim().min(1).max(4096)
export const WebSearchPatchSchema = z.object({
  provider: WebSearchSelectionSchema.optional(),
  apiKeys: z.object({
    firecrawl: apiKey.nullable().optional(),
    brave: apiKey.nullable().optional(),
    exa: apiKey.nullable().optional(),
    tavily: apiKey.nullable().optional(),
  }).strict().optional(),
}).strict()
export type WebSearchPatch = z.infer<typeof WebSearchPatchSchema>

export interface WebSearchStatus {
  provider: WebSearchSelection
  effectiveProvider: WebSearchProvider
  ready: boolean
  keys: Record<WebSearchProvider, boolean>
}

export function webSearchStatus(config: WebSearchConfig): WebSearchStatus {
  const effectiveProvider = resolveWebSearchProvider(config)
  const keys = {
    firecrawl: !!config.firecrawlApiKey?.trim(),
    brave: !!config.braveApiKey?.trim(),
    exa: !!config.exaApiKey?.trim(),
    tavily: !!config.tavilyApiKey?.trim(),
  }
  return {
    provider: config.webSearchProvider ?? 'auto', effectiveProvider,
    ready: effectiveProvider === 'firecrawl' || keys[effectiveProvider], keys,
  }
}

export function withoutWebSearchConfig(tools: Record<string, unknown>): Record<string, unknown> {
  const owned = { ...tools }
  for (const field of WEB_SEARCH_FIELDS) delete owned[field]
  return owned
}

export function sharedWebSearchConfig(tools: WebSearchConfig): WebSearchConfig {
  return Object.fromEntries(WEB_SEARCH_FIELDS
    .filter(field => tools[field] !== undefined)
    .map(field => [field, tools[field]]))
}
