import type { Hono } from 'hono'
import { delegationOwner } from './execution-scope.ts'
import type { SessionManager } from './session-manager.ts'
import { isConfigObject, parseSessionConfigPatch } from './config-patch.ts'
import { YieldError } from './yield.ts'
import { SessionResumeError } from './recovery.ts'
import type { SessionRecovery } from './session-store.ts'
import { ProjectError } from '../projects/registry.ts'
import { isSelfReflectionId } from './session-purpose.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import {
  resolveSessionLocations,
  type SessionLocalityState,
  type WorkdirCapabilityLookup,
  type WorkdirResolution,
  type WorkdirUnavailableReason,
} from './locality.ts'
import { extname, resolve } from 'node:path'
import { filePreviewLimit, serveLocalFiles, staticFilePath } from '../gateway/local-files.ts'
import { isTextEncoding } from '../gateway/text-encoding.ts'
import { serveLocalGit } from '../gateway/local-git.ts'
import { serveRemoteGit } from '../execution/remote-git-client.ts'
export { resolveInWorkspace } from '../gateway/local-files.ts'
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

function sessionFileBase(
  sessions: SessionManager,
  key: string,
): WorkdirResolution & { scope?: 'home' } {
  const state = sessions.getSessionState(key)
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
    if (isSelfReflectionId(ancestor)) {
      // This is a browsing root, not a change to the agent's execution workdir.
      return { ...base, path: resolve(sessions.workspace), scope: 'home' }
    }
    ancestor = sessions.getSessionState(ancestor)?.parent?.id
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
): GatewayPlugin {
  return (app: Hono) => {
    app.use('/api/sessions/:key/*', async (c, next) => {
      if (!c.req.path.slice('/api/sessions/'.length).includes('/')) return next()
      if (sessions?.organizationId && !sessions.getSessionState(c.req.param('key') ?? '')) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const suffix = c.req.path.slice('/api/sessions/'.length)
      if (sessions && (/\/(?:files|raw|preview|static|git)(?:\/|$)/.test(suffix) ||
        c.req.method !== 'GET' || suffix.endsWith('/context'))) {
        try { sessions.assertProjectAccess?.(c.req.param('key') ?? '') }
        catch (error) {
          if (error instanceof ProjectError) return c.json({ error: error.code, message: error.message }, error.status)
          throw error
        }
      }
      return next()
    })
    for (const operation of ['status', 'diff'] as const) {
      app.get(`/api/sessions/:key/git/${operation}`, async c => {
        if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
        const key = c.req.param('key')
        const base = sessionFileBase(sessions, key)
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
      const list = await sessions.listSessions()
      return c.json({ sessions: list })
    })

    app.get('/api/sessions/graph', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const list = await sessions.listSessions()

      const nodes: Array<{
        organizationId?: string
        mode: string
        agentType: string
        parentSessionId: string | null
        executionId?: string
        executionStatus: string
        physicalId: string
        logicalId: string
        projectId?: string
        parentPhysicalId: string | null
        parentIndex: number | null
        isCurrent: boolean
        timestamp: string | null
      }> = []

      const enrichedSessions = []
      for (const session of list) {
        const state = sessions.getSessionState(session.sessionId)
        const execution = {
          mode: state?.mode ?? 'session',
          agentType: state?.agentType ?? 'general',
          parentSessionId: delegationOwner(state) ?? null,
          waitingForCall: !!sessions.isWaitingForCall?.(session.sessionId),
          executionId: state?.executionId,
          parentToolCallId: state?.parentToolCallId,
          executionStatus: sessions.isWaitingForCall?.(session.sessionId) || sessions.yields.get(session.sessionId)
            ? 'waiting' : state?.executionStatus ?? (state?.lastActivityAt ? 'completed' : 'pending'),
        }
        const firstMsg = await sessions.getFirstUserMessage(session.sessionId)
        enrichedSessions.push({
          ...session,
          ...execution,
          title: execution.mode !== 'session' ? state?.description ?? firstMsg ?? undefined : firstMsg ?? undefined,
          description: state?.description ?? undefined,
          config: state?.config ?? undefined,
          lastActivityAt: state?.lastActivityAt ?? session.lastActivityAt ??
            null,
        })
        for (let i = 0; i <= session.segmentIndex; i++) {
          const physicalId = newPhysicalSessionId(session.sessionId, i)
          const parentPhysicalId = state?.parent?.physicalId ??
            null
          nodes.push({
            ...execution,
            ...(state?.organizationId ? { organizationId: state.organizationId } : {}),
            physicalId,
            logicalId: session.sessionId,
            projectId: state?.projectId,
            parentPhysicalId,
            parentIndex: state?.parent?.index ?? null,
            isCurrent: i === session.segmentIndex,
            timestamp: state?.lastActivityAt ?? null,
          })
        }
      }

      return c.json({ sessions: enrichedSessions, nodes })
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
      if (!isConfigObject(body) || Object.keys(body).some(key => key !== 'recoveryId')
        || typeof body.recoveryId !== 'string' || !body.recoveryId) return c.json({ error: 'invalid_request' }, 400)
      try {
        const receipt = await sessions.resumeSession(key, body.recoveryId)
        return c.json({ sessionId: key, recoveryId: body.recoveryId, requestId: receipt.inputId, status: 'accepted' }, 202)
      } catch (error) {
        return c.json({
          error: error instanceof SessionResumeError ? 'recovery_conflict' : 'resume_failed',
          message: error instanceof Error ? error.message : 'Could not continue this conversation.',
        }, error instanceof SessionResumeError ? 409 : 500)
      }
    })

    app.get('/api/sessions/:key/yield', (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      return c.json({ request: sessions.yields.get(key) })
    })

    app.on(['POST', 'DELETE'], '/api/sessions/:key/yield', async (c) => {
      if (!sessions) return c.json({ error: 'sessions_unavailable' }, 501)
      const key = c.req.param('key')
      if (!sessions.getSessionState(key)) return c.json({ error: 'session_not_found', key }, 404)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
      const cancel = c.req.method === 'DELETE'
      if (!isConfigObject(body) || Object.keys(body).some(key => key !== 'requestId' && (cancel || key !== 'option'))
        || typeof body.requestId !== 'string' || !body.requestId || (!cancel && typeof body.option !== 'string')) {
        return c.json({ error: 'invalid_request', message: cancel ? 'Supply the current requestId.' : 'Supply requestId and one exact option.' }, 400)
      }
      try {
        if (cancel) {
          sessions.yields.cancelUser(key, body.requestId)
          sessions.getActiveSession(key)?.cancel()
          return c.json({ cancelled: true })
        }
        if (typeof body.option !== 'string') return c.json({ error: 'invalid_request' }, 400)
        return c.json({ answer: sessions.yields.answerUser(key, body.requestId, body.option) })
      } catch (error) {
        if (!(error instanceof YieldError)) throw error
        const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403
          : error.code === 'conflict' ? 409 : error.code === 'unavailable' ? 503 : 400
        return c.json({ error: error.code, message: error.message }, status)
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
      try {
        const result = await sessions.getContext({ sessionId: key })
        if (!result) {
          return c.json({ error: 'session_not_found', key }, 404)
        }
        return c.json({
          key,
          systemPrompt: result.systemPrompt,
          tools: result.tools,
        })
      } catch (err) {
        return c.json({
          error: 'context_retrieval_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    })

    // ── Session workspace file browsing ────────────────────────────────
    // List a directory inside a session's working directory.
    app.get('/api/sessions/:key/files', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const relPath = c.req.query('path') ?? ''
      const base = sessionFileBase(sessions, key)
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
    app.get('/api/sessions/:key/raw', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const relPath = c.req.query('path') ?? ''
      const base = sessionFileBase(sessions, key)
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
    app.get('/api/sessions/:key/static/*', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const relPath = staticFilePath(c)
      if (relPath === null) return c.json({ error: 'invalid_path' }, 400)
      const base = sessionFileBase(sessions, key)
      if (!base.available) {
        return c.json(workdirUnavailableApiResult(key, base), 503)
      }
      if (base.locality === 'remote') {
        return c.json(remoteWorkdirRequiresExecutorApiResult(key, base), 501)
      }
      return serveLocalFiles(c, base.path, { key }, 'raw', relPath)
    })

    // Return a truncated text preview of a file (used for text tiles).
    app.get('/api/sessions/:key/preview', async (c) => {
      const encoding = c.req.query('encoding') ?? 'auto'
      if (!isTextEncoding(encoding)) return c.json({ error: 'invalid_text_encoding' }, 400)
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const relPath = c.req.query('path') ?? ''
      const maxBytes = filePreviewLimit(c.req.query('maxBytes'))
      const base = sessionFileBase(sessions, key)
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
      const stages: Record<string, 'idle' | 'llm' | 'tool' | 'inactive' | 'waiting'> = {}
      const waitingForCalls: Record<string, boolean> = {}
      const activeRequestIds: Record<string, string> = {}
      const recoveries: Record<string, SessionRecovery> = {}
      for (const s of list) {
        const active = sessions.getActiveSession(s.sessionId)
        waitingForCalls[s.sessionId] = !!sessions.isWaitingForCall?.(s.sessionId)
        stages[s.sessionId] = waitingForCalls[s.sessionId] || sessions.yields.get(s.sessionId) ? 'waiting' : active ? active.phase : 'inactive'
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
      if (sessions.yields.get(key)) return c.json({ stage: 'waiting' })
      const active = sessions.getActiveSession(key)
      if (active) {
        return c.json({ stage: active.phase })
      }
      // Check if session exists but is not in memory
      const state = await sessions.getSessionState(key)
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
      const deleted = await sessions.deleteSession(key)
      return c.json({ deleted })
    })

    app.get('/api/sessions/:key', async (c) => {
      if (!sessions) {
        return c.json({ error: 'sessions_unavailable' }, 501)
      }
      const key = c.req.param('key')
      const url = new URL(c.req.url, 'http://localhost')
      const rawOffset = url.searchParams.get('offset')
      const rawPageSize = url.searchParams.get('pageSize')
      const offset = rawOffset != null ? parseInt(rawOffset, 10) : undefined
      const pageSize = rawPageSize != null
        ? Math.max(1, parseInt(rawPageSize, 10))
        : undefined
      const shallow = url.searchParams.get('shallow') === 'true'

      // Try as logical key first
      const chain = await sessions.listSessions()
      const isLogicalKey = chain.some((s) => s.sessionId === key)

      if (isLogicalKey) {
        const { messages, total } = await sessions.getHistory(
          key,
          { offset, pageSize, shallow },
        )
        // Include segment info so the UI can navigate to previous segments
        const state = sessions.getSessionState(key)
        const segmentIndex = state?.segmentIndex ?? 0
        const currentPhysicalId = newPhysicalSessionId(key, segmentIndex)
        let previousPhysicalId: string | null = null
        if (segmentIndex > 0) {
          previousPhysicalId = newPhysicalSessionId(key, segmentIndex - 1)
        }
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
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
        return c.json({
          key,
          total,
          offset,
          pageSize,
          messages,
          previousPhysicalId,
        })
      } catch {
        return c.json({ error: 'session_not_found', key }, 404)
      }
    })
  }
}
