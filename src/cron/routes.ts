import type { Hono } from 'hono'
import { AutomationProfileService } from './profile.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from './service.ts'
import { cronContextMode } from './service.ts'
import { SYSTEM_AUTOMATIONS, resolveAutomationSession, type AutomationSummary, type AutomationRunSummary, type LearningOutcome } from './contracts.ts'

/** Mounted on the owning project's router; never reads another project's stores. */
export function registerAutomationRoutes(app: Hono, cron: CronService, sessions: SessionManager, projectId: string,
  learningOutcome?: (sessionId: string) => LearningOutcome | undefined, learningNotice?: (jobId: string) => string | undefined,
  learningControls?: { preference: (jobId: string) => boolean; globallyEnabled: () => boolean; update: (jobId: string, enabled: boolean) => Promise<void> },
  systemControls?: { preference: (jobId: string) => boolean; update: (jobId: string, enabled: boolean) => Promise<void>; authorize: (request: Request) => boolean | Promise<boolean> }, profileService?: AutomationProfileService): void {
  const profiler = profileService ?? new AutomationProfileService(cron, sessions, projectId)
  app.get('/api/automations/:id/profile', async c => {
    const id = c.req.param('id')
    if (!id.trim() || id.length > 128) return c.json({ error: 'invalid_automation_feature' }, 400)
    const profile = await profiler.query(id)
    return profile ? c.json({ profile }) : c.json({ error: 'automation_not_found' }, 404)
  })
  const records = () => sessions.listSessions().flatMap(row => {
    const state = sessions.getSessionState(row.sessionId)
    if (!state || state.projectId && state.projectId !== projectId) return []
    const automation = resolveAutomationSession(state)
    return automation ? [{ state, automation }] : []
  })
  const summaries = (authorized = false): AutomationSummary[] => {
    const jobs = new Map<string, AutomationSummary>()
    for (const { automation } of records().sort((a, b) => a.automation.startedAt.localeCompare(b.automation.startedAt))) {
      jobs.set(automation.jobId, {
        id: automation.jobId, name: Object.values(SYSTEM_AUTOMATIONS).find(job => job.id === automation.jobId)?.name ?? automation.name, source: automation.config?.source ?? 'cron',
        session: 'fresh', schedule: automation.config?.schedule ?? 'Historical schedule unavailable',
        task: automation.config?.task, agentType: automation.config?.agentType, enabled: false, editable: false,
      })
    }
    for (const job of cron.listJobs()) {
      if (cronContextMode(job) !== 'fresh') continue
      jobs.set(job.id, {
        id: job.id, name: job.name ?? job.task ?? job.id, source: job.source ?? 'cron',
        session: 'fresh', schedule: job.schedule, task: job.task, agentType: job.agentType,
        enabled: job.enabled !== false,
        editable: job.source !== 'learning' || !!learningControls,
        configuredEnabled: job.source === 'learning' ? learningControls?.preference(job.id) ?? job.enabled !== false : job.enabled !== false,
        disabledByGlobal: job.source === 'learning' && !!learningControls && !learningControls.globallyEnabled(),
        ...(job.source === 'learning' ? { notice: learningNotice?.(job.id) } : {}),
      })
    }
    if (systemControls) for (const job of Object.values(SYSTEM_AUTOMATIONS)) jobs.set(job.id, {
      id: job.id, name: job.name, source: 'system', session: 'fresh', schedule: 'Event-driven / manual',
      agentType: job.agentType, enabled: systemControls.preference(job.id), configuredEnabled: systemControls.preference(job.id), editable: false, canToggle: authorized,
    })
    for (const summary of jobs.values()) {
      const controller = Object.values(SYSTEM_AUTOMATIONS).find(job => job.id === summary.id
        || summary.source === 'system' && job.agentType === summary.agentType)
      if (controller && systemControls) {
        summary.canToggle = authorized
        if (authorized) {
          summary.toggleId = controller.id
          summary.toggleEnabled = systemControls.preference(controller.id)
        }
      } else if (systemControls && !authorized) summary.canToggle = false
    }
    return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }
  app.get('/api/automations', async c => c.json({ automations: summaries(!!systemControls && await systemControls.authorize(c.req.raw)) }))
  app.patch('/api/automations/:id', async c => {
    const id = c.req.param('id')
    if (systemControls && !await systemControls.authorize(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
    const system = systemControls && Object.values(SYSTEM_AUTOMATIONS).some(job => job.id === id)
    const job = cron.listJobs().find(job => job.id === id && cronContextMode(job) === 'fresh')
    if (!system && (!job || job.source === 'learning' && !learningControls)) return c.json({ error: 'automation_not_found' }, 404)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid_automation_update' }, 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('enabled' in body) || typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_automation_update' }, 400)
    if (system) await systemControls!.update(id, body.enabled)
    else if (job!.source === 'learning') await learningControls!.update(id, body.enabled)
    else if (!await cron.setJobEnabled(id, body.enabled)) return c.json({ error: 'automation_not_found' }, 404)
    return c.json({ automation: summaries(true).find(job => job.id === id) })
  })
  app.get('/api/automations/:id/runs', async c => {
    const id = c.req.param('id')
    if (!summaries().some(job => job.id === id)) return c.json({ error: 'automation_not_found' }, 404)
    const offset = Number(c.req.query('offset') ?? 0)
    const limit = Number(c.req.query('limit') ?? 30)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: 'invalid_pagination' }, 400)
    }
    const all = records().filter(record => record.automation.jobId === id)
      .sort((a, b) => b.automation.startedAt.localeCompare(a.automation.startedAt)
        || b.automation.runId.localeCompare(a.automation.runId))
    const runs: AutomationRunSummary[] = await Promise.all(all.slice(offset, offset + limit).map(async ({ state, automation }) => {
      const status = state.executionStatus
      return {
        id: automation.runId, sessionId: state.sessionId, startedAt: automation.startedAt,
        status: automation.legacy ? 'unknown'
          : status === 'completed' || status === 'failed' || status === 'cancelled' ? status
          : status === 'running' || status === 'waiting' || status === 'pending' ? 'running' : 'unknown',
        title: automation.config?.source === 'system' ? automation.name : state.description ?? await sessions.getFirstUserMessage(state.sessionId) ?? undefined,
        ...(automation.config?.organizationMode ? { scope: automation.config.organizationMode } : {}),
        ...(automation.organizationProblem ? { organizationProblem: automation.organizationProblem } : {}),
        ...(automation.organization ? { organization: automation.organization } : {}),
        ...(automation.config?.source === 'learning' && learningOutcome?.(state.sessionId)
          ? { learning: learningOutcome(state.sessionId) } : {}),
      }
    }))
    return c.json({ runs, total: all.length, offset })
  })
}
