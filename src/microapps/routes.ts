import { Hono } from 'hono'
import { z } from 'zod'
import type { GatewayPlugin } from '../gateway/types.ts'
import { revisionId } from './contracts.ts'
import { appJson, microAppHttpError, type MicroApps } from './service.ts'

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
    app.post('/api/microapps/:id/approve', async c => {
      const input = z.object({ revision: revisionId, confirm: z.literal(true), model: z.string().trim().min(1).max(256).optional() }).strict().parse(await appJson(c.req.raw))
      return c.json(await service.approve(c.req.param('id'), input.revision, input.model))
    })
    app.post('/api/microapps/:id/test', async c => {
      const input = z.object({ revision: revisionId }).strict().parse(await appJson(c.req.raw))
      return c.json(await service.requestTesting(c.req.param('id'), input.revision))
    })
    app.post('/api/microapps/:id/:action', async c => {
      z.object({}).strict().parse(await appJson(c.req.raw))
      const action = z.enum(['start', 'stop', 'open', 'revoke']).parse(c.req.param('action'))
      return c.json(await service[action](c.req.param('id')))
    })
    host.route('/', app)
  }
}
