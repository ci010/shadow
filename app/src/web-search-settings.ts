import { t } from './i18n.ts'
import { apiUrl, hostBase } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'
import type { WebSearchPatch, WebSearchProvider, WebSearchSelection, WebSearchStatus } from '../../src/config/web-search.ts'

export type { WebSearchPatch, WebSearchProvider, WebSearchSelection, WebSearchStatus }
export const searchProviders: Array<{ id: WebSearchProvider; label: string }> = [
  { id: 'firecrawl', label: 'Firecrawl' },
  { id: 'brave', label: 'Brave' },
  { id: 'exa', label: 'Exa' },
  { id: 'tavily', label: 'Tavily' },
]
export const searchProviderLabel = (id: WebSearchProvider) => searchProviders.find(provider => provider.id === id)!.label
const isProvider = (value: unknown): value is WebSearchProvider => searchProviders.some(provider => provider.id === value)
export const isSearchSelection = (value: unknown): value is WebSearchSelection => value === 'auto' || isProvider(value)

export function parseWebSearchStatus(value: unknown): WebSearchStatus {
  if (!isRecord(value) || !isSearchSelection(value.provider) || !isProvider(value.effectiveProvider)
    || typeof value.ready !== 'boolean' || !isRecord(value.keys)) {
    throw new Error(t('Main returned invalid web search settings. Reload settings and retry.'))
  }
  const keys = value.keys
  if (Object.keys(keys).length !== searchProviders.length || searchProviders.some(provider => typeof keys[provider.id] !== 'boolean')
    || Object.keys(value).some(key => !['provider', 'effectiveProvider', 'ready', 'keys'].includes(key))) {
    throw new Error(t('Main returned invalid web search settings. Reload settings and retry.'))
  }
  const configured = { firecrawl: keys.firecrawl as boolean, brave: keys.brave as boolean, exa: keys.exa as boolean, tavily: keys.tavily as boolean }
  const effective = value.provider === 'auto'
    ? searchProviders.find(provider => configured[provider.id])?.id ?? 'firecrawl'
    : value.provider
  if (value.effectiveProvider !== effective || value.ready !== (effective === 'firecrawl' || configured[effective])) {
    throw new Error(t('Main returned inconsistent web search settings. Reload settings and retry.'))
  }
  return { provider: value.provider, effectiveProvider: effective, ready: value.ready, keys: configured }
}

export type SearchKeyDraft = Record<WebSearchProvider, { value: string; remove: boolean }>
export function emptySearchKeys(): SearchKeyDraft {
  return { firecrawl: { value: '', remove: false }, brave: { value: '', remove: false }, exa: { value: '', remove: false }, tavily: { value: '', remove: false } }
}

export function webSearchPatch(state: WebSearchStatus, provider: WebSearchSelection, keys: SearchKeyDraft): WebSearchPatch {
  const apiKeys: NonNullable<WebSearchPatch['apiKeys']> = {}
  for (const { id } of searchProviders) {
    if (keys[id].remove) apiKeys[id] = null
    else if (keys[id].value.trim()) apiKeys[id] = keys[id].value.trim()
  }
  return {
    ...(provider === state.provider ? {} : { provider }),
    ...(Object.keys(apiKeys).length ? { apiKeys } : {}),
  }
}

export function createWebSearchSettingsClient(base: string, request: typeof fetch = fetch) {
  const url = apiUrl(hostBase(base), '/api/app/web-search')
  async function json(init: RequestInit): Promise<WebSearchStatus> {
    let response: Response
    try {
      response = await request(url, {
        ...init, headers: { 'Content-Type': 'application/json' },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error(t('Could not reach Main. Check the connection and reload settings before retrying.'))
    }
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403 ? t('Web search settings require a Main administrator.')
        : response.status === 400 ? t('Check the search service and API keys, then retry.')
        : t('Could not save or load web search settings. Reload settings before retrying.'))
    }
    let value: unknown
    try { value = await response.json() }
    catch { throw new Error(t('Main returned invalid web search settings. Reload settings and retry.')) }
    return parseWebSearchStatus(value)
  }
  return {
    load: (signal?: AbortSignal) => json({ signal }),
    save: (patch: WebSearchPatch, signal?: AbortSignal) => json({ method: 'PATCH', body: JSON.stringify(patch), signal }),
  }
}
