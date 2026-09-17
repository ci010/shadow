import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import unoConfig from '../unocss.config.ts'

test('Vite 8 transforms Vue and proxies inventory without intercepting the Nodes page', async (t) => {
  const backend = createHttpServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ path: request.url }))
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  t.after(() => { backend.closeAllConnections(); backend.close() })
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  assert.ok(config.server?.proxy?.['/nodes/v1'])
  const target = `http://127.0.0.1:${address.port}`
  const vite = await createServer({
    ...config,
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      watch: null,
      proxy: Object.fromEntries(Object.entries(config.server.proxy).map(([path, proxy]) => [
        path, { ...(typeof proxy === 'string' ? {} : proxy), target },
      ])),
    },
  })
  t.after(() => vite.close())
  await vite.listen()
  const base = vite.resolvedUrls?.local[0]
  assert.ok(base)
  const signal = AbortSignal.timeout(15_000)
  const icons = await fetch(new URL('/@id/__x00__/__uno.css', base), { signal })
  assert.equal(icons.status, 200)
  const iconCss = await icons.text()
  const expectedIcons = unoConfig.content.inline[0]().split(' ')
  assert.ok(expectedIcons.length > 30, 'Scan actual application icon references')
  for (const icon of expectedIcons) {
    assert.ok(iconCss.includes(`.${icon}{`) || iconCss.includes(`.${icon},`),
      `${icon} must be available before any Vue route is requested`)
  }
  assert.match(iconCss, /data:image\/svg\+xml/)
  assert.doesNotMatch(iconCss, /https?:\/\/(?:api\.iconify|api\.simplesvg|api\.unisvg)/)
  assert.deepEqual(await (await fetch(new URL('/nodes/v1', base), { signal })).json(), { path: '/nodes/v1' })
  for (const path of [
    '/projects/default/api/sessions',
    '/projects/example/v1/query/logs',
    '/projects/example/api/channels?instance=one',
  ]) {
    assert.deepEqual(await (await fetch(new URL(path, base), { signal })).json(), { path })
  }
  for (const path of [
    '/projects',
    '/projects/default/chat/web%3Achat-example',
    '/projects/example/settings/bots',
    '/projects/example/logs',
  ]) {
    const projectPage = await fetch(new URL(path, base), { signal })
    assert.equal(projectPage.status, 200)
    assert.match(projectPage.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await projectPage.text(), /src\/main\.ts/)
  }
  const page = await fetch(new URL('/nodes', base), { signal })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /src\/main\.ts/)
  const component = await fetch(new URL('/src/components/ModelSelector.vue', base), { signal })
  assert.equal(component.status, 200)
  assert.match(await component.text(), /i-lucide-chevron-down/)
})
