import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ComputerError } from '../execution/computer/contracts.ts'
import type { ComputerService } from './service.ts'

export function registerComputerRoutes(parent: Hono, options: {
  service: ComputerService
  projectId: string
  authorize: (request: Request) => boolean | Promise<boolean>
  assertSession: (sessionId: string) => void
}): void {
  const app = new Hono()
  app.use('/api/computer/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    return next()
  })
  app.use('/api/computer/*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }))
  app.onError((error, c) => {
    if (error instanceof ComputerError) return c.json({ error: error.code, message: error.message }, error.status)
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_request' }, 400)
    console.error('[computer] Request failed', { error: error.name })
    return c.json({ error: 'computer_failed', message: 'Computer use failed. Refresh its status before trying again.' }, 500)
  })
  const owner = (sessionId: string) => {
    z.string().min(1).max(512).parse(sessionId)
    options.assertSession(sessionId)
    return { projectId: options.projectId, sessionId }
  }
  app.post('/api/computer/stop', async c => {
    await options.service.stopAll()
    return c.json({ stopped: true })
  })
  app.get('/api/computer/:sessionId', c => c.json(options.service.status(owner(c.req.param('sessionId')))))
  app.post('/api/computer/:sessionId/windows', async c =>
    c.json(await options.service.windows(owner(c.req.param('sessionId')), c.req.raw.signal)))
  app.post('/api/computer/:sessionId/share', async c => {
    const input = z.object({ windowId: z.string().uuid(), foregroundInput: z.boolean().default(false) }).strict().parse(await c.req.json())
    return c.json(await options.service.share(owner(c.req.param('sessionId')), input.windowId, c.req.raw.signal, input.foregroundInput))
  })
  app.get('/api/computer/:sessionId/decisions/:id/frame', c => {
    const image = options.service.reviewFrame(owner(c.req.param('sessionId')), c.req.param('id'))
    return c.body(Uint8Array.from(image), 200, {
      'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    })
  })
  app.post('/api/computer/:sessionId/decisions/:id', async c => {
    const input = z.object({ approved: z.boolean() }).strict().parse(await c.req.json())
    options.service.decide(owner(c.req.param('sessionId')), c.req.param('id'), input.approved)
    return c.json({ requestId: c.req.param('id'), accepted: true })
  })
  app.post('/api/computer/:sessionId/stop', async c => {
    const sessionId = z.string().min(1).max(512).parse(c.req.param('sessionId'))
    await options.service.release({ projectId: options.projectId, sessionId })
    return c.json({ stopped: true })
  })
  parent.route('/', app)
}
