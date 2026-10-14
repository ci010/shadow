import { apiUrl } from './api-url.ts'

/** Profile reads retain the owning Project prefix, including bases ending in '/'. */
export function automationProfileUrl(base: string, featureId: string): URL {
  return apiUrl(base, `/api/automations/${encodeURIComponent(featureId)}/profile`)
}

export function sessionProfileUrl(base: string, sessionId: string): URL {
  return apiUrl(base, `/api/sessions/${encodeURIComponent(sessionId)}/profile`)
}
