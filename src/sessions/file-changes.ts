import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { fileChangeSchema, type FileChangesPage, type RecordedFileChange } from './file-change-contract.ts'

/** Own physical segments only: forked context is not evidence of writes by this session. */
async function* fileChanges(
  store: Pick<SessionStore, 'readSessionLog'>, state: SessionState, signal: AbortSignal, toolCallId?: string,
): AsyncGenerator<RecordedFileChange> {
  for (let segment = 0; segment <= state.segmentIndex; segment++) {
    signal.throwIfAborted()
    for await (const event of store.readSessionLog(physicalSessionId(state, segment))) {
      signal.throwIfAborted()
      if (event.file_change === undefined) continue
      const change = fileChangeSchema.parse(event.file_change)
      if (change.sessionId !== state.sessionId) throw new Error('Recorded file change belongs to another session.')
      if (toolCallId === undefined || change.toolCallId === toolCallId) yield change
    }
  }
}

export async function readSessionFileChange(
  store: Pick<SessionStore, 'readSessionLog'>, state: SessionState, id: string, signal: AbortSignal,
): Promise<RecordedFileChange | undefined> {
  for await (const change of fileChanges(store, { ...state }, signal)) {
    if (change.id === id) return change
  }
}

export async function readSessionFileChanges(
  store: Pick<SessionStore, 'readSessionLog'>, state: SessionState, offset: number, limit: number, signal: AbortSignal, toolCallId?: string,
): Promise<FileChangesPage> {
  const snapshot = { ...state }
  let total = 0
  for await (const _change of fileChanges(store, snapshot, signal, toolCallId)) total++
  const end = Math.max(0, total - offset)
  const start = Math.max(0, end - limit)
  const changes: RecordedFileChange[] = []
  if (end > 0) {
    let index = 0
    for await (const change of fileChanges(store, snapshot, signal, toolCallId)) {
      if (index++ < start) continue
      changes.push(change)
      if (index >= end) break
    }
  }
  return { changes: changes.reverse(), total, offset }
}
