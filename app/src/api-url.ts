/** Resolve an API suffix without discarding the owning organization's base path. */
export function apiUrl(base: string, suffix: string, params?: Record<string, string>): URL {
  if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('\\')) {
    throw new Error('API paths must be absolute suffixes, not external URLs.')
  }
  const root = new URL(base)
  root.search = ''
  root.hash = ''
  root.pathname = `${root.pathname.replace(/\/+$/, '')}/`
  const result = new URL(suffix.slice(1), root)
  if (result.origin !== root.origin || !result.pathname.startsWith(root.pathname)) {
    throw new Error('API path escaped its resource scope.')
  }
  for (const [key, value] of Object.entries(params ?? {})) result.searchParams.set(key, value)
  return result
}

export function organizationBase(hostBase: string, organizationId: string): string {
  if (!organizationId.trim() || organizationId === '.' || organizationId === '..') throw new Error('Organization ID is required.')
  return apiUrl(hostBase, `/organizations/${encodeURIComponent(organizationId)}/`).toString()
}

/** Nodes and provider credentials are host resources even when called inside a chat. */
export function hostBase(base: string): string {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/organizations\/[^/]+\/?$/, '/')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export interface SessionRef {
  organizationId: string
  sessionId: string
}

export function sessionKey(ref: SessionRef): string {
  return JSON.stringify([ref.organizationId, ref.sessionId])
}
