import type { SessionManager } from '../sessions/session-manager.ts'

/** Shared by production composition and synthetic end-to-end tests. A service
 * revocation must not wait for an in-flight provider to finish before publishing.
 * Old snapshots are stopped and all inference/tools/output revalidate their live generation.
 * Personal mode retains its existing quiescent publication contract. */
export function publishBotChange<T>(sessions: Pick<SessionManager, 'fenceConversationContexts' | 'retireIdleConversationContexts'>,
  policies: { changePublished<T>(retire: () => Promise<void>, change: () => Promise<T>): Promise<T> },
  matches: (sessionId: string) => boolean, personal: boolean, change: () => Promise<T>): Promise<T> {
  return policies.changePublished(async () => {
    if (personal) await sessions.retireIdleConversationContexts(matches)
    else sessions.fenceConversationContexts(matches)
  }, change)
}
