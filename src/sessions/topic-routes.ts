import { bodyLimit } from 'hono/body-limit'
import type { Context, MiddlewareHandler } from 'hono'
import { ZodError } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import { FolderError } from '../folders/registry.ts'
import { TopicError, type TopicService } from './topics.ts'

export function topicsPlugin(
  topics: TopicService,
  authorize: (request: Request) => boolean | Promise<boolean>,
): GatewayPlugin {
  return app => {
    const protect: MiddlewareHandler = async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    }
    const handle = (action: (c: Context) => Promise<unknown>) => async (c: Context) => {
      try { return c.json(await action(c)) }
      catch (error) {
        if (error instanceof ZodError) return c.json({ error: 'invalid_session_request', details: error.issues }, 400)
        if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
        if (error instanceof TopicError || error instanceof FolderError) return c.json({ error: error.message }, error.status)
        if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
        console.error('[sessions] Metadata operation failed:', error)
        return c.json({ error: 'session_operation_failed' }, 500)
      }
    }
    app.post('/api/orchestrator', protect, handle(() => topics.ensureOrchestrator()))
    app.get('/api/sessions/discover', protect, handle(c => topics.search({
      query: c.req.query('query'),
      limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
      offset: c.req.query('offset') === undefined ? undefined : Number(c.req.query('offset')),
    })))
    const limit = bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'body_too_large' }, 413) })
    app.post('/api/sessions', protect, limit, handle(async c => topics.create(await c.req.json(), undefined, c.req.raw.signal)))
    app.patch('/api/sessions/:key/metadata', protect, limit, handle(async c => {
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || Array.isArray(body) || 'sessionId' in body) throw new TopicError('Provide session metadata without sessionId.')
      return topics.update({ ...body, sessionId: c.req.param('key') })
    }))
  }
}
