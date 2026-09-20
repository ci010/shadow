import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z, ZodError } from 'zod'
import type { ProjectRuntimeDependencies } from '../projects/runtime.ts'
import type { SkillsManager } from '../skills/loader.ts'
import { KnowledgeError, KnowledgeService } from './service.ts'
import type { KnowledgeMaintenanceService } from './maintenance.ts'

const repairSource = z.object({
  reportId: z.string().uuid(),
  sourceId: z.string().min(1).max(2048),
}).strict()

async function requestJson(request: Request): Promise<unknown> {
  try { return await request.json() }
  catch (error) {
    if (error instanceof SyntaxError) throw new KnowledgeError('invalid_knowledge_request', 'Expected a JSON request body')
    throw error
  }
}

export function registerKnowledgeRoutes(app: Hono, options: {
  workspace: string
  skills: SkillsManager
  authorize: ProjectRuntimeDependencies['authorize']
  maintenance?: KnowledgeMaintenanceService
}): void {
  const routes = new Hono()
  const service = new KnowledgeService(options.workspace, options.skills)
  routes.onError((error, c) => {
    if (error instanceof KnowledgeError) return c.json({ error: error.code, message: error.message }, error.status)
    if (error instanceof ZodError) return c.json({ error: 'invalid_knowledge_request', message: 'Invalid knowledge request fields' }, 400)
    console.error('[knowledge] Request failed', error)
    return c.json({ error: 'knowledge_request_failed', message: 'Knowledge operation failed; consult the project log.' }, 500)
  })
  routes.use('*', async (c, next) => {
    if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    c.header('Cache-Control', 'no-store')
    return next()
  })
  routes.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) }))
  routes.get('/', c => c.json(service.catalog()))
  const maintenance = () => {
    if (!options.maintenance) throw new KnowledgeError('maintenance_unavailable', 'Knowledge maintenance is not enabled for this Project', 503)
    return options.maintenance
  }
  routes.get('/maintenance', c => c.json(maintenance().status()))
  routes.post('/maintenance/scan', async c => {
    z.object({}).strict().parse(await requestJson(c.req.raw))
    return c.json(await maintenance().scan(c.req.raw.signal))
  })
  routes.post('/maintenance/preview', async c => {
    const body = repairSource.parse(await requestJson(c.req.raw))
    return c.json(maintenance().preview(body.reportId, body.sourceId))
  })
  routes.post('/maintenance/apply', async c => {
    const body = repairSource.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await requestJson(c.req.raw))
    return c.json(maintenance().apply(body.reportId, body.sourceId, body.revision))
  })
  routes.get('/entry', c => c.json(service.detail(c.req.query('id'))))
  routes.delete('/entry', async c => {
    let value: unknown
    try { value = await c.req.json() }
    catch (error) {
      if (error instanceof SyntaxError) throw new KnowledgeError('invalid_knowledge_request', 'Expected a JSON delete request')
      throw error
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'id' && key !== 'revision')) {
      throw new KnowledgeError('invalid_knowledge_request', 'Expected only id and revision')
    }
    const request = value as { id?: unknown; revision?: unknown }
    return c.json(service.delete(request.id, request.revision))
  })
  app.route('/api/knowledge', routes)
}
