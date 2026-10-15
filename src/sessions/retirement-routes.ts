import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { SessionManager } from './session-manager.ts'
import type { SessionRetirement } from './retirement.ts'

export function registerRetirementRoutes(app: Hono, options: {
  sessions: SessionManager
  retirement: SessionRetirement
  ready: () => boolean
  authorize: (request: Request) => boolean | Promise<boolean>
}): void {
  const routes = new Hono()
  routes.use('*', async (c, next) => {
    if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    c.header('Cache-Control', 'no-store')
    return next()
  })
  routes.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }))
  routes.get('/', c => c.json({
    ...options.retirement.status, recentlyDeleted: options.sessions.listRetiredSessions(),
  }))
  routes.post('/scan', c => {
    if (!options.ready()) return c.json({ error: 'Runtime not ready' }, 503)
    void options.retirement.scan().catch(error => console.error('[retirement] Scan failed', error))
    return c.json({ accepted: true }, 202)
  })
  routes.post('/restore', async c => {
    const body = z.object({ sessionId: z.string().min(1).max(512) }).strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'sessionId required' }, 400)
    try {
      await options.sessions.restoreRetiredSession(body.data.sessionId)
      return c.json({ restored: true })
    } catch { return c.json({ error: 'Retired session not found or unavailable' }, 409) }
  })
  app.route('/api/session-retirement', routes)
}
