import { randomUUID } from 'node:crypto'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import type { SessionManager } from './session-manager.ts'
import { LOCAL_NODE_ID, resolveSessionLocations, type WorkdirRefV1 } from './locality.ts'
import { ProjectError, type ProjectRegistry, UUID_PATTERN } from '../projects/registry.ts'

export function remoteSessionPlugin(options: {
  sessions: Pick<SessionManager, 'workspace' | 'workdirCapabilityLookup' | 'remoteExecutor' | 'buildSession'> &
    Partial<Pick<SessionManager, 'getSessionState'>>
  authorize: (request: Request) => boolean | Promise<boolean>
  requireProjectOwnership?: boolean
  projects?: ProjectRegistry
}): GatewayPlugin {
  const pending = new Map<string, { target: string; result: Promise<{ sessionId: string; chatId: string; workdir: WorkdirRefV1; projectId?: string }> }>()
  return app => {
    app.post('/api/sessions/remote',
      async (c, next) => {
        if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
        await next()
      },
      bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }),
      async c => {
        let body: unknown
        try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_request' }, 400)
        const value = body as Record<string, unknown>
        if (Object.keys(value).some(key => key !== 'nodeId' && key !== 'capabilityId' && key !== 'requestId')
          || !isClusterIdentifier(value.nodeId) || !isClusterIdentifier(value.capabilityId)
          || (value.requestId !== undefined && (typeof value.requestId !== 'string' || !UUID_PATTERN.test(value.requestId)))
          || value.nodeId === LOCAL_NODE_ID) return c.json({ error: 'invalid_remote_workdir' }, 400)
        if (options.requireProjectOwnership && !options.projects) {
          return c.json({
            error: 'remote_project_identity_required',
            message: 'This device must support verified remote folder ownership before opening a new organization project. Existing remote sessions remain available.',
            action: 'upgrade_node',
          }, 409)
        }
        if (!options.sessions.remoteExecutor) return c.json({ error: 'remote_executor_unavailable' }, 503)
        const workdir: WorkdirRefV1 = { version: 1, nodeId: value.nodeId, capabilityId: value.capabilityId }
        const chatId = `chat-${typeof value.requestId === 'string' ? value.requestId.toLowerCase() : randomUUID()}`
        const sessionId = `web:${chatId}`
        const target = JSON.stringify([workdir.nodeId, workdir.capabilityId])
        try {
          const existing = options.sessions.getSessionState?.(sessionId)
          if (existing) {
            options.projects?.assertSessionProject(existing)
            if (existing.workdir?.nodeId !== workdir.nodeId || existing.workdir.capabilityId !== workdir.capabilityId) {
              return c.json({ error: 'remote_request_conflict' }, 409)
            }
            return c.json({ sessionId, chatId, workdir: existing.workdir, projectId: existing.projectId }, 201)
          }
          const active = pending.get(sessionId)
          if (active && active.target !== target) return c.json({ error: 'remote_request_conflict' }, 409)
          const result = active?.result ?? (async () => {
            const project = await options.projects?.registerRemote(workdir, c.req.raw.signal)
            const selected = project?.workdir ?? workdir
            const resolved = resolveSessionLocations(options.sessions.workspace, { sessionId, workdir: selected },
              LOCAL_NODE_ID, options.sessions.workdirCapabilityLookup).workdir
            if (!resolved.available) throw new ProjectError('workdir_unavailable', `Remote workdir unavailable: ${resolved.reason}`, 409)
            if (resolved.locality !== 'remote') throw new ProjectError('invalid_remote_workdir', 'Choose a remote folder capability.')
            await options.sessions.buildSession(sessionId, undefined, { mode: 'session', workdir: selected, ...(project ? { projectId: project.id } : {}) })
            return { sessionId, chatId, workdir: selected, ...(project ? { projectId: project.id } : {}) }
          })()
          if (!active) pending.set(sessionId, { target, result })
          try { return c.json(await result, 201) } finally {
            if (pending.get(sessionId)?.result === result) pending.delete(sessionId)
          }
        } catch (error) {
          if (error instanceof ProjectError) return c.json({ error: error.code, message: error.message,
            action: error.code === 'remote_workdir_identity_unsupported' ? 'upgrade_node' : 'connect_node' }, error.status)
          if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
          return c.json({ error: 'remote_project_failed', message: 'Remote folder ownership could not be verified. No local folder was used.' }, 503)
        }
      })
  }
}
