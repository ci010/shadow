import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from './service.ts'
import { resolveAutomationSession, SYSTEM_AUTOMATIONS, type LearningOutcome } from './contracts.ts'
import type { AutomationProfile, AutomationProfilePolicy } from './profile-contract.ts'

/** Automation adapter over the shared persisted session usage source; HTTP and virtual reads agree. */
export class AutomationProfileService {
  constructor(private cron: CronService, private sessions: SessionManager, readonly projectId: string,
    private policy?: AutomationProfilePolicy, private now: () => number = Date.now,
    private learningOutcome?: (sessionId: string) => LearningOutcome | undefined) {}
  featureIds(): string[] {
    const ids = new Set([...this.cron.listJobs().map(job => job.id), ...Object.values(SYSTEM_AUTOMATIONS).map(job => job.id)])
    for (const row of this.sessions.listSessions()) {
      const state = this.sessions.getSessionState(row.sessionId)
      const automation = state?.projectId === this.projectId ? resolveAutomationSession(state) : undefined
      if (automation) ids.add(automation.jobId)
    }
    return [...ids]
  }
  async query(featureId: string, signal?: AbortSignal): Promise<AutomationProfile | undefined> {
    if (typeof featureId !== 'string' || !featureId.trim() || featureId.length > 128) throw new TypeError('Invalid automation feature')
    const records = this.sessions.listSessions().flatMap(row => {
      const state = this.sessions.getSessionState(row.sessionId)
      if (!state || state.projectId !== this.projectId) return []
      const automation = resolveAutomationSession(state)
      return automation?.jobId === featureId ? [{ state, automation }] : []
    })
    const job = this.cron.listJobs().find(job => job.id === featureId)
    const system = Object.values(SYSTEM_AUTOMATIONS).some(job => job.id === featureId)
    if (!job && !system && !records.length) return undefined
    const asOf = this.now(), from = asOf - 86_400_000
    const runs: AutomationProfile['runs'] = { total: 0, completed: 0, failed: 0, partial: 0, cancelled: 0, running: 0, unknown: 0, full: 0, delta: 0 }
    for (const { state, automation } of records) {
      const started = Date.parse(automation.startedAt)
      if (!(started >= from && started < asOf)) continue
      runs.total++
      if (automation.config?.organizationMode) runs[automation.config.organizationMode]++
      if (automation.legacy) runs.unknown++
      else if (state.executionStatus === 'failed' || state.executionStatus === 'cancelled') runs[state.executionStatus]++
      else if (automation.organization?.status === 'partial' || automation.config?.source === 'learning' && this.learningOutcome?.(state.sessionId)?.status === 'partial') runs.partial++
      else if (state.executionStatus === 'completed' && automation.config?.source === 'learning' && !this.learningOutcome?.(state.sessionId)) runs.unknown++
      else if (state.executionStatus === 'completed') runs.completed++
      else if (['running', 'waiting', 'pending'].includes(state.executionStatus ?? '')) runs.running++
      else runs.unknown++
    }
    // Include events from older runs still active within the window, not only new runs.
    const usage = await this.sessions.getAutomationUsage(records.map(record => record.state.sessionId), from, asOf, signal)
    const organizationScopes: AutomationProfile['organizationScopes'] = featureId === SYSTEM_AUTOMATIONS.organizer.id ? {} : undefined
    if (organizationScopes) for (const mode of ['full', 'delta'] as const) {
      const selected = records.filter(record => record.automation.config?.organizationMode === mode)
      organizationScopes[mode] = await this.sessions.getAutomationUsage(selected.map(record => record.state.sessionId), from, asOf, signal)
    }
    const frequency = this.policy?.(featureId) ?? (job ? { kind: 'schedule' as const, description: job.schedule, scope: 'configured_job' as const, schedule: job.schedule }
      : { kind: 'unknown' as const, description: 'Current runtime policy unavailable; historical snapshots are not current frequency.', scope: 'historical_unknown' as const })
    return { featureId, window: { from: new Date(from).toISOString(), asOf: new Date(asOf).toISOString(), timezone: 'UTC', semantics: 'events_completed_in_window_runs_started_in_window' }, frequency, runs, usage, ...(organizationScopes ? { organizationScopes } : {}),
      coverage: usage.scanLimitReached || usage.untrackedSessions || usage.unknownUsageCalls ? 'partial' : usage.trackedSessions ? 'complete' : 'unknown',
      limitations: [...(usage.scanLimitReached ? ['Source scan capped at 100,000 records; all displayed counts and known tokens are lower bounds.'] : []), 'Provider calls are persisted provider.chat completions, including failures; transport retries are not separate calls.',
        'Tool calls count distinct persisted tool result IDs; interrupted calls without a result and nested direct tool invocations may be absent.',
        'Missing historical telemetry is unknown, not zero. Known token totals are subtotals when usage is incomplete.',
        'Cached/reasoning token breakdowns, call durations and costs are not persisted by this source. No budget estimates or quality scores.'] }
  }
}
