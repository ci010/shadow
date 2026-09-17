import { isLearningAutomationRef, resolveAutomationSession } from '../cron/contracts.ts'
import type { SessionState } from './session-store.ts'

export function isLearningAutomationSession(state: SessionState): boolean {
  return isLearningAutomationRef(resolveAutomationSession(state))
}

// Legacy renderer compatibility; new behavior uses explicit automation metadata.
export function isSelfReflectionId(id: string): boolean {
  return /^heartbeat:(?:soul-)?reflector-.+/.test(id)
}
