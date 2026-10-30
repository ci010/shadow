import { projectUsagePageQuerySchema } from '../projects/usage-contract.ts'
import { SessionProfileService } from './profile.ts'
import type { Hono } from 'hono'
import { channelAddressFromSessionId } from '../bus/events.ts'
import { delegationOwner } from './execution-scope.ts'
import { parseSessionName, SessionNameError } from './session-name.ts'
import type { SessionManager } from './session-manager.ts'
import { isConfigObject, parseSessionConfigPatch } from './config-patch.ts'
import { YieldError } from './yield.ts'
import { answerMediaSchema } from './answer-media.ts'
import { validateAnswerUploads } from './answer-attachments.ts'
import { z } from 'zod'
import { WorkConflict } from '../initiatives/work-contract.ts'
import { applyHumanWorkAction, humanWorkActionSchema } from '../projects/work-routes.ts'
import { parseYieldReference } from './yield-contract.ts'
import { SessionResumeError } from './recovery.ts'
import type { SessionRecovery } from './session-store.ts'
import { FolderError } from '../folders/registry.ts'
import { isLearningAutomationSession } from './session-purpose.ts'
import { resolveAutomationSession } from '../cron/contracts.ts'
import { cronContextMode, type CronService } from '../cron/service.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { physicalSessionId, SessionIdentityError } from './session-identity.ts'
import {
  resolveSessionLocations,
  managedSessionWorkdirRef,
  type SessionLocalityState,
  type WorkdirCapabilityLookup,
  type WorkdirResolution,
  type WorkdirUnavailableReason,
} from './locality.ts'
import { extname, resolve } from 'node:path'
import { serveLocalFiles, staticFilePath } from '../gateway/local-files.ts'
import { fileSearchQuery, remoteFileSearchResult, serveLocalFileSearch } from '../gateway/file-search.ts'
import { filePreviewLimit } from '../execution/filesystem/contracts.ts'
import { isTextEncoding } from '../execution/filesystem/text-encoding.ts'
import { serveLocalGit } from '../gateway/local-git.ts'
import { serveRemoteGit } from '../gateway/remote-git.ts'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import {
  executeRemoteFilesystemText,
  RemoteFilesystemError,
} from '../execution/remote-filesystem-client.ts'

export type WorkdirUnavailableAction =
  | 'connect_node'
  | 'select_workdir_capability'
  | 'upgrade_node'

export interface WorkdirUnavailableApiResult {
  error: 'workdir_unavailable'
  key: string
  nodeId: string
  capabilityId: string
  reason: WorkdirUnavailableReason
  action: WorkdirUnavailableAction
}

export interface RemoteWorkdirRequiresExecutorApiResult {
  error: 'remote_workdir_requires_executor'
  key: string
  nodeId: string
  capabilityId: string
}

export function resolveSessionFileBase(
  workspace: string,
  key: string,
  state?: SessionLocalityState,
  workdirCapabilityLookup?: WorkdirCapabilityLookup,
): WorkdirResolution {
  return resolveSessionLocations(
    workspace,
    state ?? { sessionId: key },
    undefined,
    workdirCapabilityLookup,
  ).workdir
}

export function workdirUnavailableApiResult(
  key: string,
  resolution: Extract<WorkdirResolution, { available: false }>,
): WorkdirUnavailableApiResult {
  const action: WorkdirUnavailableAction = resolution.reason === 'incompatible'
    ? 'upgrade_node'
    : resolution.reason === 'capability-missing' ||
        resolution.reason === 'capability-revoked'
    ? 'select_workdir_capability'
    : 'connect_node'

  return {
    error: 'workdir_unavailable',
    key,
    nodeId: resolution.workdir.nodeId,
    capabilityId: resolution.workdir.capabilityId,
    reason: resolution.reason,
    action,
  }
}

function remoteWorkdirRequiresExecutorApiResult(
  key: string,
  resolution: Extract<
    WorkdirResolution,
    { available: true; locality: 'remote' }
  >,
): RemoteWorkdirRequiresExecutorApiResult {
  return {
    error: 'remote_workdir_requires_executor',
    key,
    nodeId: resolution.workdir.nodeId,
    capabilityId: resolution.workdir.capabilityId,
  }
}

export function normalizeRemoteWorkspacePath(input: string): string | null {
  if (input.includes('\0')) return null
  const cleaned = input.replaceAll('\\', '/').replace(/^\/+/, '')
  if (cleaned.split('/').includes('..')) return null
  return cleaned || '.'
}

function remoteFilesystemStatus(error: RemoteFilesystemError): 400 | 404 | 503 {
  if (error.code === 'file-not-found') return 404
  if (
    error.code === 'path-denied' ||
    error.code === 'invalid-filesystem-args' ||
    error.code === 'file-type-denied'
  ) return 400
  return 503
}

