import { OrganizationConflict } from './work-observer.ts'
import { randomUUID } from 'node:crypto'
import { ObserverOutputError } from './observer-output.ts'
import { z } from 'zod'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { WorkConflict } from '../initiatives/work-contract.ts'
import { FolderError } from '../folders/registry.ts'
import { projectWorkOverviewSchema, type ProjectWorkOverview, type ProjectWorkItem } from './work-overview.ts'

export const humanWorkActionSchema = z.object({
  action: z.enum(['create', 'update', 'assign', 'review']),
  key: z.string().optional(), version: z.number().int().positive().optional(), data: z.unknown().optional(),
}).strict()

export async function applyHumanWorkAction(sessions: SessionManager, body: z.infer<typeof humanWorkActionSchema>, signal: AbortSignal) {
  const alignment = sessions.alignment
  if (!alignment) throw new WorkConflict('Work is unavailable.')
  signal.throwIfAborted()
  if (body.action === 'create') {
    await alignment.execute({ kind: 'user' }, 'create', undefined, undefined, body.data, signal)
    return
  }
  if (!body.key || body.version === undefined) throw new WorkConflict('Provide the current note key and version.')
  if (body.action === 'update') await alignment.editNote({ kind: 'user' }, body.key, body.version, body.data, signal)
  else if (body.action === 'assign') {
    const data = z.object({ assignee: z.string().min(1).max(512).nullable() }).strict().parse(body.data)
    await alignment.assignNote({ kind: 'user' }, body.key, body.version, data.assignee, signal)
  } else {
    const data = z.object({ conclusion: z.string().trim().min(1).max(2000) }).strict().parse(body.data)
    await alignment.reviewNote({ kind: 'user' }, body.key, body.version, data.conclusion, signal)
  }
}

export function projectWorkOverview(sessions: SessionManager, github: Record<string, ProjectWorkItem['github']> = {}, observer?: ProjectWorkOverview['observer']): ProjectWorkOverview {
  const alignment = sessions.alignment
  if (!alignment) throw new WorkConflict('Work is unavailable.')
  const states = sessions.listSessions().filter(state => state.agentType !== 'work-observer')
  const records = alignment.store.workRecords()
  return projectWorkOverviewSchema.parse({
    observer,
    focus: alignment.store.projectFocus(),
    items: records.map(record => {
      const authority = alignment.store.workAuthority(record.subject)
      return {
        key: record.key, title: record.workflow?.title ?? record.definition.objective,
        revision: record.revision, sequence: record.sequence, status: record.workflow?.status ?? null,
        blockedReason: record.workflow?.blockedReason ?? null,
        parentKey: record.workflow?.parentKey ?? null, dependencies: record.workflow?.dependencies ?? [],
        manager: authority.manager, assignee: authority.executor, paused: record.paused,
        adopted: record.adoption?.revision === record.revision && record.adoption.sessionId === authority.executor,
        proposals: record.proposals?.filter(proposal => proposal.status === 'pending' && proposal.baseRevision === record.revision
          && proposal.assignmentRevision === record.workflow?.assignmentRevision).length ?? 0,
        interpretationReview: !!record.answerReview, changedAt: record.changedAt,
        objective: record.definition.objective, origin: record.origin, userQuote: record.requestSource?.quote,
        notes: record.notes, contextChanged: alignment.contextChanged(record),
        github: github[record.key],
        observation: record.observation,
        decisionInfluences: record.proposals?.filter(proposal => proposal.status === 'applied' && proposal.appliedRevision && proposal.request)
          .map(proposal => ({ reason: proposal.reason, baseRevision: proposal.baseRevision, appliedRevision: proposal.appliedRevision!, request: proposal.request! })),
      }
    }),
    sessions: states.map(state => {
      const full = sessions.getSessionState(state.sessionId)
      const temporary = state.mode === 'task' || state.mode === 'call'
      const observed = records.find(record => record.observation?.sessionId === state.sessionId)
      return { sessionId: state.sessionId, title: state.name || state.description || observed?.workflow?.title || state.sessionId,
        assignable: !temporary, parentSessionId: full?.parentSessionId ?? null, lastActivityAt: state.lastActivityAt,
        workKey: alignment.decisionContext(state.sessionId)?.originKey ?? observed?.key,
        activity: sessions.inputs.get(state.sessionId) || sessions.yields.get(state.sessionId) ? 'waiting'
          : sessions.isWaitingForCall(state.sessionId) ? 'waiting-for-call'
          : temporary && full?.executionStatus && full.executionStatus !== 'running' ? full.executionStatus
          : sessions.getActiveSession(state.sessionId)?.phase ?? (temporary ? full?.executionStatus : undefined) ?? 'inactive',
      }
    }),
    requests: states.flatMap(state => {
      const input = sessions.inputs.get(state.sessionId)
      const decision = sessions.yields.get(state.sessionId)
      const request = input ?? decision
      return request ? [{
        id: request.id, sessionId: state.sessionId, kind: input ? 'input' as const : 'decision' as const,
        question: request.question, recipient: request.recipient.kind,
        context: request.workContext,
        workKeys: request.workContext ? request.workContext.path.map(node => node.key) : decision?.workStamps?.map(stamp => stamp.key) ?? [],
      }] : []
    }),
    effects: alignment.store.workEffects().map(effect => ({
      id: effect.id, sessionId: effect.sessionId, tool: effect.tool, status: effect.status,
      workKeys: effect.stamps.map(stamp => stamp.key),
    })),
  })
}

