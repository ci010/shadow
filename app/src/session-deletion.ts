import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export interface SessionDeletionTarget {
  apiBase: string
  sessionId: string
  name: string
  projectName?: string
}

export async function deleteConversation(
  target: SessionDeletionTarget, signal: AbortSignal, request: typeof fetch = fetch,
): Promise<string[]> {
  const response = await request(apiUrl(target.apiBase, `/api/sessions/${encodeURIComponent(target.sessionId)}`), {
    method: 'DELETE', signal,
  })
  if (!response.ok) {
    const fallback = t('Deletion was not confirmed ({status}). Check Main and refresh the conversation list before retrying.', { status: response.status })
    let failure: unknown
    try { failure = await response.json() }
    catch { throw new Error(fallback) }
    if (isRecord(failure) && typeof failure.message === 'string' && failure.message.trim()) {
      throw new Error(t('Could not delete this conversation. {value1}', { value1: failure.message.trim() }))
    }
    throw new Error(fallback)
  }
  const result: unknown = await response.json().catch(() => {
    throw new Error(t('Main returned an invalid deletion confirmation. Refresh the conversation list before retrying.'))
  })
  if (!isRecord(result) || !Array.isArray(result.deleted)
    || !result.deleted.every((id): id is string => typeof id === 'string' && !!id)
    || !result.deleted.includes(target.sessionId)) {
    throw new Error(t('Main did not confirm which conversations were deleted. Refresh the conversation list before retrying.'))
  }
  return [...new Set(result.deleted)]
}
