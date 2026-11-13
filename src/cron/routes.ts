import type { Hono } from 'hono'
import { z } from 'zod'
import { workDispatchConfigSchema, WORK_DISPATCH_ID, type WorkDispatchConfig } from './work-dispatch-contract.ts'
import { AutomationProfileService } from './profile.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from './service.ts'
import { cronContextMode } from './service.ts'
import { SYSTEM_AUTOMATIONS, resolveAutomationSession, type AutomationSummary, type AutomationRunSummary, type LearningOutcome } from './contracts.ts'

/** Mounted on the owning project's router; never reads another project's stores. */
export function registerAutomationRoutes(app: Hono, cron: CronService, sessions: SessionManager, projectId: string,
  learningOutcome?: (sessionId: string) => LearningOutcome | undefined, learningNotice?: (jobId: string) => string | undefined,
  learningControls?: { preference: (jobId: string) => boolean; globallyEnabled: () => boolean; update: (jobId: string, enabled: boolean) => Promise<void>; interval?: (jobId: string) => number; updateInterval?: (jobId: string, intervalMs: number) => Promise<void> },
  systemControls?: { preference: (jobId: string) => boolean; update: (jobId: string, enabled: boolean) => Promise<void>; authorize: (request: Request) => boolean | Promise<boolean>; modelSettings?: (jobId: string) => { model?: string; defaultModel: string }; updateModel?: (jobId: string, model: string | null) => Promise<void> }, profileService?: AutomationProfileService,
  programControls?: { running?: () => boolean; cancel?: () => Promise<boolean>; validate: (config: WorkDispatchConfig, signal: AbortSignal) => Promise<void>; validateAdmission: (config: WorkDispatchConfig, signal: AbortSignal) => Promise<void>; resume: (key: string, version: number, signal: AbortSignal, acknowledgeToolReplay: boolean) => Promise<void> }): (workflowId: string, enabled: boolean, request: Request) => Promise<void> {
  const profiler = profileService ?? new AutomationProfileService(cron, sessions, projectId)
  app.get('/api/automations/:id/profile', async c => {
    const id = c.req.param('id')
    if (!id.trim() || id.length > 128) return c.json({ error: 'invalid_automation_feature' }, 400)
    if (id === 'system:work-observer') return c.json({ error: 'automation_not_found' }, 404)
    const profile = await profiler.query(id)
    return profile ? c.json({ profile }) : c.json({ error: 'automation_not_found' }, 404)
  })
  const records = async () => (await sessions.automationFeatureStates()).flatMap(state => {
    if (!state || state.projectId && state.projectId !== projectId) return []
    const automation = resolveAutomationSession(state)
    return automation && automation.jobId !== 'system:work-observer' && automation.config?.agentType !== 'work-observer' ? [{ state, automation }] : []
  })
  const summaries = async (authorized = false): Promise<AutomationSummary[]> => {
    const jobs = new Map<string, AutomationSummary>()
    for (const { automation } of (await records()).sort((a, b) => a.automation.startedAt.localeCompare(b.automation.startedAt))) {
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
        session: 'fresh', schedule: job.schedule, task: job.task, agentType: job.agentType, workflow: cron.workflowStatus(job.id),
        ...(job.program ? { program: job.program, running: cron.isRunning(job.id) || programControls?.running?.() === true,
          configurationError: undefined, // Project dispatch can bootstrap without a default Workspace.
          notice: !job.program.folderId ? 'Project dispatch is ready without a default Workspace. Eligible Work starts an unbound bootstrap worker, which must acquire an authorized source and bind its prepared isolated worktree before implementation.' : 'Fresh dispatcher rounds select Work, models and devices; idle ticks do not call a model. Workers use isolated local or supported Child Git worktrees.' } : {}),
        enabled: job.enabled !== false,
        editable: job.source !== 'learning' || !!learningControls,
        configuredEnabled: job.source === 'learning' ? learningControls?.preference(job.id) ?? job.enabled !== false : job.enabled !== false,
        disabledByGlobal: job.source === 'learning' && !!learningControls && !learningControls.globallyEnabled(),
        ...(job.source === 'learning' ? { notice: learningNotice?.(job.id), intervalMs: learningControls?.interval?.(job.id) } : {}),
      })
    }
    if (systemControls) for (const job of Object.values(SYSTEM_AUTOMATIONS)) jobs.set(job.id, {
      id: job.id, name: job.name, source: 'system', session: 'fresh', schedule: 'Event-driven / manual',
      ...(systemControls.modelSettings?.(job.id) ?? {}), canConfigureModel: authorized && !!systemControls.updateModel,
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
  app.get('/api/automations', async c => c.json({ automations: await summaries(!!systemControls && await systemControls.authorize(c.req.raw)) }))
  app.patch('/api/automations/:id', async c => {
    const id = c.req.param('id')
    if (systemControls && !await systemControls.authorize(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
    const system = systemControls && Object.values(SYSTEM_AUTOMATIONS).some(job => job.id === id)
    const job = cron.listJobs().find(job => job.id === id && cronContextMode(job) === 'fresh')
    if (!system && (!job || job.source === 'learning' && !learningControls)) return c.json({ error: 'automation_not_found' }, 404)
    if (job?.program && !systemControls) return c.json({ error: 'forbidden' }, 403)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid_automation_update' }, 400) }
    if (job?.program && body && typeof body === 'object' && !Array.isArray(body) && ('program' in body || 'schedule' in body)) {
      const parsed = z.object({ program: workDispatchConfigSchema, schedule: z.string().regex(/^every ([1-9][0-9]*)[smh]$/).optional() }).strict().safeParse(body)
      if (!parsed.success || !programControls) return c.json({ error: 'invalid_automation_update' }, 400)
      try {
        // A default source is optional; when selected its exact target is validated.
        // Enabled workspace-less programs still validate inference configuration.
        if (parsed.data.program.folderId || job.enabled !== false) await programControls.validate(parsed.data.program, c.req.raw.signal)
        await cron.configureProgram(id, parsed.data.program, parsed.data.schedule)
      } catch (error) { return c.json({ error: 'invalid_work_dispatch_configuration', message: String(error) }, 400) }
      return c.json({ automation: (await summaries(true)).find(job => job.id === id) })
    }
    if (system && body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'model' in body) {
      if (!systemControls!.updateModel) return c.json({ error: 'model_settings_unavailable' }, 400)
      if (body.model !== null && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 512)) return c.json({ error: 'invalid_automation_update' }, 400)
      await systemControls!.updateModel(id, typeof body.model === 'string' ? body.model.trim() : null)
      return c.json({ automation: (await summaries(true)).find(job => job.id === id) })
    }
    if (!system && job?.source === 'learning' && body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'intervalMs' in body) {
      const interval = body.intervalMs
      if (!learningControls?.updateInterval || typeof interval !== 'number' || !Number.isSafeInteger(interval)
        || interval < 60_000 || interval > 35791 * 60_000 || interval % 60_000 !== 0) return c.json({ error: 'invalid_automation_update' }, 400)
      await learningControls.updateInterval(id, interval)
      return c.json({ automation: (await summaries(true)).find(job => job.id === id) })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('enabled' in body) || typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_automation_update' }, 400)
    if (job?.program && body.enabled) {
      // Project admission is not execution: a saved default source may be offline.
      // Target/isolation checks still run on configuration, manual run and dispatch.
      try { if (!programControls) throw new Error('Work dispatcher unavailable'); await programControls.validateAdmission(job.program, c.req.raw.signal) }
      catch (error) { return c.json({ error: 'invalid_work_dispatch_configuration', message: String(error) }, 400) }
    }
    if (system) await systemControls!.update(id, body.enabled)
    else if (job!.source === 'learning') await learningControls!.update(id, body.enabled)
    else if (!await cron.setJobEnabled(id, body.enabled)) return c.json({ error: 'automation_not_found' }, 404)
    return c.json({ automation: (await summaries(true)).find(job => job.id === id) })
  })
  for (const action of ['run', 'cancel'] as const) app.post(`/api/automations/:id/${action}`, async c => {
    if (systemControls && !await systemControls.authorize(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
    const id = c.req.param('id')
    // Managed/event-driven controllers retain their own admission policy.
    const job = cron.listJobs().find(job => job.id === id && cronContextMode(job) === 'fresh' && job.source !== 'learning')
    if (!job) return c.json({ error: 'automation_not_found' }, 404)
    if (job.program && !systemControls) return c.json({ error: 'forbidden' }, 403)
    if (action === 'cancel') {
      const scan = await cron.cancelRun(id)
      const executor = job.program ? await programControls?.cancel?.() ?? false : false
      return c.json({ cancelled: scan || executor })
    }
    if (job.program) {
      try { if (!programControls) throw new Error('Work dispatcher unavailable'); await programControls.validate(job.program, c.req.raw.signal) }
      catch (error) { return c.json({ error: 'invalid_work_dispatch_configuration', message: String(error) }, 400) }
    }
    // Like CronService.runNow, explicit manual execution is allowed while the timer is disabled.
    void cron.runNow(id).catch(error => console.error('[automation] Manual run failed', error))
    return c.json({ accepted: true }, 202)
  })
  app.post('/api/automations/:id/work/resume', async c => {
    if (!systemControls || !await systemControls.authorize(c.req.raw)) return c.json({ error: 'forbidden' }, 403)
    if (c.req.param('id') !== WORK_DISPATCH_ID || !programControls) return c.json({ error: 'automation_not_found' }, 404)
    const parsed = z.object({ key: z.string().min(1).max(600), version: z.number().int().positive(), acknowledgeToolReplay: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid_work_recovery' }, 400)
    try { await programControls.resume(parsed.data.key, parsed.data.version, c.req.raw.signal, parsed.data.acknowledgeToolReplay) }
    catch (error) { return c.json({ error: 'work_recovery_conflict', message: String(error) }, 409) }
    return c.json({ accepted: true }, 202)
  })
  app.get('/api/automations/:id/runs', async c => {
    const id = c.req.param('id')
    if (!(await summaries()).some(job => job.id === id)) return c.json({ error: 'automation_not_found' }, 404)
    const offset = Number(c.req.query('offset') ?? 0)
    const limit = Number(c.req.query('limit') ?? 30)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: 'invalid_pagination' }, 400)
    }
    const page = await sessions.querySessionHistoryStates({ projectId, jobId: id, offset, limit })
    const all = page.states.flatMap(state => {
      const automation = resolveAutomationSession(state)
      return automation && automation.jobId !== 'system:work-observer' && automation.config?.agentType !== 'work-observer' ? [{ state, automation }] : []
    })
    const runs: AutomationRunSummary[] = await Promise.all(all.map(async ({ state, automation }) => {
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
    return c.json({ runs, total: page.total, offset })
  })
  // Workflow controls use the same persistent feature owners as automation PATCH.
  // Never toggle only the derived Workflow flag for a config-owned schedule.
  return async (workflowId, enabled, request) => {
    if (systemControls && !await systemControls.authorize(request)) throw new Error('Forbidden')
    if (workflowId === 'internal:work-organizer') {
      if (!systemControls) throw new Error('System controls unavailable')
      await systemControls.update('system:work-organizer', enabled)
      return
    }
    const job = cron.listJobs().find(job => cron.workflowStatus(job.id)?.id === workflowId)
    if (!job) throw new Error('Current schedule unavailable')
    if (job.program && !systemControls) throw new Error('Program controls unavailable')
    if (job.program && enabled) {
      if (!programControls) throw new Error('Program controls unavailable')
      await programControls.validateAdmission(job.program, request.signal)
    }
    if (job.source === 'learning') {
      if (!learningControls) throw new Error('Learning controls unavailable')
      await learningControls.update(job.id, enabled)
    } else if (!await cron.setJobEnabled(job.id, enabled)) throw new Error('Schedule is not editable')
  }
}
