import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { ProjectCatalog } from './catalog.ts'
import { registerProjectGateway } from './gateway.ts'

test('gateway routes canonical Project content by owner and unscoped content to Default', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'home'))
    await catalog.init()
    const project = await catalog.create('Second')
    const targets = new Map(catalog.list().map(record => {
      const app = new Hono()
      app.get('/api/sessions', c => c.json({ projectId: record.id, query: c.req.query('key') }))
      app.post('/api/folders/register', async c => c.json({ projectId: record.id, body: await c.req.json() }))
      return [record.id, { app, run: <T>(callback: () => T) => callback() }] as const
    }))
    const app = new Hono()
    registerGatewayRoutes(app, [], { launchCredential: 'fixture-token' })
    registerProjectGateway(app, {
      catalog, lookup: id => targets.get(id), start: async () => {}, remove: id => catalog.remove(id),
      status: id => targets.has(id) ? { state: 'ready' } : { state: 'failed', error: 'Fixture startup failed' },
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }
    const read = async (path: string) => (await app.request(path, { headers })).json()
    assert.equal((await app.request(`/projects/${project.id}/api/sessions`)).status, 401)
    assert.deepEqual(await read(`/projects/${project.id}/api/sessions?key=a%2Fb`), { projectId: project.id, query: 'a/b' })
    assert.deepEqual(await read('/api/sessions'), { projectId: 'default' })
    assert.deepEqual(await read('/projects/default/api/sessions'), { projectId: 'default' })
    const created = await app.request(`/projects/${project.id}/api/folders/register`, { headers, method: 'POST', body: JSON.stringify({ path: 'fixture' }) })
    assert.deepEqual(await created.json(), { projectId: project.id, body: { path: 'fixture' } })
    assert.equal((await app.request('/projects/missing/api/sessions', { headers })).status, 404)
    const renamed = await app.request(`/api/projects/${project.id}`, { headers, method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) })
    assert.equal((await renamed.json()).project.name, 'Renamed')
    assert.equal((await read('/api/projects')).projects.length, 2)
    assert.equal((await app.request(`/unsupported/${project.id}/api/sessions`, { headers })).status, 404)
    assert.equal((await app.request('/api/unsupported', { headers })).status, 404)
    const scopedFolderAlias = await app.request(`/projects/${project.id}/api/projects/register`, {
      headers, method: 'POST', body: JSON.stringify({ path: 'fixture' }),
    })
    assert.equal(scopedFolderAlias.status, 404)
    assert.equal((await app.request('/unsupported/missing/api/sessions', { headers })).status, 404)
    targets.delete(project.id)
    const unavailable = await app.request(`/projects/${project.id}/api/sessions`, { headers })
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { state: 'failed', error: 'project_unavailable', message: 'Fixture startup failed' })
  })
})

test('Project routing preserves raw JSON, static assets and nested user data byte-for-byte', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'home'))
    await catalog.init()
    const target = new Hono()
    const contents = '{ "projectId": "user-data", "nested": { "folder": "unchanged" } }\n'
    for (const path of ['/api/sessions/demo/raw', '/api/sessions/demo/static/data.json',
      '/api/folders/demo/raw', '/api/folders/demo/static/data.json', '/asset.json']) {
      target.get(path, c => new Response(c.req.query('invalid') ? '{ invalid JSON' : contents, {
        headers: { 'content-type': 'application/json', etag: '"original-file"' },
      }))
    }
    target.get('/api/sessions', c => c.json({
      sessions: [{ projectId: 'default', folderId: 'folder', metadata: JSON.parse(contents) }],
    }))
    const app = new Hono()
    registerProjectGateway(app, {
      catalog, lookup: () => ({ app: target, run: callback => callback() }),
      start: async () => {}, remove: id => catalog.remove(id), status: () => ({ state: 'ready' }),
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    for (const prefix of ['/projects/default', '']) {
      for (const path of ['/api/sessions/demo/raw', '/api/sessions/demo/static/data.json',
        '/api/folders/demo/raw', '/api/folders/demo/static/data.json', '/asset.json']) {
        for (const invalid of [false, true]) {
          const response = await app.request(`${prefix}${path}${invalid ? '?invalid=1' : ''}`)
          assert.equal(response.status, 200)
          assert.equal(await response.text(), invalid ? '{ invalid JSON' : contents)
          assert.equal(response.headers.get('etag'), '"original-file"')
        }
        assert.equal((await app.request(`${prefix}${path}`, { method: 'HEAD' })).status, 200)
      }
    }
    assert.equal((await app.request('/projects/default/api/sessions', { method: 'HEAD' })).status, 200)
    assert.deepEqual(await (await app.request('/projects/default/api/sessions')).json(), {
      sessions: [{ projectId: 'default', folderId: 'folder', metadata: JSON.parse(contents) }],
    })
  })
})

test('project deletion is authorized, owner-specific, explicit on conflict and removes scoped access', async () => {
  await withTempWorkspace(async root => {
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const project = await catalog.create('Delete me')
    const app = new Hono()
    registerGatewayRoutes(app, [], { launchCredential: 'fixture-token' })
    let stopped = ''
    registerProjectGateway(app, {
      catalog, lookup: () => undefined, start: async () => {}, status: () => ({ state: 'failed' }),
      remove: id => catalog.remove(id, async () => { stopped = id }),
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    const path = `/api/projects/${project.id}`
    const headers = { authorization: 'Bearer fixture-token' }
    assert.equal((await app.request(path, { method: 'DELETE' })).status, 401)
    assert.equal(stopped, '')
    assert.equal((await app.request('/api/projects/default', { method: 'DELETE', headers })).status, 409)
    const response = await app.request(path, { method: 'DELETE', headers })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deletedProjectId: project.id })
    assert.equal(stopped, project.id)
    assert.equal((await app.request(path, { method: 'DELETE', headers })).status, 404)
    assert.equal((await app.request(`/projects/${project.id}/api/sessions`, { headers })).status, 404)
    assert.equal((await app.request(`/api/projects/${project.id}/retry`, { method: 'POST', headers })).status, 404)
  })
})
