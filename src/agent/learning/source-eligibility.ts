import { resolveAutomationSession } from '../../cron/contracts.ts'
import type { SessionState } from '../../sessions/session-store.ts'

/** Learn delegated results from the owner's evidence, not independent child histories.
 * Names, virtual addresses, fork snapshots and shared workspace roots are not ownership.
 * User cron work remains eligible; channel learning has its own journal.
 */
export function isLearningSourceEligible(
  state: SessionState | undefined | null,
  _lookup: (id: string) => SessionState | undefined | null,
  managed: (id: string) => boolean = () => false,
  projectId?: string,
): boolean {
  if (!state || state.parentSessionId || state.parentToolCallId) return false
  if (projectId && state.projectId && state.projectId !== projectId
    || state.channelSource || state.channelBoundary || managed(state.sessionId)
    || state.sessionId.startsWith('heartbeat:') || state.sessionId.startsWith('sleep:')) return false
  const source = resolveAutomationSession(state)?.config?.source
  return source !== 'learning' && source !== 'system'
}

export const LEARNING_SOURCE_QUIET_MS = 24 * 60 * 60 * 1000

/** Scheduling readiness is not permission. Reject unknown/corrupt clocks conservatively. */
export function isLearningSourceReady(
  state: SessionState | undefined | null, busy: boolean, now = Date.now(),
): boolean {
  if (!state || busy || !Number.isFinite(now)
    || ['pending', 'running', 'waiting'].includes(state.executionStatus ?? '')) return false
  const timestamp = (value: string | undefined): number | undefined => {
    if (typeof value !== 'string') return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed <= now ? parsed : undefined
  }
  const activity = timestamp(state.lastActivityAt)
  const user = timestamp(state.lastUserMessageAt)
  // Present but malformed/future activity cannot be hidden by another older clock.
  if (state.lastActivityAt !== undefined && activity === undefined
    || state.lastUserMessageAt !== undefined && user === undefined) return false
  const completed = timestamp(state.completedAt)
  if (state.completed && user !== undefined && completed !== undefined && completed >= user) return true
  const latest = Math.max(activity ?? -Infinity, user ?? -Infinity)
  return Number.isFinite(latest) && now - latest >= LEARNING_SOURCE_QUIET_MS
}

/** Values that can change the fixed source range or its scheduling readiness. */
export function learningSourceFingerprint(state: SessionState): string {
  return JSON.stringify([state.segmentIndex, state.physicalIdVersion, state.lastActivityAt,
    state.lastUserMessageAt, state.executionStatus, state.completed, state.completedAt])
}
