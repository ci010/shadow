import { randomUUID } from 'node:crypto'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import { isClusterIdentifier } from '../cluster/contracts.ts'
import type { SessionManager } from './session-manager.ts'
import { LOCAL_NODE_ID, resolveSessionLocations, type WorkdirRefV1 } from './locality.ts'

export function remoteSessionPlugin(options: {
  sessions: Pick<SessionManager, 'workspace' | 'workdirCapabilityLookup' | 'remoteExecutor' | 'buildSession'>
  authorize: (request: Request) => boolean | Promise<boolean>
}): GatewayPlugin {
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
        if (Object.keys(value).some(key => key !== 'nodeId' && key !== 'capabilityId')
          || !isClusterIdentifier(value.nodeId) || !isClusterIdentifier(value.capabilityId)
          || value.nodeId === LOCAL_NODE_ID) return c.json({ error: 'invalid_remote_workdir' }, 400)
        if (!options.sessions.remoteExecutor) return c.json({ error: 'remote_executor_unavailable' }, 503)
        const workdir: WorkdirRefV1 = { version: 1, nodeId: value.nodeId, capabilityId: value.capabilityId }
        const chatId = `chat-${randomUUID()}`
        const sessionId = `web:${chatId}`
        const resolved = resolveSessionLocations(options.sessions.workspace, { sessionId, workdir },
          LOCAL_NODE_ID, options.sessions.workdirCapabilityLookup).workdir
        if (!resolved.available) {
          return c.json({ error: 'workdir_unavailable', reason: resolved.reason }, 409)
        }
        if (resolved.locality !== 'remote') return c.json({ error: 'invalid_remote_workdir' }, 400)
        await options.sessions.buildSession(sessionId, undefined, { mode: 'session', workdir })
        return c.json({ sessionId, chatId, workdir }, 201)
      })
  }
}
