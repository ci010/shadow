import type { SessionManager } from './session-manager.ts'
import type { SessionProfile } from './profile-contract.ts'
export const PROFILE_LIMITATIONS = [
  'Source records are scanned on demand, capped at 100,000 per aggregate; capped totals are lower bounds.',
  'Provider calls count persisted provider.chat completions (including failures), not transport retries.',
  'Tool calls count distinct persisted result IDs, not interrupted or nested direct calls.',
  'Missing telemetry is unknown, not zero. Tokens are known subtotals when usage is incomplete.',
  'Physical segments are included once per logical session; own and inclusive scopes overlap and must not be added.',
  'Rolling 24h counts completed source events in UTC [asOf - 24h, asOf); conversation total counts dated source events before asOf.',
  'This profile does not expose cached/reasoning breakdowns, costs or call durations; Project Usage shows persisted cost estimates and available durations.',
]
export class SessionProfileService {
  constructor(private sessions: SessionManager, readonly projectId: string, private now: () => number = Date.now) {}
  async query(sessionId: string, signal?: AbortSignal): Promise<SessionProfile | undefined> {
    const state = await this.sessions.readSessionState(sessionId)
    if (!state || state.projectId !== this.projectId) return undefined
    const asOf = this.now()
    const read = (from: number, inclusive: boolean) => this.sessions.getProfileUsage([sessionId], from, asOf, signal, inclusive)
    const [own24, inclusive24, ownTotal, inclusiveTotal] = await Promise.all([read(asOf - 86_400_000, false), read(asOf - 86_400_000, true), read(-Infinity, false), read(-Infinity, true)])
    return { sessionId, scope: 'own_and_descendants', asOf: new Date(asOf).toISOString(), rolling24h: { own: own24, inclusive: inclusive24 }, total: { own: ownTotal, inclusive: inclusiveTotal }, limitations: PROFILE_LIMITATIONS }
  }
  async project(signal?: AbortSignal) {
    const asOf = this.now()
    const ids = (await this.sessions.listHistoryStates()).filter(row => row.projectId === this.projectId).map(row => row.sessionId)
    return { projectId: this.projectId, asOf: new Date(asOf).toISOString(), window: { from: new Date(asOf - 86_400_000).toISOString(), semantics: '[from, asOf), UTC; completed source events' }, rolling24h: await this.sessions.getProfileUsage(ids, asOf - 86_400_000, asOf, signal), total: await this.sessions.getProfileUsage(ids, -Infinity, asOf, signal), limitations: PROFILE_LIMITATIONS }
  }
}
