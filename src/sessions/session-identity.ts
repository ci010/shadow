import { newPhysicalSessionId } from '../utils/paths.ts'
import type { SessionState } from './session-store.ts'

export class SessionIdentityError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionIdentityError' }
}

export function parsePhysicalIdVersion(value: unknown): 2 | undefined {
  if (value === undefined || value === 2) return value
  throw new SessionIdentityError('Invalid session physical ID version')
}

export function physicalSessionId(state: Pick<SessionState, 'sessionId' | 'segmentIndex' | 'physicalIdVersion'>, index = state.segmentIndex): string {
  return newPhysicalSessionId(state.sessionId, index, parsePhysicalIdVersion(state.physicalIdVersion) ?? 1)
}

export function hasTruncatedLegacyHistory(state: Pick<SessionState, 'sessionId' | 'physicalIdVersion'>): boolean {
  return parsePhysicalIdVersion(state.physicalIdVersion) !== 2
    && state.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').length > 48
}
