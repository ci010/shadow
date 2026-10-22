import { z } from 'zod'
import { Hono } from 'hono'
import type { GatewayPlugin } from '../../gateway/types.ts'
import { WorkConflict } from '../../initiatives/work-contract.ts'
import { GitHubError, githubOperationInput, githubSubscriptionSchema, repositoryName } from './contracts.ts'
import type { GitHubService } from './service.ts'

export function githubPlugin(service: GitHubService, authorize: (request: Request) => boolean | Promise<boolean>): GatewayPlugin {
  return host => {
    const app = new Hono()
    app.onError((error, c) => {
      if (error instanceof GitHubError) return c.json({ error: 'github_operation_failed', message: error.message }, error.status)
      if (error instanceof WorkConflict) return c.json({ error: 'work_conflict', message: error.message }, 409)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_request', message: error.message }, 400)
      console.error('[github] Request failed', error)
      return c.json({ error: 'github_unavailable', message: 'GitHub integration failed. Check Main logs and reload; do not repeat an uncertain write.' }, 500)
    })
    const middleware: Parameters<typeof app.use>[1] = async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      return next()
    }
    app.use('/api/github', middleware)
    app.use('/api/github/*', middleware)
    app.get('/api/github', c => c.json(service.state()))
    app.post('/api/github/repositories', async c => {
      const body = z.object({ name: repositoryName, read: z.boolean(), write: z.boolean() }).strict().parse(await c.req.json())
      return c.json(await service.configureRepository(body.name, body.read, body.write, c.req.raw.signal))
    })
    app.post('/api/github/links', async c => {
      const body = z.object({ url: z.string().url(), workKey: z.string().min(1).optional() }).strict().parse(await c.req.json())
      return c.json(await service.link(body.url, body.workKey, c.req.raw.signal))
    })
    app.post('/api/github/unlink', async c => {
      const body = z.object({ resourceId: z.string(), workKey: z.string() }).strict().parse(await c.req.json())
      await service.unlink(body.resourceId, body.workKey)
      return c.json({ removed: true })
    })
    app.post('/api/github/import', async c => {
      const body = z.object({ resourceId: z.string(), sourceHash: z.string(), definition: z.unknown() }).strict().parse(await c.req.json())
      return c.json(await service.importIssue(body.resourceId, body.sourceHash, body.definition, c.req.raw.signal))
    })
    app.post('/api/github/resources/:id/refresh', async c => c.json(await service.refresh(c.req.param('id'), c.req.raw.signal)))
    app.post('/api/github/operations', async c => c.json(await service.prepare(githubOperationInput.parse(await c.req.json()), c.req.raw.signal)))
    app.post('/api/github/operations/:id/not-applied', async c => {
      const body = z.object({ confirmNoEffect: z.literal(true), note: z.string().trim().min(10).max(2000) }).strict().parse(await c.req.json())
      await service.verifyNotApplied(c.req.param('id'), body.note)
      return c.json({ verified: true })
    })
    app.post('/api/github/operations/:id/:action', async c => {
      const body = z.object({ confirm: z.literal(true) }).strict().parse(await c.req.json())
      const action = z.enum(['execute', 'cancel', 'reconcile']).parse(c.req.param('action'))
      const value = action === 'execute' ? await service.execute(c.req.param('id'), c.req.raw.signal)
        : action === 'reconcile' ? await service.reconcile(c.req.param('id'), c.req.raw.signal) : await service.cancel(c.req.param('id'))
      return c.json(value ?? { confirmed: body.confirm })
    })
    app.post('/api/github/subscriptions', async c =>
      c.json(await service.subscribe(githubSubscriptionSchema.omit({ assignmentRevision: true }).parse(await c.req.json()))))
    app.post('/api/github/notifications/:id', async c => {
      const body = z.object({ retry: z.boolean(), acceptDuplicateRisk: z.literal(true) }).strict().parse(await c.req.json())
      await service.resolveNotification(c.req.param('id'), body.retry)
      return c.json({ resolved: true })
    })
    host.route('/', app)
  }
}
