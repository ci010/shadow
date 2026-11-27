import type { SessionState } from './session-store.ts'

export type RecallOrigin = 'conversation' | 'excluded' | 'unknown'

/** Host state and admitted turn provenance only; never agent names or address patterns. */
export function recallOrigin(sessionId: string, inputSource: 'user' | 'session' | 'event' | undefined,
  getState: (id: string) => SessionState | null | undefined, inputSessionId?: string): RecallOrigin {
  if (inputSource === 'event') return 'excluded'
  if (!inputSource) return 'unknown'
  const lineage = (start: string): RecallOrigin => {
    const seen = new Set<string>()
    let id: string | undefined = start
    while (id) {
      if (seen.has(id)) return 'unknown'
      seen.add(id)
      const state = getState(id)
      if (!state) return 'unknown'
      if (state.automation || state.automaticWork || state.statePersistence || state.channelBoundary?.learning) return 'excluded'
      // SessionManager stamps this only after migrating structured automation metadata.
      if (state.automationVersion !== 1) return 'unknown'
      id = state.parentSessionId ?? undefined
    }
    return 'conversation'
  }
  const own = lineage(sessionId)
  if (own !== 'conversation' || inputSource === 'user') return own
  // A message from an automation worker must not launder reads into an ordinary recipient.
  return inputSessionId ? lineage(inputSessionId) : 'unknown'
}
