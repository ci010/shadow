import { apiUrl } from './api-url.ts'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function fetchDiagnosisExport(
  apiBase: string, sessionId: string, physicalId: string | null, signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const url = apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/diagnosis`)
  url.searchParams.set('view', 'full')
  url.searchParams.set('recordLimit', '500')
  if (physicalId) url.searchParams.set('physicalId', physicalId)
  signal.throwIfAborted()
  const response = await request(url, { signal })
  if (!response.ok) throw new Error(`Diagnosis export failed (HTTP ${response.status}).${response.status === 404 ? ' Restart Shadow after updating the backend, or check the selected session.' : ''}`)
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Diagnosis export is unavailable on this backend. Restart Shadow after updating.')
  }
  const value: unknown = await response.json()
  signal.throwIfAborted()
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'shadow-session-diagnosis'
    || !object(value.session) || value.session.sessionId !== sessionId
    || typeof value.session.physicalId !== 'string'
    || (physicalId !== null && value.session.physicalId !== physicalId)
    || !object(value.history) || !Array.isArray(value.history.records) || typeof value.history.hasMore !== 'boolean'
    || !object(value.trace) || typeof value.trace.hasMore !== 'boolean'
    || !object(value.privacy) || !Array.isArray(value.privacy.truncatedPaths)
    || value.privacy.reviewRequiredBeforeSharing !== true) {
    throw new Error('Invalid diagnosis export response.')
  }
  return {
    filename: `diagnosis-${value.session.physicalId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
    json: JSON.stringify(value, null, 2) + '\n',
    partial: value.history.hasMore || value.trace.hasMore || value.privacy.truncatedPaths.length > 0,
  }
}
