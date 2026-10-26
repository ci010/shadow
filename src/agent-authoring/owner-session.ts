import type { SessionState } from '../sessions/session-store.ts'

/** Legacy durable sessions omit mode; execution itself treats that as session. */
export function isOwnerAuthoringSession(state: SessionState | null | undefined, projectId: string): boolean {
  return !!state && state.projectId === projectId && (state.mode ?? 'session') === 'session' &&
    !state.parentSessionId && !state.parent && !state.automation && !state.statePersistence && state.sessionId.startsWith('web:')
}