export function projectWorkPlugin(sessions: SessionManager, authorize: (request: Request) => boolean | Promise<boolean>,
  github: () => Record<string, ProjectWorkItem['github']> = () => ({}),
  observer?: () => ProjectWorkOverview['observer'],
  organize?: (signal: AbortSignal) => Promise<void>): GatewayPlugin {
  return app => {
    const diagnostics = new WeakMap<Request, string>()
    app.use('/api/work/organize', async (c, next) => {
      const correlationId = randomUUID()
      diagnostics.set(c.req.raw, correlationId)
      c.header('X-Correlation-ID', correlationId)
      c.header('Cache-Control', 'no-store')
      const fail = (code: string, stage: string, status: 401 | 501 | 502) => {
        console.error('[work-organization]', { correlationId, stage, code })
        return c.json({ error: code, stage, correlationId }, status)
      }
      console.info('[work-organization]', { correlationId, stage: 'request', code: 'organization_received' })
      try {
        if (!await authorize(c.req.raw)) return fail('unauthorized', 'authorization', 401)
      } catch { return fail('organization_authorization_failed', 'authorization', 502) }
      if (!sessions.alignment) return fail('work_unavailable', 'availability', 501)
      return next()
    })
    app.use('/api/work', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!diagnostics.has(c.req.raw) && !await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions.alignment) return c.json({ error: 'work_unavailable' }, 501)
      return next()
    })
    app.use('/api/work/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!diagnostics.has(c.req.raw) && !await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions.alignment) return c.json({ error: 'work_unavailable' }, 501)
      return next()
    })
    app.get('/api/work', c => c.json(projectWorkOverview(sessions, github(), observer?.())))
    // Historical decisions are read on expansion, not on every live overview refresh.
    app.get('/api/work-history', async c => {
      if (!diagnostics.has(c.req.raw) && !await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      c.header('Cache-Control', 'no-store')
      const sessionId = c.req.query('sessionId')
      const state = sessionId ? sessions.getSessionState(sessionId) : null
      if (!state) return c.json({ error: 'session_not_found' }, 404)
      const records = [], errors: string[] = []
      let truncated = state.segmentIndex >= 20
      for (let index = state.segmentIndex; index >= Math.max(0, state.segmentIndex - 19); index--) {
        try { records.push(...await sessions.getYieldRecords(state.sessionId, physicalSessionId(state, index))) }
        catch { errors.push(physicalSessionId(state, index)) }
      }
      records.sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt))
      truncated ||= records.length > 100
      return c.json({ records: records.slice(0, 100), errors, truncated })
    })
    app.post('/api/work/organize', async c => {
      const correlationId = diagnostics.get(c.req.raw)!
      const diagnostic = (stage: string, code: string) => ({ correlationId, stage, code })
      if (!organize) {
        console.error('[work-organization]', diagnostic('availability', 'organization_unavailable'))
        return c.json({ error: 'organization_unavailable', stage: 'availability', correlationId }, 501)
      }
      try { z.object({}).strict().parse(await c.req.json()) }
      catch {
        console.error('[work-organization]', diagnostic('validation', 'invalid_request'))
        return c.json({ error: 'invalid_request', stage: 'validation', correlationId, message: 'Send an empty JSON object.' }, 400)
      }
      let stage = 'organization'
      try {
        console.info('[work-organization]', diagnostic(stage, 'organization_started'))
        await organize(c.req.raw.signal)
        stage = 'overview'
        const overview = projectWorkOverview(sessions, github(), observer?.())
        console.info('[work-organization]', diagnostic('complete', 'organization_succeeded'))
        return c.json(overview)
      } catch (error) {
        if (error instanceof WorkConflict) {
          const code = error instanceof OrganizationConflict ? error.code : 'work_conflict'
          console.error('[work-organization]', diagnostic(stage, code))
          return c.json({ error: code, stage, correlationId, message: 'Organization is unavailable, already queued, or has no recorded topics. Previous results were kept.' }, 409)
        }
        const code = stage === 'overview' ? 'organization_refresh_failed'
          : error instanceof ObserverOutputError ? error.code
          : c.req.raw.signal.aborted || error instanceof Error && error.name === 'TimeoutError' ? 'organization_cancelled'
          : 'organization_failed'
        // Never log provider messages, JSON output, Zod values or conversation evidence.
        console.error('[work-organization]', diagnostic(stage, code))
        return c.json({ error: code, stage, correlationId, message: stage === 'overview'
          ? 'Organization finished, but the overview could not be loaded. Refresh the page.'
          : 'Organization could not finish. Previous results were kept.' }, 502)
      }
    })
    app.get('/api/work/:key', c => {
      const key = c.req.param('key')
      if (!sessions.alignment!.store.workRecords().some(record => record.key === key)) return c.json({ error: 'work_not_found' }, 404)
      return c.json(sessions.alignment!.inspect(key, c.req.query('history') === '1'))
    })
    app.post('/api/work/:key', async c => {
      const key = c.req.param('key')
      if (!sessions.alignment!.store.workRecords().some(record => record.key === key)) return c.json({ error: 'work_not_found' }, 404)
      try {
        const body = humanWorkActionSchema.parse(await c.req.json())
        if (body.action === 'create' || body.key !== key) return c.json({ error: 'invalid_request', message: 'Use the exact existing work key.' }, 400)
        await applyHumanWorkAction(sessions, body, c.req.raw.signal)
        return c.json(sessions.alignment!.inspect(key))
      } catch (error) {
        if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
        if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
          return c.json({ error: 'invalid_request', message: error.message }, 400)
        }
        if (error instanceof WorkConflict) return c.json({ error: 'work_conflict', message: error.message }, 409)
        throw error
      }
    })
  }
}
