import { randomUUID } from 'node:crypto'
import type { Executor } from '../execution/executor.ts'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import type { SessionManager } from './session-manager.ts'
import { LOCAL_NODE_ID, resolveSessionLocations, type WorkdirRefV2 } from './locality.ts'
import { FolderError, type FolderRegistry, UUID_PATTERN } from '../folders/registry.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import { isManagedWorkdir, managedSessionWorkdirId } from '../execution/managed-workdir.ts'
import { allocateRemoteSessionWorkdir } from '../execution/remote-managed-workdir-client.ts'

export function remoteSessionPlugin(options: {
  sessions: Pick<SessionManager, 'workspace' | 'workdirLookup' | 'remoteExecutor' | 'buildSession'> &
    Partial<Pick<SessionManager, 'getSessionState'>>
  authorize: (request: Request) => boolean | Promise<boolean>
  requireFolderOwnership?: boolean
  folders?: FolderRegistry
  managedSessions?: { projectId: string; inventory: () => NodeInventoryResponse; executor: Executor }
}): GatewayPlugin {
  const pending = new Map<string, { target: string; result: Promise<{ sessionId: string; chatId: string; workdir: WorkdirRefV2; folderId?: string }> }>()
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
        if (Object.keys(value).some(key => key !== 'nodeId' && key !== 'workdirId' && key !== 'requestId')
          || !isClusterIdentifier(value.nodeId) ||
          (value.workdirId !== undefined && (!isClusterIdentifier(value.workdirId) || isManagedWorkdir(value.workdirId)))
          || (value.requestId !== undefined && (typeof value.requestId !== 'string' || !UUID_PATTERN.test(value.requestId)))
          || (value.workdirId === undefined && value.requestId === undefined)
          || value.nodeId === LOCAL_NODE_ID) return c.json({ error: 'invalid_remote_workdir' }, 400)
        const scratch = value.workdirId === undefined
        if (scratch && !options.managedSessions?.executor) return c.json({ error: 'managed_sessions_unsupported', action: 'upgrade_node' }, 409)
        if (options.requireFolderOwnership && !options.folders) {
          return c.json({
            error: 'remote_folder_identity_required',
            message: 'This device must support verified remote folder ownership before opening a new project folder. Existing remote sessions remain available.',
            action: 'upgrade_node',
          }, 409)
        }
        if (!options.sessions.remoteExecutor) return c.json({ error: 'remote_executor_unavailable' }, 503)
        const chatId = `chat-${typeof value.requestId === 'string' ? value.requestId.toLowerCase() : randomUUID()}`
        const sessionId = `web:${chatId}`
        const workdir: WorkdirRefV2 = { version: 2, nodeId: value.nodeId, workdirId: scratch
          ? managedSessionWorkdirId(options.managedSessions!.projectId, sessionId) : value.workdirId as string }
        const target = JSON.stringify([workdir.nodeId, workdir.workdirId])
        try {
          const existing = options.sessions.getSessionState?.(sessionId)
          if (existing) {
            options.folders?.assertSessionFolder(existing)
            if (existing.workdir?.nodeId !== workdir.nodeId || existing.workdir.workdirId !== workdir.workdirId) {
              return c.json({ error: 'remote_request_conflict' }, 409)
            }
            return c.json({ sessionId, chatId, workdir: existing.workdir, folderId: existing.folderId }, 201)
          }
          const active = pending.get(sessionId)
          if (active && active.target !== target) return c.json({ error: 'remote_request_conflict' }, 409)
          const result = active?.result ?? (async () => {
            options.folders?.assertSessionFolder({ sessionId, workdir })
            let selected = workdir
            if (scratch) {
              const node = options.managedSessions!.inventory().nodes.find(node => node.nodeId === workdir.nodeId && node.role === 'child')
              if (node?.connection !== 'connected') throw new FolderError('managed_session_node_unavailable', 'Connect the selected node before starting a remote session.', 503)
              if (node.executionProtocol !== 'compatible' || node.supportsManagedSessions !== true) throw new FolderError('managed_sessions_unsupported', 'Update the selected node to support managed sessions, then reconnect.', 409)
              selected = await allocateRemoteSessionWorkdir({
                executor: options.managedSessions!.executor, projectId: options.managedSessions!.projectId,
                sessionId, nodeId: workdir.nodeId, signal: c.req.raw.signal,
              })
            }
            const folder = scratch ? undefined : await options.folders?.registerRemote(workdir, c.req.raw.signal)
            selected = folder?.workdir ?? selected
            const resolved = resolveSessionLocations(options.sessions.workspace, { sessionId, workdir: selected },
              LOCAL_NODE_ID, options.sessions.workdirLookup).workdir
            if (!resolved.available) throw new FolderError('workdir_unavailable', `Remote workdir unavailable: ${resolved.reason}`, 409)
            if (resolved.locality !== 'remote') throw new FolderError('invalid_remote_workdir', 'Choose a remote folder capability.')
            c.req.raw.signal.throwIfAborted()
            await options.sessions.buildSession(sessionId, undefined, { mode: 'session', workdir: selected, ...(folder ? { folderId: folder.id } : {}) })
            return { sessionId, chatId, workdir: selected, ...(folder ? { folderId: folder.id } : {}) }
          })()
          if (!active) pending.set(sessionId, { target, result })
          try { return c.json(await result, 201) } finally {
            if (pending.get(sessionId)?.result === result) pending.delete(sessionId)
          }
        } catch (error) {
          if (error instanceof FolderError) return c.json({ error: error.code, message: error.message,
            action: ['remote_workdir_identity_unsupported', 'managed_sessions_unsupported'].includes(error.code) ? 'upgrade_node' : 'connect_node' }, error.status)
          if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
          if (scratch) return c.json({ error: 'managed_session_allocation_failed',
            message: 'The remote session could not be created. Reconnect and retry; no local folder was used.' }, 503)
          return c.json({ error: 'remote_folder_failed', message: 'Remote folder ownership could not be verified. No local folder was used.' }, 503)
        }
      })
  }
}
