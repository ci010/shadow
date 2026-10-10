import { z } from 'zod'
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
  observer?: () => ProjectWorkOverview['observer']): GatewayPlugin {
  return app => {
    app.use('/api/work', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions.alignment) return c.json({ error: 'work_unavailable' }, 501)
      return next()
    })
    app.use('/api/work/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions.alignment) return c.json({ error: 'work_unavailable' }, 501)
      return next()
    })
    app.get('/api/work', c => c.json(projectWorkOverview(sessions, github(), observer?.())))
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
