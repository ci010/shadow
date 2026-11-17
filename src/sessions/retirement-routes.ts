import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { SessionManager } from './session-manager.ts'

export function registerRetirementRoutes(app: Hono, options: {
  sessions: SessionManager
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
    recentlyDeleted: options.sessions.listRetiredSessions(),
  }))
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

  // Cold archive access is deliberately separate from live navigation and the
  // legacy recently-deleted/restore API. There is no cold restore endpoint.
  const archives = new Hono()
  archives.use('*', async (c, next) => {
    if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    c.header('Cache-Control', 'no-store')
    return next()
  })
  const integer = (raw: string | undefined, fallback: number, min: number, max: number) => {
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new RangeError('Invalid archive range')
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Invalid archive range')
    return value
  }
  archives.get('/', async c => {
    try {
      const limit = integer(c.req.query('limit'), 50, 1, 200)
      const cursor = c.req.query('cursor')
      if (cursor !== undefined && (!cursor || cursor.length > 4096)) return c.json({ error: 'invalid_archive_cursor' }, 400)
      return c.json(await options.sessions.queryConversationArchives({ limit, cursor }))
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) return c.json({ error: 'invalid_archive_query' }, 400)
      throw error
    }
  })
  archives.get('/:sessionId/records', async c => {
    try {
      const segmentIndex = integer(c.req.query('segmentIndex'), 0, 0, Number.MAX_SAFE_INTEGER)
      const offset = integer(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = integer(c.req.query('limit'), 100, 1, 1000)
      const page = await options.sessions.readConversationArchiveRecords(c.req.param('sessionId'), segmentIndex, offset, limit)
      return page ? c.json({ ...page, segmentIndex, offset, readOnly: true }) : c.json({ error: 'archive_not_found' }, 404)
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) return c.json({ error: 'invalid_archive_range' }, 400)
      throw error
    }
  })
  archives.get('/:sessionId', async c => {
    const state = await options.sessions.readConversationArchive(c.req.param('sessionId'))
    return state ? c.json({ state, readOnly: true }) : c.json({ error: 'archive_not_found' }, 404)
  })
  app.route('/api/session-archives', archives)
}
