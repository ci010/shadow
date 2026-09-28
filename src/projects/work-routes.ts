import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { WorkConflict } from '../initiatives/work-contract.ts'
import { FolderError } from '../folders/registry.ts'
import { projectWorkOverviewSchema, type ProjectWorkOverview, type ProjectWorkItem } from './work-overview.ts'

export const humanWorkActionSchema = z.object({
  action: z.enum(['create', 'update', 'apply_proposal', 'assign', 'manage', 'progress', 'dependencies', 'transition', 'settle', 'request_checkpoint']),
  key: z.string().optional(), revision: z.number().int().positive().optional(), data: z.unknown().optional(),
}).strict()

export async function applyHumanWorkAction(sessions: SessionManager, body: z.infer<typeof humanWorkActionSchema>, signal: AbortSignal) {
  const alignment = sessions.alignment
  if (!alignment) throw new WorkConflict('Work is unavailable.')
  signal.throwIfAborted()
  if (body.action !== 'request_checkpoint') {
    await alignment.execute({ kind: 'user' }, body.action, body.key, body.revision, body.data, signal)
    return
  }
  if (!body.key) throw new WorkConflict('A work key is required.')
  const record = alignment.get(body.key)
  if (body.revision !== record.revision) throw new WorkConflict('Work revision changed.')
  const target = alignment.store.workAuthority(record.subject).executor
  if (!target) throw new WorkConflict('No executor is assigned.')
  sessions.assertFolderAccess(target)
  await sessions.deliver(target, {
    kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), policy: 'steering',
    source: { kind: 'event', eventId: record.key, type: 'work-checkpoint-request', source: 'human-work-review' },
    content: `The human requests a factual checkpoint for ${record.key} revision ${record.revision}. At a safe boundary record completed work, artifacts, inFlight, unknown and retired premises with work action=checkpoint, then end the turn. Do not start new external work, claim cancellation, or change assignments.`,
  })
}

export function projectWorkOverview(sessions: SessionManager, github: Record<string, ProjectWorkItem['github']> = {}): ProjectWorkOverview {
  const alignment = sessions.alignment
  if (!alignment) throw new WorkConflict('Work is unavailable.')
  const states = sessions.listSessions()
  return projectWorkOverviewSchema.parse({
    items: alignment.store.workRecords().map(record => {
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
        github: github[record.key],
      }
    }),
    sessions: states.map(state => ({ sessionId: state.sessionId, title: state.name || state.sessionId,
      assignable: (state.mode ?? 'session') === 'session' })),
    requests: states.flatMap(state => {
      const input = sessions.inputs.get(state.sessionId)
      const decision = sessions.yields.get(state.sessionId)
      const request = input ?? decision
      return request?.recipient.kind === 'user' ? [{
        id: request.id, sessionId: state.sessionId, kind: input ? 'input' as const : 'decision' as const,
        question: request.question, workKeys: decision?.workStamps?.map(stamp => stamp.key) ?? [],
      }] : []
    }),
    effects: alignment.store.workEffects().map(effect => ({
      id: effect.id, sessionId: effect.sessionId, tool: effect.tool, status: effect.status,
      workKeys: effect.stamps.map(stamp => stamp.key),
    })),
  })
}

export function projectWorkPlugin(sessions: SessionManager, authorize: (request: Request) => boolean | Promise<boolean>,
  github: () => Record<string, ProjectWorkItem['github']> = () => ({})): GatewayPlugin {
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
    app.get('/api/work', c => c.json(projectWorkOverview(sessions, github())))
    app.get('/api/work/:key', c => {
      const key = c.req.param('key')
      if (!sessions.alignment!.store.workRecords().some(record => record.key === key)) return c.json({ error: 'work_not_found' }, 404)
      return c.json(sessions.alignment!.inspect(key))
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