async function sessionFileBase(
  sessions: SessionManager,
  key: string,
  managed = false,
): Promise<WorkdirResolution & { scope?: 'home' }> {
  const state = await sessions.readSessionState(key)
  if (managed && state) {
    const locations = resolveSessionLocations(sessions.workspace, state, undefined, sessions.workdirCapabilityLookup)
    // Explicit session storage is Main-local, independently of execution workdir locality.
    return { available: true, locality: 'local', workdir: managedSessionWorkdirRef(state.workspaceRoot ?? key), path: locations.sessionDataDir }
  }
  const base = resolveSessionFileBase(
    sessions.workspace,
    key,
    state ?? undefined,
    sessions.workdirCapabilityLookup,
  )
  if (!state || !base.available || base.locality !== 'local') return base
  const visited = new Set<string>()
  let ancestor: string | undefined = key
  while (ancestor && !visited.has(ancestor)) {
    visited.add(ancestor)
    const ancestorState = await sessions.readSessionState(ancestor)
    if (!ancestorState) break
    if (isLearningAutomationSession(ancestorState)) {
      // This is a browsing root, not a change to the agent's execution workdir.
      return { ...base, path: resolve(sessions.workspace), scope: 'home' }
    }
    if (resolveAutomationSession(ancestorState)) break
    ancestor = Object.hasOwn(ancestorState, 'parentSessionId')
      ? ancestorState.parentSessionId ?? undefined : ancestorState.parent?.id
  }
  return base
}

/**
 * Gateway plugin exposing read-only session inspection endpoints.
 *
 * - `GET  /api/sessions`       — list all logical sessions
 * - `GET  /api/sessions/graph` — session graph with parent-child edges
 * - `GET  /api/sessions/:key/details` — read-only identity, workdir, and usage
 * - `POST /api/sessions/:key/cancel` — request abort of the current turn (not queued inputs)
 * - `POST /api/sessions/:key/resume` — explicitly continue a matching recovery from saved history
 * - `GET  /api/sessions/:key/files`   — list a directory in the session workspace
 * - `GET  /api/sessions/:key/raw`     — raw file bytes (image/video/audio previews)
 * - `GET  /api/sessions/:key/static/*`— static file serving (HTML pages + relative assets)
 * - `GET  /api/sessions/:key/preview` — truncated text preview of a file
 * - `GET  /api/sessions/:key/git/status` — scoped HEAD/index/workdir changes
 * - `GET  /api/sessions/:key/git/diff` — bounded HEAD-to-workdir text diff
 * - `GET  /api/sessions/:key`  — paginated history for a session
 */
