import { maintenanceSummary } from './maintenance-contracts.ts'
import { keyedMaintenance } from '../shared/snapshot-wire.ts'
import { createSnapshotResponder } from '../shared/snapshot-server.ts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z, ZodError } from 'zod'
import type { ProjectRuntimeDependencies } from '../projects/runtime.ts'
import type { SkillsManager } from '../skills/loader.ts'
import { KnowledgeError, KnowledgeService } from './service.ts'
import type { KnowledgeMaintenanceService } from './maintenance.ts'
import { maintenanceApplyRequest, type LearningMaintenancePreview } from '../agent/learning/maintenance-preview.ts'

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
  learningMaintenance?: LearningMaintenancePreview
  ownerMaintenancePlan?: (revision: string) => unknown
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
  const smallBody = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'body_too_large' }, 413) })
  const previewBody = bodyLimit({ maxSize: 512 * 1024, onError: c => c.json({ error: 'body_too_large' }, 413) })
  routes.use('*', (c, next) => c.req.path === '/api/knowledge/learning-maintenance/preview'
    ? previewBody(c, next) : smallBody(c, next))
  routes.get('/', c => c.json(service.catalog()))
  const maintenance = () => {
    if (!options.maintenance) throw new KnowledgeError('maintenance_unavailable', 'Knowledge maintenance is not enabled for this Project', 503)
    return options.maintenance
  }
  const respond = createSnapshotResponder()
  const summarize = createSnapshotResponder()
  routes.get('/maintenance', c => {
    const value = maintenance().status()
    if (c.req.query('view') === 'summary') {
      const summary = maintenanceSummary(value)
      return c.json(c.req.query('transport') === 'snapshot-v1' ? summarize(summary, c.req.query('since')) : summary)
    }
    return c.json(c.req.query('transport') === 'snapshot-v1' ? respond(keyedMaintenance(value), c.req.query('since')) : value)
  })
  routes.get('/maintenance/report', c => {
    const reportId = z.string().min(1).max(128).parse(c.req.query('reportId'))
    const report = maintenance().status().report
    if (!report || report.id !== reportId) return c.json({ error: 'maintenance_report_changed' }, 409)
    return c.json(report)
  })
  routes.post('/maintenance/scan', async c => {
    z.object({}).strict().parse(await requestJson(c.req.raw))
    const report = await maintenance().scan(c.req.raw.signal)
    return c.json(c.req.query('view') === 'summary'
      ? maintenanceSummary({ intervalMs: maintenance().status().intervalMs, scanning: false, report }) : report)
  })
  routes.post('/maintenance/preview', async c => {
    const body = repairSource.parse(await requestJson(c.req.raw))
    return c.json(maintenance().preview(body.reportId, body.sourceId))
  })
  routes.post('/maintenance/apply', async c => {
    const body = repairSource.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await requestJson(c.req.raw))
    return c.json(maintenance().apply(body.reportId, body.sourceId, body.revision))
  })
  const learningMaintenance = () => {
    if (!options.learningMaintenance) throw new KnowledgeError('learning_maintenance_unavailable', 'Learning maintenance preview is unavailable', 503)
    return options.learningMaintenance
  }
  routes.get('/learning-maintenance/owner-plans/:revision', c => {
    if (!options.ownerMaintenancePlan) throw new KnowledgeError('owner_plan_unavailable', 'Owner maintenance is not available in this loaded instance', 503)
    try { return c.json(options.ownerMaintenancePlan(c.req.param('revision'))) }
    catch { throw new KnowledgeError('owner_plan_unavailable', 'Host plan missing or expired; inspect status and generate a new plan', 409) }
  })
  routes.get('/learning-maintenance/status', c => c.json(learningMaintenance().status()))
  routes.get('/learning-maintenance/candidates', async c => c.json(await learningMaintenance().candidates()))
  routes.get('/learning-maintenance/snapshots/:revision', c => c.json(learningMaintenance().readDocumentSnapshot(c.req.param('revision'))))
  routes.post('/learning-maintenance/documents', async c => {
    const body = await requestJson(c.req.raw)
    try { return c.json(learningMaintenance().inspectDocuments(body)) }
    catch (error) {
      if (error instanceof ZodError || error instanceof KnowledgeError) throw error
      throw new KnowledgeError('learning_maintenance_conflict', 'Document cannot be observed safely; inspect host protection policy or source revisions', 409)
    }
  })
  routes.post('/learning-maintenance/preview', async c => {
    const body = await requestJson(c.req.raw)
    try {
      if (body && typeof body === 'object' && Object.hasOwn(body, 'documents')) return c.json(learningMaintenance().previewDocuments(body))
      return c.json(await learningMaintenance().preview(body))
    }
    catch (error) {
      if (error instanceof ZodError || error instanceof KnowledgeError) throw error
      throw new KnowledgeError('learning_maintenance_conflict', 'Cannot attest complete unchanged sources/history; refresh candidates or inspect host diagnostics', 409)
    }
  })
  routes.post('/learning-maintenance/apply', async c => {
    // Strictly reject provenance/source payloads even while apply is disabled.
    maintenanceApplyRequest.parse(await requestJson(c.req.raw))
    learningMaintenance()
    throw new KnowledgeError('learning_maintenance_disabled', 'Learning maintenance integration is partial; apply is disabled and no state was changed', 503)
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
