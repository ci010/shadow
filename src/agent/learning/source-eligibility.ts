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
    || state.channelBoundary || managed(state.sessionId)
    || state.sessionId.startsWith('heartbeat:') || state.sessionId.startsWith('sleep:')) return false
  const source = resolveAutomationSession(state)?.config?.source
  return source !== 'learning' && source !== 'system'
}
