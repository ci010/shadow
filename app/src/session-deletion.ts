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
    const fallback = `Deletion was not confirmed (${response.status}). Check Main and refresh the conversation list before retrying.`
    let failure: unknown
    try { failure = await response.json() }
    catch { throw new Error(fallback) }
    if (isRecord(failure) && typeof failure.message === 'string' && failure.message.trim()) {
      throw new Error(`Could not delete this conversation. ${failure.message.trim()}`)
    }
    throw new Error(fallback)
  }
  const result: unknown = await response.json().catch(() => {
    throw new Error('Main returned an invalid deletion confirmation. Refresh the conversation list before retrying.')
  })
  if (!isRecord(result) || !Array.isArray(result.deleted)
    || !result.deleted.every((id): id is string => typeof id === 'string' && !!id)
    || !result.deleted.includes(target.sessionId)) {
    throw new Error('Main did not confirm which conversations were deleted. Refresh the conversation list before retrying.')
  }
  return [...new Set(result.deleted)]
}
