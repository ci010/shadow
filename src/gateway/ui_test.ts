import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { registerProjectGateway } from '../projects/gateway.ts'
import { GatewayClientAddressRegistry } from './server.ts'
import { uiPlugin } from './ui.ts'
import { isBackendPath, isProjectPagePath, SCOPED_BACKEND_PATTERN } from './route-kind.ts'

test('PWA resources have browser-compatible MIME and update policy without SPA fallbacks', async () => {
  await withTempWorkspace(async root => {
    const dist = join(root, 'dist')
    await mkdir(join(dist, 'pwa'), { recursive: true })
    await writeFile(join(dist, 'index.html'), '<link rel="manifest" href="./manifest.webmanifest"><link rel="apple-touch-icon" href="./pwa/apple-touch-icon.png">')
    for (const path of ['manifest.webmanifest', 'sw.js', 'pwa/icon-192.png', 'pwa/icon-512.png', 'pwa/apple-touch-icon.png']) {
      await writeFile(join(dist, path), await readFile(new URL(`../../app/public/${path}`, import.meta.url)))
    }
    const app = new Hono()
    uiPlugin(dist)(app)
    const manifest = await app.request('/manifest.webmanifest')
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
    assert.equal(manifest.headers.get('cache-control'), 'no-cache')
    assert.equal((await manifest.json()).start_url, '/')
    const worker = await app.request('/sw.js')
    assert.match(worker.headers.get('content-type') ?? '', /javascript/)
    assert.equal(worker.headers.get('cache-control'), 'no-cache')
    for (const path of ['/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/apple-touch-icon.png']) {
      const response = await app.request(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
    }
    assert.match(await (await app.request('/projects/default/chat/web%3Aone')).text(), /href="\/manifest.webmanifest"/)
    assert.equal((await app.request('/pwa/missing.png')).status, 404)
    const missing = join(root, 'missing')
    await mkdir(missing)
    await writeFile(join(missing, 'index.html'), '<html>App shell</html>')
    const oldBuild = new Hono()
    uiPlugin(missing)(oldBuild)
    for (const path of ['/sw.js', '/manifest.webmanifest']) assert.equal((await oldBuild.request(path)).status, 404)
  })
})

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
    '/projects/org-a/knowledge',
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
      remove: id => catalog.remove(id),
      status: () => ({ state: 'ready' }),
      clientAddresses: new GatewayClientAddressRegistry(),
    })
    uiPlugin(dist)(app)
    for (const path of [
      '/projects', '/projects/default/chat/web%3Asession.with.dots',
      '/projects/default/settings/bots', '/projects/default/agents/general',
      '/projects/default/logs', '/projects/missing/settings/general',
      '/projects/default/knowledge',
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
