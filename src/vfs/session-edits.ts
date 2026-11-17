import type { SessionManager } from '../sessions/session-manager.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { navigationPage } from './knowledge.ts'

export async function sessionEdits(sessions: Pick<SessionManager, 'getHistory' | 'getSessionState'> &
  Partial<Pick<SessionManager, 'readSessionState' | 'getFileChanges'>>, path: string, context: ExecutionContext): Promise<string> {
  const { route, offset, limit } = navigationPage(path)
  const id = route.slice(0, -'/edits'.length)
  if (!id || id.includes('/') || !sessions.getFileChanges) throw new Error('Session edit index unavailable.')
  const state = await (sessions.readSessionState?.(id) ?? sessions.getSessionState(id))
  if (!state || state.projectId !== context.projectId) throw new Error('Unknown Project session.')
  // Use the same history access route before reading the ledger. No file paths are opened.
  await sessions.getHistory(id, { maxMessages: 1 })
  const page = await sessions.getFileChanges(id, offset, Math.min(limit, 30), context.signal)
  if (!page) throw new Error('Session edit index unavailable.')
  const references = new Map<string, string>()
  const needed = new Set(page.changes.map(change => change.toolCallId))
  for (let segment = 0; needed.size && segment <= state.segmentIndex; segment++) {
    context.signal.throwIfAborted()
    const physical = physicalSessionId(state, segment)
    const { messages } = await sessions.getHistory(id, { physicalId: physical, maxMessages: Number.MAX_SAFE_INTEGER })
    for (const message of messages) if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
      if (!needed.delete(call.id)) continue
      references.set(call.id, `v:sessions/${physical}/calls/${encodeURIComponent(call.id)}`)
    }
  }
  const size = Math.min(limit, 30)
  return JSON.stringify({ offset, limit: size, total: page.total,
    next: offset + size < page.total ? `v:sessions/${id}/edits?offset=${offset + size}&limit=${size}` : null,
    note: 'Recorded edits only; no current file reads. view_edit is restricted to the current session. Missing history references and timestamps are not inferred.',
    items: page.changes.map(change => ({ editId: change.id, file: change.path, when: change.timestamp ?? null,
      mode: change.mode, patchStatus: change.unavailable ?? (change.patch ? 'recorded' : 'no changes'),
      viewEdit: id === context.sessionId ? { edit_id: change.id } : null,
      history: references.get(change.toolCallId) ?? null,
    })) }, null, 2)
}
