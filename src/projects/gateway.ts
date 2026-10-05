import type { Hono } from 'hono'
import type { ProjectCatalog } from './catalog.ts'
import { DEFAULT_PROJECT_ID } from './contracts.ts'
import { FolderError } from '../folders/registry.ts'
import type { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { isProjectPagePath } from '../gateway/route-kind.ts'

export interface ProjectRouteTarget {
  app: Hono
  run<T>(callback: () => T): T
}

export function registerProjectGateway(app: Hono, options: {
  catalog: ProjectCatalog
  lookup: (id: string) => ProjectRouteTarget | undefined
  start: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  status: (id: string) => { state: 'ready' | 'starting' | 'failed'; error?: string }
  clientAddresses: GatewayClientAddressRegistry
}): void {
  const unavailable = (id: string) => {
    const { error: message, ...status } = options.status(id)
    return { ...status, error: 'project_unavailable', message }
  }
  app.get('/api/projects', c => c.json({ projects: options.catalog.list() }))
  app.post('/api/projects', async c => {
    try {
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('name' in body) || Object.keys(body).some(key => key !== 'name')) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      const project = await options.catalog.create(body.name)
      await options.start(project.id)
      return c.json({ project, runtime: options.status(project.id) }, 201)
    } catch (error) {
      if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
      if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[projects] Creation failed', error)
      return c.json({ error: 'project_create_failed' }, 500)
    }
  })
  app.patch('/api/projects/:id', async c => {
    try {
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('name' in body) || Object.keys(body).some(key => key !== 'name')) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      return c.json({ project: await options.catalog.rename(c.req.param('id'), body.name) })
    } catch (error) {
      if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
      if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[projects] Rename failed', error)
      return c.json({ error: 'project_rename_failed' }, 500)
    }
  })
  app.get('/api/projects/:id/status', c => options.catalog.get(c.req.param('id'))
    ? c.json(options.status(c.req.param('id'))) : c.json({ error: 'project_not_found' }, 404))
  app.delete('/api/projects/:id', async c => {
    const id = c.req.param('id')
    try {
      await options.remove(id)
      return c.json({ deletedProjectId: id })
    } catch (error) {
      if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[projects] Deletion failed', error)
      return c.json({ error: 'project_delete_failed', message: 'Deletion did not finish. Retry deleting the project; pending deletion will also resume on Main restart.' }, 500)
    }
  })
  app.post('/api/projects/:id/retry', async c => {
    const id = c.req.param('id')
    if (!options.catalog.get(id)) return c.json({ error: 'project_not_found' }, 404)
    if (options.catalog.isDeleting(id)) return c.json({ error: 'project_deleting', message: 'Retry deleting this project.' }, 409)
    try {
      await options.start(id)
      return c.json(options.status(id))
    } catch (error) {
      if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[projects] Retry startup failed', error)
      return c.json({ error: 'project_start_failed', message: 'Project could not start. Check host diagnostics and retry.' }, 500)
    }
  })
  app.all('/projects/:projectId/*', async (c, next) => {
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && isProjectPagePath(c.req.path)) return next()
    const id = c.req.param('projectId')!
    if (!options.catalog.get(id)) return c.json({ error: 'project_not_found' }, 404)
    const target = options.catalog.isDeleting(id) ? undefined : options.lookup(id)
    if (!target) return c.json(unavailable(id), 503)
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace(/^\/projects\/[^/]+/, '') || '/'
    const request = new Request(url, c.req.raw)
    options.clientAddresses.inherit(c.req.raw, request)
    return target.run(() => target.app.fetch(request, c.env))
  })
  app.all('*', async (c, next) => {
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && isProjectPagePath(c.req.path)) return next()
    const target = options.lookup(DEFAULT_PROJECT_ID)
    if (!target) {
      if (/^\/(?:api|v1|debug|eval|otel)(?:\/|$)/.test(c.req.path)) {
        return c.json(unavailable(DEFAULT_PROJECT_ID), 503)
      }
      return next()
    }
    const response = await target.run(() => target.app.fetch(c.req.raw, c.env))
    if (response.status !== 404 || /^\/(?:api|v1|debug|eval|otel)(?:\/|$)/.test(c.req.path)) return response
    return next()
  })
}
