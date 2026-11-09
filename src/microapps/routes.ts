import { Hono } from 'hono'
import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import { revisionId } from './contracts.ts'
import { appJson, boundedBody, microAppHttpError, type MicroApps } from './service.ts'

export function microAppsPlugin(service: MicroApps, authorize: (request: Request) => boolean | Promise<boolean>): GatewayPlugin {
  return host => {
    const app = new Hono()
    app.onError(microAppHttpError)
    const auth: Parameters<Hono['use']>[1] = async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized', message: 'Project owner access required' }, 401)
      return next()
    }
    app.use('/api/microapps', auth)
    app.use('/api/microapps/*', auth)
    app.get('/api/microapps', c => c.json({ apps: service.list() }))
    app.get('/api/microapps/:id', async c => c.json(await service.review(c.req.param('id'))))
    app.get('/api/microapps/:id/status', c => c.json(service.get(c.req.param('id'))))
    app.get('/api/microapps/:id/icon', async c => {
      const bytes = await service.icon(c.req.param('id'), revisionId.parse(c.req.query('revision')))
      return new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    })
    app.post('/api/microapps/:id/cancel-testing', async c => {
      z.object({}).strict().parse(await appJson(c.req.raw))
      return c.json(await service.cancelTesting(c.req.param('id')))
    })
    app.post('/api/microapps/:id/test', async c => {
      const input = z.object({ revision: revisionId }).strict().parse(await appJson(c.req.raw))
      return c.json(await service.requestTesting(c.req.param('id'), input.revision))
    })
    app.post('/api/microapps/:id/relay', async c => {
      const input = z.object({ revision: revisionId, runId: z.string().uuid(), path: z.string().max(8192),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']), token: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
        contentType: z.string().max(256).optional(), body: z.string().max(24 * 1024 * 1024).optional() }).strict()
        .parse(JSON.parse(Buffer.from(await boundedBody(c.req.raw, 24 * 1024 * 1024)).toString('utf8')))
      return c.json(await service.relay(c.req.param('id'), input, c.req.raw.signal))
    })
    app.post('/api/microapps/:id/open', async c => {
      const input = z.object({ revision: revisionId.optional() }).strict().parse(await appJson(c.req.raw))
      return c.json(await service.open(c.req.param('id'), input.revision))
    })
    app.post('/api/microapps/:id/:action', async c => {
      z.object({}).strict().parse(await appJson(c.req.raw))
      const action = z.enum(['start', 'stop']).parse(c.req.param('action'))
      return c.json(await service[action](c.req.param('id')))
    })
    host.route('/', app)
  }
}
