import type { Hono } from 'hono'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from './service.ts'
import { cronContextMode } from './service.ts'
import { resolveAutomationSession, type AutomationSummary, type AutomationRunSummary } from './contracts.ts'

/** Mounted on the owning project's router; never reads another project's stores. */
export function registerAutomationRoutes(app: Hono, cron: CronService, sessions: SessionManager, projectId: string): void {
  const records = () => sessions.listSessions().flatMap(row => {
    const state = sessions.getSessionState(row.sessionId)
    if (!state || state.projectId && state.projectId !== projectId) return []
    const automation = resolveAutomationSession(state)
    return automation ? [{ state, automation }] : []
  })
  const summaries = (): AutomationSummary[] => {
    const jobs = new Map<string, AutomationSummary>()
    for (const { automation } of records().sort((a, b) => a.automation.startedAt.localeCompare(b.automation.startedAt))) {
      jobs.set(automation.jobId, {
        id: automation.jobId, name: automation.name, source: automation.config?.source ?? 'cron',
        session: 'fresh', schedule: automation.config?.schedule ?? 'Historical schedule unavailable',
        task: automation.config?.task, agentType: automation.config?.agentType, enabled: false,
      })
    }
    for (const job of cron.listJobs()) {
      if (cronContextMode(job) !== 'fresh') continue
      jobs.set(job.id, {
        id: job.id, name: job.name ?? job.task ?? job.id, source: job.source ?? 'cron',
        session: 'fresh', schedule: job.schedule, task: job.task, agentType: job.agentType,
        enabled: job.enabled !== false,
      })
    }
    return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }
  app.get('/api/automations', c => c.json({ automations: summaries() }))
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
        title: state.description ?? await sessions.getFirstUserMessage(state.sessionId) ?? undefined,
      }
    }))
    return c.json({ runs, total: all.length, offset })
  })
}
