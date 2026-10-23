import { t } from './i18n.ts'
/** Resolve an API suffix without discarding the owning project's base path. */
export function apiUrl(base: string, suffix: string, params?: Record<string, string>): URL {
  if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('\\')) {
    throw new Error(t('API paths must be absolute suffixes, not external URLs.'))
  }
  const root = new URL(base)
  root.search = ''
  root.hash = ''
  root.pathname = `${root.pathname.replace(/\/+$/, '')}/`
  const result = new URL(suffix.slice(1), root)
  if (result.origin !== root.origin || !result.pathname.startsWith(root.pathname)) {
    throw new Error(t('API path escaped its resource scope.'))
  }
  for (const [key, value] of Object.entries(params ?? {})) result.searchParams.set(key, value)
  return result
}

export function projectBase(hostBase: string, projectId: string): string {
  if (!projectId.trim() || projectId === '.' || projectId === '..') throw new Error(t('Project ID is required.'))
  return apiUrl(hostBase, `/projects/${encodeURIComponent(projectId)}/`).toString()
}

/** Nodes and provider credentials are host resources even when called inside a chat. */
export function hostBase(base: string): string {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/projects\/[^/]+\/?$/, '/')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export interface SessionRef {
  projectId: string
  sessionId: string
}

export function sessionKey(ref: SessionRef): string {
  return JSON.stringify([ref.projectId, ref.sessionId])
}
