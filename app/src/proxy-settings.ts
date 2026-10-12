import { apiUrl, hostBase } from './api-url.ts'
import { t } from './i18n.ts'
export interface ProxyStatus {
  enabled: boolean; detected: boolean; detectionFailed: boolean
  source: 'direct' | 'environment' | 'windows-static' | 'windows-auto' | 'unknown'
  http: string; https: string
}
export function parseProxyStatus(value: unknown): ProxyStatus {
  const v = value as Partial<ProxyStatus> | null
  const safeAddress = (address: unknown) => {
    if (address === '') return true
    if (typeof address !== 'string') return false
    try { const url = new URL(address); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash } catch { return false }
  }
  if (!v || typeof v.enabled !== 'boolean' || typeof v.detected !== 'boolean' || typeof v.detectionFailed !== 'boolean'
    || !['direct', 'environment', 'windows-static', 'windows-auto', 'unknown'].includes(v.source ?? '')
    || !safeAddress(v.http) || !safeAddress(v.https)) throw new Error(t('Main returned invalid proxy settings.'))
  return { enabled: v.enabled, detected: v.detected, detectionFailed: v.detectionFailed, source: v.source!, http: v.http!, https: v.https! }
}
export function createProxySettingsClient(base: string, request: typeof fetch = fetch) {
  async function load(enabled?: boolean, detect = false): Promise<ProxyStatus> {
    try {
      const response = await request(apiUrl(hostBase(base), detect ? '/api/app/proxy/detect' : '/api/app/proxy'), {
        method: detect ? 'POST' : enabled === undefined ? 'GET' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error('request_failed')
      return parseProxyStatus(await response.json())
    } catch { throw new Error(t('Could not load or save proxy settings. Check your Main administrator connection and proxy configuration, then retry.')) }
  }
  return { load: () => load(), detect: () => load(undefined, true), save: (enabled: boolean) => load(enabled) }
}
