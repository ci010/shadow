import { resolveAutomationSession } from '../../cron/contracts.ts'
import type { SessionState } from '../../sessions/session-store.ts'

/** Provenance, not an agent's display name, distinguishes self-generated analysis.
 * User-owned cron execution remains evidence; internal analysis and its children do not.
 * Channel learning has a separate journal and is never a Project-private source.
 */
export function isLearningSourceEligible(
  state: SessionState | undefined | null,
  lookup: (id: string) => SessionState | undefined | null,
  managed: (id: string) => boolean = () => false,
  projectId?: string,
  seen = new Set<string>(),
): boolean {
  if (!state || seen.has(state.sessionId)) return false
  seen.add(state.sessionId)
  if (projectId && state.projectId && state.projectId !== projectId
    || state.channelBoundary || managed(state.sessionId)
    || state.sessionId.startsWith('heartbeat:') || state.sessionId.startsWith('sleep:')) return false
  const source = resolveAutomationSession(state)?.config?.source
  if (source === 'learning' || source === 'system') return false
  return state.parentSessionId
    ? isLearningSourceEligible(lookup(state.parentSessionId), lookup, managed, projectId, seen)
    : true
}
