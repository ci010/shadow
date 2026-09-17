import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { registerProjectGateway } from '../projects/gateway.ts'
import { GatewayClientAddressRegistry } from './server.ts'
import { uiPlugin } from './ui.ts'
import { isBackendPath, isProjectPagePath, SCOPED_BACKEND_PATTERN } from './route-kind.ts'

test('gateway and Vite distinguish scoped backend calls from project browser pages', () => {
  const proxy = new RegExp(SCOPED_BACKEND_PATTERN)
  for (const path of [
    '/projects/default/api/sessions', '/projects/org-a/v1/query/logs',
    '/projects/org-a/eval/bridge/call', '/projects/org-a/feishu/bots/one/file',
  ]) {
    assert(isBackendPath(path))
    assert(proxy.test(path))
    assert(!isProjectPagePath(path))
  }
  for (const path of [
    '/projects/default/chat/web%3Aone', '/projects/org-a/settings/bots',
    '/projects/org-a/agents/general', '/projects/org-a/spans',
    '/projects/org-a/logs',
  ]) {
    assert(!isBackendPath(path))
    assert(!proxy.test(path))
    assert(isProjectPagePath(path))
  }
  for (const path of ['/api', '/v1/query', '/nodes/v1', '/pair/v1/present', '/local/v1/shutdown', '/host/v1/query/logs']) {
    assert(isBackendPath(path))
  }
})

test('production org deep links serve the SPA with root assets without swallowing API failures', async () => {
  await withTempWorkspace(async root => {
    const dist = join(root, 'dist')
    await mkdir(join(dist, 'assets'), { recursive: true })
    await writeFile(join(dist, 'index.html'), '<html><script type="module" src="./assets/main.js"></script><link href="./assets/main.css" rel="stylesheet"></html>')
    await writeFile(join(dist, 'assets', 'main.js'), 'export const application = true')
    await writeFile(join(dist, 'assets', 'main.css'), 'body { color: black }')
    const catalog = new ProjectCatalog(join(root, 'host'))
    await catalog.init()
    const orgApp = new Hono()
    orgApp.get('/api/sessions', c => c.json({ projectId: 'default' }))
    const app = new Hono()
    registerProjectGateway(app, {
      catalog,
      lookup: id => id === 'default' ? { app: orgApp, run: callback => callback() } : undefined,
      start: async () => {},
      status: () => ({ state: 'ready' }),
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    uiPlugin(dist)(app)
    for (const path of [
      '/projects', '/projects/default/chat/web%3Asession.with.dots',
      '/projects/default/settings/bots', '/projects/default/agents/general',
      '/projects/default/logs', '/projects/missing/settings/general',
    ]) {
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      const html = await response.text()
      assert.match(html, /src="\/assets\/main\.js"/)
      assert.match(html, /href="\/assets\/main\.css"/)
      assert(!html.includes('src="./'))
    }
    assert.deepEqual(await (await app.request('/projects/default/api/sessions')).json(), { projectId: 'default' })
    for (const path of [
      '/projects/default/api/missing', '/projects/default/v1/query/missing',
      '/projects/missing/api/sessions', '/api/missing', '/nodes/v1/missing',
      '/pair/v1/missing', '/assets/missing.js',
    ]) {
      const response = await app.request(path)
      assert.equal(response.status, 404, path)
      assert(!/text\/html/.test(response.headers.get('content-type') ?? ''), path)
    }
    const script = await app.request('/assets/main.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
    assert.equal(await script.text(), 'export const application = true')
  })
})
