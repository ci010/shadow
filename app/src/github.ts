import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'

export async function githubRequest(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(apiUrl(base, `/api/github${path}`), {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
    ? value.message : t('GitHub integration request failed (HTTP {status}). Check access and retry.', { status: response.status }))
  return value
}
