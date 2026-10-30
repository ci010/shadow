import type { RealtimeSessionChange } from '../../src/realtime/protocol.ts'
import { isRecord } from './folders-sidebar.ts'

const changes = new Set<string>(['history', 'metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks'])
/** Hints narrow reads, never authorize them. Legacy/unknown hints remain broad
 * so mixed versions cannot silently lose updates. Activity isn't data change. */
export function affectsSessionResource(payload: unknown, sessionId: string | undefined, resource: RealtimeSessionChange): boolean {
  if (!isRecord(payload) || payload.event !== 'invalidate') return false
  if (sessionId !== undefined && payload.sessionId !== undefined && payload.sessionId !== sessionId) return false
  if (!Array.isArray(payload.changes) || !payload.changes.length
    || payload.changes.some(change => typeof change !== 'string' || !changes.has(change))) return true
  return payload.changes.includes(resource)
}
