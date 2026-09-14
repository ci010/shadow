import type { SessionState } from './session-store.ts'

export const MAX_CALL_TIMEOUT_MS = 120_000

/** Indexed parent history is a context fork, not delegation ownership. */
export function delegationOwner(state: SessionState | null | undefined): string | undefined {
  if (!state) return undefined
  if (Object.hasOwn(state, 'parentSessionId')) return state.parentSessionId ?? undefined
  return state.parent?.index === undefined && (state.workspaceRoot || state.reportTo || state.description || state.parent?.physicalId)
    ? state.parent?.id : undefined
}
