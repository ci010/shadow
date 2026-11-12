import { parseSessionActivityReadModel, type SessionActivityReadModel } from './activity-read-model.ts'

export type SparseSessionActivity = Partial<SessionActivityReadModel>
export interface SessionActivitySnapshot { activity: Record<string, SparseSessionActivity> }

/** A full replacement, not a delta. Missing sessions are inactive, not idle.
 * This is activity only; the summary endpoint owns session existence. */
export function sessionActivitySnapshot(entries: Iterable<readonly [string, SessionActivityReadModel]>): SessionActivitySnapshot {
  const activity: Record<string, SparseSessionActivity> = Object.create(null)
  for (const [id, model] of entries) {
    const entry: SparseSessionActivity = {}
    if (model.stage !== 'inactive') entry.stage = model.stage
    if (model.waitingForCall) entry.waitingForCall = true
    if (model.activeRequestId !== null) entry.activeRequestId = model.activeRequestId
    if (model.recovery !== null) entry.recovery = model.recovery
    if (Object.keys(entry).length) activity[id] = entry
  }
  return { activity }
}

export function parseSessionActivitySnapshot(value: unknown): Record<string, SessionActivityReadModel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('activity' in value) || !value.activity || typeof value.activity !== 'object' || Array.isArray(value.activity)) {
    throw new Error('Session activity is unavailable.')
  }
  const result: Record<string, SessionActivityReadModel> = Object.create(null)
  for (const [id, raw] of Object.entries(value.activity)) {
    if (!id || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['stage', 'waitingForCall', 'activeRequestId', 'recovery'].includes(key))) throw new Error('Session activity is unavailable.')
    const model = parseSessionActivityReadModel({ stage: 'inactive', waitingForCall: false, activeRequestId: null, recovery: null, ...raw })
    if (!model) throw new Error('Session activity is unavailable.')
    result[id] = model
  }
  return result
}
