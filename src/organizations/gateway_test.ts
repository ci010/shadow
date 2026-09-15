import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { OrganizationCatalog } from './catalog.ts'
import { registerOrganizationGateway } from './gateway.ts'

test('gateway keeps all org routes live and legacy routes permanently default-scoped', async () => {
  await withTempWorkspace(async root => {
    const catalog = new OrganizationCatalog(join(root, 'home'))
    await catalog.init()
    const org = await catalog.create('Second')
    const targets = new Map(catalog.list().map(record => {
      const app = new Hono()
      app.get('/api/sessions', c => c.json({ organizationId: record.id, query: c.req.query('key') }))
      app.post('/api/projects/register', async c => c.json({ organizationId: record.id, body: await c.req.json() }))
      return [record.id, { app, run: <T>(callback: () => T) => callback() }] as const
    }))
    const app = new Hono()
    registerGatewayRoutes(app, [], { launchCredential: 'fixture-token' })
    registerOrganizationGateway(app, {
      catalog, lookup: id => targets.get(id), start: async () => {},
      status: id => targets.has(id) ? { state: 'ready' } : { state: 'failed', error: 'Fixture startup failed' },
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }
    const read = async (path: string) => (await app.request(path, { headers })).json()
    assert.equal((await app.request(`/organizations/${org.id}/api/sessions`)).status, 401)
    assert.deepEqual(await read(`/organizations/${org.id}/api/sessions?key=a%2Fb`), { organizationId: org.id, query: 'a/b' })
    assert.deepEqual(await read('/api/sessions'), { organizationId: 'default' })
    assert.deepEqual(await read('/organizations/default/api/sessions'), { organizationId: 'default' })
    const created = await app.request(`/organizations/${org.id}/api/projects/register`, { headers, method: 'POST', body: JSON.stringify({ path: 'fixture' }) })
    assert.deepEqual(await created.json(), { organizationId: org.id, body: { path: 'fixture' } })
    assert.equal((await app.request('/organizations/missing/api/sessions', { headers })).status, 404)
    const renamed = await app.request(`/api/organizations/${org.id}`, { headers, method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) })
    assert.equal((await renamed.json()).organization.name, 'Renamed')
    assert.equal((await read('/api/organizations')).organizations.length, 2)
    targets.delete(org.id)
    const unavailable = await app.request(`/organizations/${org.id}/api/sessions`, { headers })
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { state: 'failed', error: 'organization_unavailable', message: 'Fixture startup failed' })
  })
})
