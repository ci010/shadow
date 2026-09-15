import type { Hono } from 'hono'
import type { OrganizationCatalog } from './catalog.ts'
import { DEFAULT_ORGANIZATION_ID } from './contracts.ts'
import { ProjectError } from '../projects/registry.ts'
import type { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { isOrganizationPagePath } from '../gateway/route-kind.ts'

export interface OrganizationRouteTarget {
  app: Hono
  run<T>(callback: () => T): T
}

export function registerOrganizationGateway(app: Hono, options: {
  catalog: OrganizationCatalog
  lookup: (id: string) => OrganizationRouteTarget | undefined
  start: (id: string) => Promise<void>
  status: (id: string) => { state: 'ready' | 'starting' | 'failed'; error?: string }
  clientAddresses: GatewayClientAddressRegistry
}): void {
  const unavailable = (id: string) => {
    const { error: message, ...status } = options.status(id)
    return { ...status, error: 'organization_unavailable', message }
  }
  app.get('/api/organizations', c => c.json({ organizations: options.catalog.list() }))
  app.post('/api/organizations', async c => {
    try {
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('name' in body) || Object.keys(body).some(key => key !== 'name')) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      const organization = await options.catalog.create(body.name)
      await options.start(organization.id)
      return c.json({ organization, runtime: options.status(organization.id) }, 201)
    } catch (error) {
      if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
      if (error instanceof ProjectError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[organizations] Creation failed', error)
      return c.json({ error: 'organization_create_failed' }, 500)
    }
  })
  app.patch('/api/organizations/:id', async c => {
    try {
      const body: unknown = await c.req.json()
      if (!body || typeof body !== 'object' || !('name' in body) || Object.keys(body).some(key => key !== 'name')) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      return c.json({ organization: await options.catalog.rename(c.req.param('id'), body.name) })
    } catch (error) {
      if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
      if (error instanceof ProjectError) return c.json({ error: error.code, message: error.message }, error.status)
      console.error('[organizations] Rename failed', error)
      return c.json({ error: 'organization_rename_failed' }, 500)
    }
  })
  app.get('/api/organizations/:id/status', c => options.catalog.get(c.req.param('id'))
    ? c.json(options.status(c.req.param('id'))) : c.json({ error: 'organization_not_found' }, 404))
  app.post('/api/organizations/:id/retry', async c => {
    const id = c.req.param('id')
    if (!options.catalog.get(id)) return c.json({ error: 'organization_not_found' }, 404)
    await options.start(id)
    return c.json(options.status(id))
  })
  app.all('/organizations/:organizationId/*', async (c, next) => {
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && isOrganizationPagePath(c.req.path)) return next()
    const id = c.req.param('organizationId')
    if (!options.catalog.get(id)) return c.json({ error: 'organization_not_found' }, 404)
    const target = options.lookup(id)
    if (!target) return c.json(unavailable(id), 503)
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace(/^\/organizations\/[^/]+/, '') || '/'
    const request = new Request(url, c.req.raw)
    options.clientAddresses.inherit(c.req.raw, request)
    return target.run(() => target.app.fetch(request, c.env))
  })
  app.all('*', async (c, next) => {
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && isOrganizationPagePath(c.req.path)) return next()
    const target = options.lookup(DEFAULT_ORGANIZATION_ID)
    if (!target) {
      if (/^\/(?:api|v1|debug|eval|otel)(?:\/|$)/.test(c.req.path)) {
        return c.json(unavailable(DEFAULT_ORGANIZATION_ID), 503)
      }
      return next()
    }
    const response = await target.run(() => target.app.fetch(c.req.raw, c.env))
    if (response.status !== 404 || /^\/(?:api|v1|debug|eval|otel)(?:\/|$)/.test(c.req.path)) return response
    return next()
  })
}