export function sessionsApiPlugin(
  sessions: SessionManager | undefined,
  options: {
    cron?: Pick<CronService, 'listJobs'>
    backgroundTasks?: Pick<BackgroundTaskManager, 'listTasks'>
    authorizeContext?: (request: Request) => boolean | Promise<boolean>
    authorizeRename?: (request: Request) => boolean | Promise<boolean>
    authorizeOwnerDecision?: (request: Request) => boolean | Promise<boolean>
  } = {},
): GatewayPlugin {
  return (app: Hono) => {
    const authorizeOwnerQuestion: Parameters<Hono['use']>[1] = async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && sessions?.yields.get(c.req.param('key') ?? '')?.ownerOnly &&
        !await options.authorizeOwnerDecision?.(c.req.raw)) {
        return c.json({ error: 'unauthorized', message: 'Project owner access is required for this host confirmation.' }, 401)
      }
      await next()
    }
    app.use('/api/sessions/:key/ask', authorizeOwnerQuestion)
    app.use('/api/sessions/:key/ask/*', authorizeOwnerQuestion)
    app.use('/api/sessions/:key/*', async (c, next) => {
      if (c.req.path.endsWith('/context')) {
        c.header('Cache-Control', 'no-store')
        if (options.authorizeContext && !await options.authorizeContext(c.req.raw)) {
          return c.json({ error: 'unauthorized' }, 401)
        }
      }
      if (!c.req.path.slice('/api/sessions/'.length).includes('/')) return next()
      const key = c.req.param('key') ?? ''
      const historicalRead = c.req.method === 'GET' || c.req.method === 'HEAD'
      if ((sessions?.projectId || /^\/api\/sessions\/[^/]+\/workspace\//.test(c.req.path)) && sessions && !(historicalRead ? await sessions.readSessionState(key) : sessions.getSessionState(key))) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const suffix = c.req.path.slice('/api/sessions/'.length)
      if (sessions && (/\/(?:files|raw|preview|static|git)(?:\/|$)/.test(suffix) ||
        c.req.method !== 'GET' || suffix.endsWith('/context'))) {
        try { if (historicalRead) await sessions.assertHistoricalFolderAccess(key); else sessions.assertFolderAccess?.(key) }
        catch (error) {
          if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
          throw error
        }
      }
      return next()
    })
    for (const operation of ['status', 'diff'] as const) {
      for (const fileRoute of [`/api/sessions/:key/git/${operation}`, `/api/sessions/:key/workspace/git/${operation}`]) app.get(fileRoute, async c => {
        if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
        const key = c.req.param('key')!
        const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
        if (!base.available) return c.json(workdirUnavailableApiResult(key, base), 503)
        if (base.locality === 'remote') {
          if (!sessions.remoteExecutor) return operation === 'status'
            ? c.json({ available: false, reason: 'remote_unsupported', entries: [] })
            : c.json({ error: 'remote_unsupported', message: 'Remote Git requires a connected executor. No local folder was used.' }, 501)
          return serveRemoteGit(c, {
            executor: sessions.remoteExecutor, nodeId: base.workdir.nodeId, capabilityId: base.workdir.capabilityId,
            sessionId: key, turnId: `session-git:${crypto.randomUUID()}`, signal: c.req.raw.signal,
          }, operation)
        }
        return serveLocalGit(c, base.path, operation, base.scope)
      })
    }
    app.get('/api/sessions', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = (await sessions.listHistorySessions()).filter(session => session.agentType !== 'work-observer')
      return c.json({ sessions: list })
    })

    app.get('/api/sessions/graph', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = (await sessions.listHistorySessions()).filter(session => session.agentType !== 'work-observer')

      const nodes: Array<{
        projectId?: string
        mode: string
        agentType: string
        parentSessionId: string | null
        executionId?: string
        executionStatus: string
        physicalId: string
        logicalId: string
        folderId?: string
        parentPhysicalId: string | null
        parentIndex: number | null
        isCurrent: boolean
        timestamp: string | null
      }> = []

      // Only enabled schedules delivering to this conversation count; fresh jobs
      // belong to their runs, not the conversation that created them.
      const cronTargets = new Set(options.cron?.listJobs()
        .filter(job => job.enabled !== false && cronContextMode(job) === 'existing')
        .map(job => job.target?.sessionId))
      const backgroundOwners = new Set(options.backgroundTasks?.listTasks()
        .filter(task => task.status === 'running' || task.status === 'cancelling')
        .map(task => task.sessionId))
      const enrichedSessions = []
      for (const session of list) {
        const state = await sessions.readSessionState(session.sessionId)
        const execution = {
          mode: state?.mode ?? 'session',
          agentType: state?.agentType ?? 'general',
          sessionKind: state?.sessionKind,
          description: state?.description ?? (state?.topic ? [state.topic.goal, state.topic.scope, state.topic.nonGoals].filter(Boolean).join('\n') : undefined),
          createdBySessionId: state?.createdBySessionId,
          initiativeId: state?.initiativeId,
          parentSessionId: delegationOwner(state) ?? null,
          waitingForCall: !!sessions.isWaitingForCall?.(session.sessionId),
          executionId: state?.executionId,
          parentToolCallId: state?.parentToolCallId,
          executionStatus: sessions.isWaitingForCall?.(session.sessionId) || sessions.yields.get(session.sessionId) || sessions.inputs.get(session.sessionId)
            ? 'waiting' : state?.executionStatus ?? (state?.lastActivityAt ? 'completed' : 'pending'),
        }
        const firstMsg = await sessions.getFirstUserMessage(session.sessionId)
        let inferenceDefaults: ReturnType<SessionManager['getSessionInferenceDefaults']> | null
        if (state && execution.mode === 'session') {
          try {
            inferenceDefaults = sessions.getSessionInferenceDefaults(session.sessionId)
          } catch (error) {
            console.error(`[sessions] Cannot resolve inference defaults for ${session.sessionId}:`, error)
            inferenceDefaults = null
          }
        }
        const automation = state ? resolveAutomationSession(state) : undefined
        enrichedSessions.push({
          ...session,
          ...execution,
          automation,
          completed: state?.completed ?? false,
          hasCron: cronTargets.has(session.sessionId),
          hasBackgroundTasks: backgroundOwners.has(session.sessionId),
          title: automation?.config?.source === 'system' ? automation.name : state?.name ?? state?.topic?.title ?? state?.generatedTitle ?? state?.chatName ?? (execution.mode !== 'session' ? state?.description ?? firstMsg ?? undefined : firstMsg ?? undefined),
          description: state?.description ?? undefined,
          config: state?.config ?? undefined,
          inferenceDefaults,
          lastActivityAt: state?.lastActivityAt ?? session.lastActivityAt ??
            null,
        })
        for (let i = 0; i <= session.segmentIndex; i++) {
          const physicalId = physicalSessionId(state ?? session, i)
          const parentPhysicalId = state?.parent?.physicalId ??
            null
          nodes.push({
            ...execution,
            ...(state?.projectId ? { projectId: state.projectId } : {}),
            physicalId,
            logicalId: session.sessionId,
            folderId: state?.folderId,
            parentPhysicalId,
            parentIndex: state?.parent?.index ?? null,
            isCurrent: i === session.segmentIndex,
            timestamp: state?.lastActivityAt ?? null,
          })
        }
      }

      return c.json({ sessions: enrichedSessions, nodes })
    })

    app.get('/api/sessions/:key/file-changes', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const query = z.object({
        offset: z.coerce.number().int().nonnegative().safe().default(0),
        limit: z.coerce.number().int().min(1).max(30).default(30),
        toolCallId: z.string().min(1).max(4096).optional(),
      }).safeParse({ offset: c.req.query('offset'), limit: c.req.query('limit'), toolCallId: c.req.query('toolCallId') })
      if (!query.success) return c.json({ error: 'invalid_file_changes_query', message: 'Use a nonnegative offset, a limit between 1 and 30, and a nonempty toolCallId of at most 4096 characters when filtering.' }, 400)
      const page = await sessions.getFileChanges(c.req.param('key'), query.data.offset, query.data.limit, c.req.raw.signal, query.data.toolCallId)
      return page ? c.json(page) : c.json({ error: 'session_not_found' }, 404)
    })

    app.get('/api/project/usage/daily', async c => {
      c.header('Cache-Control', 'no-store')
      if (!options.authorizeContext || !await options.authorizeContext(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions?.projectId) return c.json({ error: 'project_not_found' }, 404)
      const query = projectUsagePageQuerySchema.safeParse(c.req.query())
      if (!query.success) return c.json({ error: 'invalid_usage_page' }, 400)
      return c.json(await sessions.getProjectUsagePage(query.data.page, c.req.raw.signal))
    })

    app.get('/api/project/usage', async c => {
      c.header('Cache-Control', 'no-store')
      if (!options.authorizeContext || !await options.authorizeContext(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions?.projectId) return c.json({ error: 'project_not_found' }, 404)
      return c.json(await sessions.getProjectUsage(c.req.raw.signal))
    })

    app.get('/api/sessions/:key/profile', async c => {
      c.header('Cache-Control', 'no-store')
      if (options.authorizeContext && !await options.authorizeContext(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions?.projectId) return c.json({ error: 'session_not_found' }, 404)
      const profile = await new SessionProfileService(sessions, sessions.projectId).query(c.req.param('key'), c.req.raw.signal)
      return profile ? c.json(profile) : c.json({ error: 'session_not_found' }, 404)
    })

    app.get('/api/sessions/:key/details', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      const details = await sessions.getSessionDetails(key, c.req.query('physicalId'))
      return details
        ? c.json(details)
        : c.json({ error: 'session_not_found', key }, 404)
    })

    app.post('/api/sessions/:key/cancel', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      let body: unknown = {}
      if (c.req.raw.body) {
        try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      }
      if (!isConfigObject(body) || Object.keys(body).some(key => key !== 'requestId')
        || ('requestId' in body && (typeof body.requestId !== 'string' || !body.requestId))) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      const active = sessions.getActiveSession(key)
      if (!active || active.phase === 'idle') return c.json({ sessionId: key, status: 'idle' })
      if (body.requestId && (!('activeRequestId' in active) || active.activeRequestId !== body.requestId)) {
        return c.json({ error: 'request_not_active', sessionId: key }, 409)
      }
      active.cancel()
      return c.json({ sessionId: key, status: 'requested' })
    })

    app.post('/api/sessions/:key/resume', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      if (!isConfigObject(body) || Object.keys(body).some(key => !['recoveryId', 'acknowledgeToolReplay'].includes(key))
        || typeof body.recoveryId !== 'string' || !body.recoveryId
        || (body.acknowledgeToolReplay !== undefined && typeof body.acknowledgeToolReplay !== 'boolean')) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      try {
        const receipt = await sessions.resumeSession(key, body.recoveryId, body.acknowledgeToolReplay === true)
        return c.json({ sessionId: key, recoveryId: body.recoveryId, requestId: receipt.inputId, status: 'accepted' }, 202)
      } catch (error) {
        if (error instanceof SessionIdentityError) return c.json({ error: 'history_conflict', message: error.message }, 409)
        return c.json({
          error: error instanceof SessionResumeError ? 'recovery_conflict' : 'resume_failed',
          message: error instanceof Error ? error.message : 'Could not continue this conversation.',
        }, error instanceof SessionResumeError ? 409 : 500)
      }
    })

    app.get('/api/sessions/:key/ask', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!await sessions.readSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      return c.json({ request: sessions.inputs.get(key) ?? sessions.yields.get(key) })
    })

    app.get('/api/sessions/:key/work', async c => {
      if (!sessions?.alignment) return c.json({ error: 'work_unavailable' }, 501)
      const id = c.req.param('key')
      if (!await sessions.readSessionState(id)) return c.json({ error: 'session_not_found' }, 404)
      await sessions.assertHistoricalFolderAccess(id)
      return c.json(sessions.alignment.context(id, undefined, c.req.query('history') === '1'))
    })

    app.post('/api/sessions/:key/work', async c => {
      if (!sessions?.alignment) return c.json({ error: 'work_unavailable' }, 501)
      const id = c.req.param('key')
      if (!sessions.getSessionState(id)) return c.json({ error: 'session_not_found' }, 404)
      sessions.assertFolderAccess(id)
      try {
        const body = humanWorkActionSchema.parse(await c.req.json())
        const visible = sessions.alignment.records(id)
        if (body.action === 'create') {
          const data = z.object({ title: z.string(), parentKey: z.string().optional(), definition: z.unknown(),
            notes: z.unknown().optional(), reason: z.string().optional() }).strict().parse(body.data)
          if (data.parentKey && !visible.some(record => record.key === data.parentKey)) return c.json({ error: 'forbidden' }, 403)
          body.data = { ...data, assignee: id }
        } else if (!visible.some(record => record.key === body.key)) return c.json({ error: 'forbidden' }, 403)
        await applyHumanWorkAction(sessions, body, c.req.raw.signal)
        return c.json(sessions.alignment.context(id))
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
          return c.json({ error: 'invalid_request', message: error.message }, 400)
        }
        if (error instanceof WorkConflict) return c.json({ error: 'work_conflict', message: error.message }, 409)
        throw error
      }
    })

    app.get('/api/sessions/:key/decisions', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      try {
        return c.json({ records: await sessions.getYieldRecords(c.req.param('key'), c.req.query('physicalId')) })
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404 : 503)
      }
    })

    app.get('/api/sessions/:key/decisions/context', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      try { return c.json(await sessions.decisionContext(c.req.param('key'))) }
      catch (error) {
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404 : 503)
      }
    })

    app.get('/api/sessions/:key/decisions/owner', c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      try { return c.json(sessions.decisionOwners(c.req.param('key'))) }
      catch (error) {
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, 404)
      }
    })

    app.post('/api/sessions/:key/decisions/owner', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const body: unknown = await c.req.json().catch(() => null)
      if (!isConfigObject(body) || Object.keys(body).length !== 1 || typeof body.reportingSessionId !== 'string') return c.json({ error: 'invalid_request' }, 400)
      try {
        await sessions.setDecisionOwner(c.req.param('key'), body.reportingSessionId)
        return c.json(sessions.decisionOwners(c.req.param('key')))
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'conflict' ? 409 : 400)
      }
    })

    app.post('/api/sessions/:key/ask/follow-up', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const body: unknown = await c.req.json().catch(() => null)
      if (!isConfigObject(body) || Object.keys(body).some(key => !['requestId', 'kind', 'reason'].includes(key))
        || typeof body.requestId !== 'string' || typeof body.reason !== 'string'
        || (body.kind !== 'investigation' && body.kind !== 'deferred')) return c.json({ error: 'invalid_request' }, 400)
      try {
        return c.json({ continuation: await sessions.yields.continueUser(c.req.param('key'), body.requestId, body.kind, body.reason) })
      } catch (error) {
        if (error instanceof TypeError) return c.json({ error: 'invalid_request', message: error.message }, 400)
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 409)
      }
    })

    app.post('/api/sessions/:key/decisions/invalidate', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const body: unknown = await c.req.json().catch(() => null)
      if (!isConfigObject(body) || Object.keys(body).some(key => !['reference', 'reason'].includes(key)) || typeof body.reason !== 'string') return c.json({ error: 'invalid_request' }, 400)
      try {
        const reference = parseYieldReference(body.reference)
        if (reference.sessionId !== c.req.param('key')) return c.json({ error: 'forbidden' }, 403)
        return c.json(await sessions.invalidateDecision(reference, body.reason))
      } catch (error) {
        if (error instanceof TypeError) return c.json({ error: 'invalid_request', message: error.message }, 400)
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404 : 409)
      }
    })

    app.get('/api/sessions/:key/decisions/reviews', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const physicalId = c.req.query('physicalId')
      const requestId = c.req.query('requestId')
      if (!physicalId || !requestId) return c.json({ error: 'invalid_request' }, 400)
      try {
        return c.json({ reviews: await sessions.yieldDiscussions.read({ sessionId: c.req.param('key'), physicalId, requestId }) })
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404 : 503)
      }
    })

    app.post('/api/sessions/:key/ask/reviews', async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      if (!isConfigObject(body) || Object.keys(body).some(key => !['requestId', 'id', 'kind', 'question'].includes(key))
        || typeof body.requestId !== 'string' || typeof body.id !== 'string' || typeof body.question !== 'string'
        || (body.kind !== 'clarify' && body.kind !== 'revise')) return c.json({ error: 'invalid_request' }, 400)
      try {
        return c.json({ review: await sessions.yieldDiscussions.start(c.req.param('key'), body.requestId, body.id, body.kind, body.question) }, 202)
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409
          : error.code === 'invalid_request' ? 400 : 503
        return c.json({ error: error.code, message: error.message }, status)
      }
    })

    app.on(['POST', 'DELETE'], '/api/sessions/:key/ask', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      const cancel = c.req.method === 'DELETE'
      let answerMedia: string[] | undefined
      if (isConfigObject(body) && body.media !== undefined) {
        const parsed = answerMediaSchema.safeParse(body.media)
        if (cancel || !parsed.success || typeof body.option === 'string') return c.json({ error: 'invalid_request', message: 'Attachments require a custom answer.' }, 400)
        const state = sessions.getSessionState(key)!
        const { workdir } = resolveSessionLocations(sessions.workspace, state, undefined, sessions.workdirCapabilityLookup)
        if (!key.startsWith('web:') || !workdir.available || workdir.locality === 'remote') {
          return c.json({ error: 'invalid_request', message: 'Answer attachments require a local web conversation.' }, 400)
        }
        try { await validateAnswerUploads(sessions.workspace, state.workspaceRoot ?? key, parsed.data, c.req.raw.signal) }
        catch (error) {
          if (!(error instanceof TypeError)) throw error
          return c.json({ error: 'invalid_request', message: error.message }, 400)
        }
        answerMedia = parsed.data
      }
      if (isConfigObject(body) && typeof body.requestId === 'string' && sessions.inputs.has(body.requestId)) {
        if (Object.keys(body).some(key => key !== 'requestId' && (cancel || (key !== 'text' && key !== 'media'))) || !cancel && typeof body.text !== 'string') {
          return c.json({ error: 'invalid_request', message: 'Supply requestId and text for an input reply.' }, 400)
        }
        try {
          if (cancel) {
            await sessions.inputs.cancelUser(key, body.requestId)
            sessions.getActiveSession(key)?.cancel()
            return c.json({ cancelled: true })
          }
          if (typeof body.text !== 'string') return c.json({ error: 'invalid_request' }, 400)
          return c.json({ answer: await sessions.inputs.replyUser(key, body.requestId, body.text, undefined, undefined, answerMedia) })
        } catch (error) {
          if (!(error instanceof YieldError)) throw error
          return c.json({ error: error.code, message: error.message }, error.code === 'not_found' ? 404
            : error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409 : error.code === 'invalid_request' ? 400 : 503)
        }
      }
      if (!isConfigObject(body) || Object.keys(body).some(key => key !== 'requestId' && (cancel || (key !== 'option' && key !== 'customText' && key !== 'media')))
        || typeof body.requestId !== 'string' || !body.requestId
        || (!cancel && (Object.hasOwn(body, 'option') === Object.hasOwn(body, 'customText')
          || (Object.hasOwn(body, 'option') ? typeof body.option !== 'string' : typeof body.customText !== 'string')))) {
        return c.json({ error: 'invalid_request', message: cancel ? 'Supply the current requestId.' : 'Supply requestId and exactly one of option or customText.' }, 400)
      }
      try {
        if (cancel) {
          const ownerOnly = sessions.yields.userRequestSnapshot(key, body.requestId).ownerOnly
          await sessions.yields.cancelUser(key, body.requestId)
          if (!ownerOnly) sessions.getActiveSession(key)?.cancel()
          return c.json({ cancelled: true })
        }
        if (typeof body.customText === 'string') {
          return c.json({ answer: await sessions.yields.answerUserText(key, body.requestId, body.customText, answerMedia) })
        }
        if (typeof body.option !== 'string') return c.json({ error: 'invalid_request' }, 400)
        return c.json({ answer: await sessions.yields.answerUser(key, body.requestId, body.option) })
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403
          : error.code === 'conflict' ? 409 : error.code === 'unavailable' ? 503 : 400
        return c.json({ error: error.code, message: error.message }, status)
      }
    })

    app.patch('/api/sessions/:key/name', async c => {
      if (options.authorizeRename && !await options.authorizeRename(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      if (!isConfigObject(body) || Object.keys(body).some(key => key !== 'name')) {
        return c.json({ error: 'invalid_request', message: 'Supply only the session name.' }, 400)
      }
      try {
        const name = await sessions.renameSession(key, parseSessionName(body.name))
        return c.json({ sessionId: key, name })
      } catch (error) {
        if (error instanceof SessionNameError) return c.json({ error: 'invalid_name', message: error.message }, 400)
        console.error('[sessions] Rename failed', error)
        return c.json({ error: 'rename_failed', message: 'Could not save the session name. Retry.' }, 500)
      }
    })

    // ── PATCH /api/sessions/:key/config — update per-session config ──
    app.patch('/api/sessions/:key/config', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const state = await sessions.getSessionState(key)
      if (!state) {
        return c.json({ error: 'session_not_found', key }, 404)
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }

      let patch
      try {
        patch = parseSessionConfigPatch(body, true)
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return c.json({ error: error.message }, 400)
      }
      await sessions.applySessionConfigPatch(key, patch)

      return c.json({ key, config: sessions.getSessionConfig(key) })
    })

    app.get('/api/sessions/:key/context', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const view = c.req.query('view')
      if ((c.req.queries('view')?.length ?? 0) > 1 ||
        (view !== undefined && view !== 'preview' && view !== 'captured')) {
        return c.json({ error: 'invalid_context_view', message: 'Use view=preview or view=captured, or omit view for current context.' }, 400)
      }
      try {
        if (view === 'captured') {
          if (!options.authorizeContext) return c.json({ error: 'prompt_capture_authorization_unavailable' }, 403)
          if (!await sessions.readSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
          const captures = sessions.getPromptCaptures(key)
          if (!captures) return c.json({ error: 'prompt_capture_disabled' }, 404)
          return c.json({
            key, source: 'captured', boundary: 'provider-input',
            captures,
            status: sessions.getPromptCaptureStatus(key),
            note: 'Actual provider.chat inputs before adapter transformations, not HTTP wire. Inspect scope/payload/omissions: ordinary debug records system and tools only; opted-in learning audit records inference messages with explicit media omissions. Empty is not evidence of capture; see status.',
          })
        }
        if (!sessions.getSessionState(key)) return c.json({ error: 'archived_context_unavailable', key,
          message: 'Archived executions have no live prompt context. Read their persisted history or retained captures.' }, 409)
        const result = await sessions.getContext({ sessionId: key, preview: view === 'preview' })
        if (!result) {
          return c.json({ error: 'session_not_found', key }, 404)
        }
        return c.json({
          key,
          source: result.source,
          systemPrompt: result.systemPrompt,
          tools: result.tools,
          ...(result.sections ? { sections: result.sections } : {}),
          note: result.source === 'preview'
            ? 'Rebuilt from current session configuration; per-input identity and historical provider requests are not reconstructed.'
            : 'Current in-memory system message and tool definitions, not a captured provider request.',
        })
      } catch (err) {
        return c.json({
          error: 'context_retrieval_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    })

    // ── Session workspace file browsing ────────────────────────────────
    for (const fileRoute of ['/api/sessions/:key/files/search', '/api/sessions/:key/workspace/files/search']) app.get(fileRoute, async c => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')!
      const query = fileSearchQuery(c)
      if (!query) return c.json({ error: 'invalid_query' }, 400)
      const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
      if (!base.available) return c.json(workdirUnavailableApiResult(key, base), 503)
      if (base.locality === 'local') return serveLocalFileSearch(c, base.path)
      if (!sessions.remoteExecutor) return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      try {
        const output = await executeRemoteFilesystemText({
          executor: sessions.remoteExecutor,
          nodeId: base.workdir.nodeId,
          capabilityId: base.workdir.capabilityId,
          sessionId: key,
          turnId: `session-file-search:${crypto.randomUUID()}`,
          signal: c.req.raw.signal,
        }, FILESYSTEM_READ_OPERATION, { path: '.', query })
        return c.json(remoteFileSearchResult(output))
      } catch (error) {
        if (error instanceof RemoteFilesystemError) return c.json({
          error: 'remote_file_search_failed', message: error.message,
        }, remoteFilesystemStatus(error))
        if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
        return c.json({ error: 'invalid_remote_search_result', message: 'The owning node returned an invalid file search result.' }, 503)
      }
    })
    // List a directory inside a session's working directory.
    for (const fileRoute of ['/api/sessions/:key/files', '/api/sessions/:key/workspace/files']) app.get(fileRoute, async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')!
      const relPath = c.req.query('path') ?? ''
      const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        const path = normalizeRemoteWorkspacePath(relPath)
        if (!path) return c.json({ error: 'invalid_path' }, 400)
        const executor = sessions.remoteExecutor
        if (!executor) {
          return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
        }
        try {
          const output = await executeRemoteFilesystemText(
            {
              executor,
              nodeId: base.workdir.nodeId,
              capabilityId: base.workdir.capabilityId,
              sessionId: key,
              turnId: `session-files:${crypto.randomUUID()}`,
              signal: c.req.raw.signal,
            },
            FILESYSTEM_READ_OPERATION,
            { path },
          )
          const entries = output.length === 0 ? [] : output.split('\n').map(
            (entry) => {
              const isDir = entry.endsWith('/')
              const name = isDir ? entry.slice(0, -1) : entry
              return {
                name,
                type: isDir ? 'dir' as const : 'file' as const,
                ext: isDir ? '' : extname(name).toLowerCase(),
                size: 0,
                mtime: null,
              }
            },
          )
          entries.sort((left, right) => {
            if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
            return left.name.localeCompare(right.name)
          })
          return c.json({
            key,
            path: path === '.' ? '' : path,
            workdir: { kind: 'remote', displayPath: sessions.getNodeInventory?.()?.nodes
              .find(node => node.nodeId === base.workdir.nodeId)?.capabilities
              .find(capability => capability.capabilityId === base.workdir.capabilityId && capability.kind === 'workdir')?.displayPath ?? null },
            entries,
          })
        } catch (error) {
          if (error instanceof RemoteFilesystemError) {
            return c.json({
              error: 'remote_filesystem_failed',
              code: error.code,
              detail: error.message,
            }, remoteFilesystemStatus(error))
          }
          throw error
        }
      }
      return serveLocalFiles(c, base.path, { key }, 'files', relPath, undefined, base.scope)
    })

    // Serve the raw bytes of a file (used for image/video/audio previews).
    for (const fileRoute of ['/api/sessions/:key/raw', '/api/sessions/:key/workspace/raw']) app.get(fileRoute, async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')!
      const relPath = c.req.query('path') ?? ''
      const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      }
      return serveLocalFiles(c, base.path, { key }, 'raw', relPath)
    })

    // Static file serving: like opening a local file directly, so an HTML page's
    // relative asset references (CSS, fonts, images, scripts) resolve against the
    // request path instead of a query param. Enables full page previews.
    for (const fileRoute of ['/api/sessions/:key/static/*', '/api/sessions/:key/workspace/static/*']) app.get(fileRoute, async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')!
      const relPath = staticFilePath(c)
      if (relPath === null) return c.json({ error: 'invalid_path' }, 400)
      const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      }
      return serveLocalFiles(c, base.path, { key }, 'raw', relPath)
    })

    // Return a truncated text preview of a file (used for text tiles).
    for (const fileRoute of ['/api/sessions/:key/preview', '/api/sessions/:key/workspace/preview']) app.get(fileRoute, async (c) => {
      const encoding = c.req.query('encoding') ?? 'auto'
      if (!isTextEncoding(encoding)) return c.json({ error: 'invalid_text_encoding' }, 400)
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')!
      const relPath = c.req.query('path') ?? ''
      const maxBytes = filePreviewLimit(c.req.query('maxBytes'))
      const base = await sessionFileBase(sessions, key, fileRoute.includes('/workspace/'))
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        if (encoding !== 'auto' && encoding !== 'utf-8') return c.json({ error: 'remote_encoding_unavailable' }, 501)
        const path = normalizeRemoteWorkspacePath(relPath)
        if (!path) return c.json({ error: 'invalid_path' }, 400)
        const executor = sessions.remoteExecutor
        if (!executor) {
          return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
        }
        try {
          const content = await executeRemoteFilesystemText(
            {
              executor,
              nodeId: base.workdir.nodeId,
              capabilityId: base.workdir.capabilityId,
              sessionId: key,
              turnId: `session-preview:${crypto.randomUUID()}`,
              signal: c.req.raw.signal,
            },
            FILESYSTEM_READ_OPERATION,
            { path },
          )
          const bytes = new TextEncoder().encode(content)
          const slice = bytes.subarray(0, maxBytes)
          return c.json({
            key,
            path: relPath,
            binary: false,
            encoding: 'utf-8',
            size: bytes.length,
            truncated: bytes.length > slice.length,
            content: new TextDecoder().decode(slice, { stream: bytes.length > slice.length }),
          })
        } catch (error) {
          if (error instanceof RemoteFilesystemError) {
            return c.json({
              error: 'remote_filesystem_failed',
              code: error.code,
              detail: error.message,
            }, remoteFilesystemStatus(error))
          }
          throw error
        }
      }
      return serveLocalFiles(c, base.path, { key }, 'preview', relPath, maxBytes, base.scope)
    })

    app.get('/api/sessions/stages', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = await sessions.listSessions()
      const stages: Record<string, 'idle' | 'llm' | 'tool' | 'inactive' | 'waiting' | 'rate-limit'> = {}
      const waitingForCalls: Record<string, boolean> = {}
      const activeRequestIds: Record<string, string> = {}
      const recoveries: Record<string, SessionRecovery> = {}
      for (const s of list) {
        const active = sessions.getActiveSession(s.sessionId)
        waitingForCalls[s.sessionId] = !!sessions.isWaitingForCall?.(s.sessionId)
        stages[s.sessionId] = waitingForCalls[s.sessionId] || sessions.yields.get(s.sessionId) || sessions.inputs.get(s.sessionId) ? 'waiting' : active?.rateLimitWait ? 'rate-limit' : active ? active.phase : 'inactive'
        if (active && active.phase !== 'idle' && 'activeRequestId' in active && typeof active.activeRequestId === 'string') {
          activeRequestIds[s.sessionId] = active.activeRequestId
        }
        const recovery = sessions.getSessionRecovery?.(s.sessionId)
        if (recovery) recoveries[s.sessionId] = recovery
      }
      return c.json({ stages, waitingForCalls, activeRequestIds, recoveries })
    })

    app.get('/api/sessions/:key/stage', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      if (sessions.isWaitingForCall?.(key)) return c.json({ stage: 'waiting', waitingForCall: true })
      if (sessions.yields.get(key) || sessions.inputs.get(key)) return c.json({ stage: 'waiting' })
      const active = sessions.getActiveSession(key)
      if (active) {
        return c.json({ stage: active.rateLimitWait ? 'rate-limit' : active.phase, rateLimitWait: active.rateLimitWait })
      }
      // Check if session exists but is not in memory
      const state = await sessions.readSessionState(key)
      if (state) {
        return c.json({ stage: 'inactive' })
      }
      return c.json({ error: 'session_not_found', key }, 404)
    })

    app.delete('/api/sessions/:key', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const state = sessions.getSessionState(key)
      if (!state) {
        return c.json({ error: 'session_not_found', key }, 404)
      }
      try {
        const deleted = await sessions.deleteSession(key)
        return c.json({ deleted })
      } catch (error) {
        if (error instanceof SessionIdentityError) return c.json({ error: 'history_conflict', message: error.message }, 409)
        throw error
      }
    })

    app.get('/api/sessions/:key', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const url = new URL(c.req.url, 'http://localhost')
      const rawOffset = url.searchParams.get('offset')
      const rawPageSize = url.searchParams.get('pageSize')
      // Pagination is opt-in via pageSize. Reject partial/ambiguous numbers rather
      // than silently returning the full history (or accepting parseInt prefixes).
      const integer = (value: string) => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
      if ((rawOffset != null && (!integer(rawOffset) || rawPageSize == null)) ||
          (rawPageSize != null && (!integer(rawPageSize) || Number(rawPageSize) < 1))) {
        return c.json({ error: 'invalid_history_query', message: 'Use a positive integer pageSize with an optional integer offset (default 0); negative offsets count from the end.' }, 400)
      }
      const pageSize = rawPageSize == null ? undefined : Number(rawPageSize)
      const offset = pageSize == null ? undefined : rawOffset == null ? 0 : Number(rawOffset)
      const shallow = url.searchParams.get('shallow') === 'true'

      // Try as logical key first
      const chain = await sessions.listHistorySessions()
      const isLogicalKey = chain.some((s) => s.sessionId === key)

      if (isLogicalKey) {
        const { messages, total } = await sessions.getHistory(
          key,
          { offset, pageSize, shallow },
        )
        // Include segment info so the UI can navigate to previous segments
        const state = await sessions.readSessionState(key)
        const segmentIndex = state?.segmentIndex ?? 0
        const currentPhysicalId = physicalSessionId(state ?? { sessionId: key, segmentIndex })
        let previousPhysicalId: string | null = null
        if (segmentIndex > 0) {
          previousPhysicalId = physicalSessionId(state ?? { sessionId: key, segmentIndex }, segmentIndex - 1)
        }
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
          commandResults: await sessions.getCommandResults(key),
          decisionRecords: await sessions.getYieldRecords(key),
          segmentIndex,
          currentPhysicalId,
          previousPhysicalId,
        })
      }

      // Fall back to physical session ID
      try {
        const { messages, total } = await sessions
          .getHistory(key, { physicalId: key, offset, pageSize })
        // Read start event to find the previous physical session in the chain
        let previousPhysicalId: string | null = null
        try {
          const firstRecord = await sessions.readFirstRecord(key)
          if (firstRecord?.previous_physical_id) {
            previousPhysicalId = String(firstRecord.previous_physical_id)
          }
        } catch { /* ignore */ }
        const owner = (await sessions.listHistoryStates()).find(state => {
          return state && Array.from({ length: state.segmentIndex + 1 }, (_, index) => physicalSessionId(state, index)).includes(key)
        })
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
          commandResults: await sessions.getCommandResults(key, key),
          decisionRecords: owner ? await sessions.getYieldRecords(owner.sessionId, key) : [],
          previousPhysicalId,
        })
      } catch {
        return c.json({ error: 'session_not_found', key }, 404)
      }
    })
  }
}
