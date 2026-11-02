import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { folderFixture } from '../folders/test-fixtures.ts'
import { HtmlPreviewLeases, createHtmlPreview } from './html-preview.ts'
import { registerGatewayRoutes, GatewayClientAddressRegistry } from './server.ts'
import { BrowserAuth } from './web-auth.ts'

const origin = 'http://127.0.0.1:43123'
test('preview leases isolate directory, encoding, symlinks, lifetime and read-only resources', async t => {
  const { workspace } = await folderFixture(t)
  const base = join(workspace, 'preview')
  await mkdir(join(base, 'page', 'assets'), { recursive: true })
  for (const [path, content] of [['page/index.html', '<link href="assets/site.css"><script type="module" src="assets/main.js"></script><img src="assets/a.svg">'], ['page/assets/site.css', 'body { background:url(a.svg) }'], ['page/assets/main.js', 'export const ok = true'], ['page/assets/a.svg', '<svg/>'], ['page/空 格.html', '<h1>Unicode</h1>'], ['secret.txt', 'secret']]) await writeFile(join(base, path!), content!)
  await symlink(join(base, 'secret.txt'), join(base, 'page', 'link.txt'))
  await symlink(base, join(base, 'page', 'escape'))
  let now = 100
  let available: string | undefined = base
  const store = new HtmlPreviewLeases(() => now)
  const owner = new AbortController()
  const lease = await store.create(base, 'page/index.html', origin, async () => available, owner.signal)
  const read = (path = lease.url, method = 'GET', host = origin) => store.serve(new Request(host + path, { method, headers: { Origin: 'null' } }))
  const html = await read()
  assert.equal(html?.status, 200)
  assert.match(await html!.text(), /assets\/site.css/)
  assert.match(html!.headers.get('content-security-policy')!, /sandbox allow-scripts;/)
  assert.doesNotMatch(html!.headers.get('content-security-policy')!, /allow-same-origin/)
  const prefix = lease.url.slice(0, lease.url.lastIndexOf('/') + 1)
  for (const path of ['assets/site.css', 'assets/main.js', 'assets/a.svg']) assert.equal((await read(prefix + path))?.status, 200)
  assert.equal((await read(prefix + 'assets/site.css', 'HEAD'))?.body, null)
  for (const path of ['%2e%2e%2fsecret.txt', '%252e%252e%252fsecret.txt', 'link.txt', 'escape/secret.txt', '%00', '%ZZ', 'assets%5c..%5csecret.txt']) assert.equal((await read(prefix + path))?.status, 404, path)
  assert.equal((await read(lease.url, 'POST'))?.status, 405)
  assert.equal((await read(lease.url, 'GET', 'http://other.test'))?.status, 404)
  const unicode = await store.create(base, 'page/空 格.html', origin, async () => available)
  assert.equal((await read(unicode.url))?.status, 200)
  store.revoke(unicode.url.split('/')[3]!)
  assert.equal((await read(unicode.url))?.status, 404)
  owner.abort()
  assert.equal((await read())?.status, 404)
  const expired = await store.create(base, 'page/index.html', origin, async () => available)
  now += 300_001
  assert.equal((await read(expired.url))?.status, 404)
  const revokedFolder = await store.create(base, 'page/index.html', origin, async () => available)
  available = undefined
  assert.equal((await read(revokedFolder.url))?.status, 404)
  await assert.rejects(store.create(base, '../secret.html', origin, async () => base))
  await assert.rejects(store.create(base, 'page/link.txt', origin, async () => base))
})

test('gateway permits opaque Origin only for valid leases; business API and static remain private; browser revocation cascades', async t => {
  const { workspace } = await folderFixture(t)
  await writeFile(join(workspace, 'index.html'), '<h1>preview</h1>')
  const addresses = new GatewayClientAddressRegistry()
  const auth = new BrowserAuth({ clientAddresses: addresses, launchCredential: 'fixture-secret' })
  const app = new Hono()
  registerGatewayRoutes(app, [auth.plugin(), gateway => {
    gateway.post('/projects/test/api/files/html-preview', c => createHtmlPreview(c, async () => workspace))
    gateway.post('/api/remote/html-preview', c => createHtmlPreview(c, async () => undefined))
    gateway.get('/api/private', c => c.text('private'))
    gateway.get('/api/files/static/index.html', c => c.text('private html'))
  }], { launchCredential: 'fixture-secret', browserAuth: auth, clientAddresses: addresses }, {})
  const request = (path: string, init?: RequestInit) => {
    const request = new Request(origin + path, init)
    addresses.capture(request, { transport: 'tcp', hostname: '127.0.0.1' })
    return app.request(request)
  }
  assert.equal((await request('/projects/test/api/files/html-preview?path=index.html', { method: 'POST' })).status, 401)
  const code = await (await request('/local/v1/web-pairing', { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' } })).json()
  const pairing = await request('/api/web-auth/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.code }) })
  const cookie = pairing.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie, Origin: origin }
  const response = await request('/projects/test/api/files/html-preview?path=index.html', { method: 'POST', headers })
  assert.equal(response.status, 200)
  const lease = await response.json()
  const opaque = { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } }
  assert.equal((await request(lease.url, opaque)).status, 200)
  for (const path of ['/api/private', '/api/files/static/index.html']) assert.equal((await request(path, opaque)).status, 401)
  assert.equal((await request('/api/remote/html-preview?path=index.html', { method: 'POST', headers })).status, 501)
  assert.equal((await request(lease.revokeUrl, { method: 'DELETE', headers })).status, 204)
  assert.equal((await request(lease.url, opaque)).status, 404)
  const second = await (await request('/projects/test/api/files/html-preview?path=index.html', { method: 'POST', headers })).json()
  await request('/api/web-auth/session', { method: 'DELETE', headers })
  assert.equal((await request(second.url, opaque)).status, 404)
})

test('lease capacity is bounded and reclaimed by revoke/expiry; LAN admission never authorizes other APIs', async t => {
  const { workspace } = await folderFixture(t)
  await writeFile(join(workspace, 'index.html'), 'ok')
  let now = 0
  const store = new HtmlPreviewLeases(() => now)
  const leases = []
  for (let i = 0; i < 128; i++) leases.push(await store.create(workspace, 'index.html', origin, async () => workspace))
  await assert.rejects(store.create(workspace, 'index.html', origin, async () => workspace), /preview_capacity/)
  store.revoke(leases[0]!.url.split('/')[3]!)
  await store.create(workspace, 'index.html', origin, async () => workspace)
  now += 300_001
  await store.create(workspace, 'index.html', origin, async () => workspace)
  const addresses = new GatewayClientAddressRegistry()
  const auth = new BrowserAuth({ clientAddresses: addresses, launchCredential: 'fixture-secret' })
  t.after(() => auth.close())
  const lan = 'http://192.168.1.20:43124'
  auth.lanOrigins.add(lan)
  const request = (path: string, method = 'GET', peer = '192.168.1.30', authorization?: string) => {
    const request = new Request(lan + path, { method, headers: { Origin: 'null', ...(authorization ? { Authorization: authorization } : {}) } })
    addresses.capture(request, { transport: 'tcp', hostname: peer })
    return auth.guardLanRequest(request)
  }
  assert.equal(request(leases[0]!.url), undefined)
  assert.equal(request(leases[0]!.url, 'HEAD'), undefined)
  assert.equal(request(leases[0]!.url, 'POST')?.status, 403)
  assert.equal(request(leases[0]!.url, 'GET', '8.8.8.8')?.status, 403)
  assert.equal(request(leases[0]!.url, 'GET', '192.168.1.30', 'Bearer fixture-secret')?.status, 403)
  assert.equal(request('/api/private')?.status, 403)
  assert.equal(request('/api/files/static/index.html')?.status, 403)
  auth.lanOrigins.clear()
  assert.equal(request(leases[0]!.url)?.status, 403)
})

test('real Folder lease route revalidates registry ownership and disposal without Main fallback', async t => {
  const { FolderRegistry } = await import('../folders/registry.ts')
  const { FolderService } = await import('../folders/routes.ts')
  const { workspace, folders } = await folderFixture(t)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  await writeFile(join(folders, 'index.html'), 'folder html')
  const folder = await registry.register(folders)
  const service = new FolderService({ registry, createSession: async () => ({ sessionId: 'unused', chatId: 'unused' }) })
  t.after(() => service.dispose())
  const app = new Hono()
  registerGatewayRoutes(app, [service.plugin], { launchCredential: 'fixture-secret' }, {})
  const response = await app.request(origin + `/api/folders/${folder.id}/html-preview?path=index.html`, { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' } })
  assert.equal(response.status, 200)
  const lease = await response.json()
  assert.equal((await app.request(origin + lease.url, { headers: { Origin: 'null' } })).status, 200)
  service.dispose()
  assert.equal((await app.request(origin + lease.url, { headers: { Origin: 'null' } })).status, 404)
})

test('session workspace lease is bound to persisted session existence and rechecks folder grants', async t => {
  const { sessionsApiPlugin } = await import('../sessions/routes.ts')
  const { sessionWorkspacePath } = await import('../utils/paths.ts')
  const { workspace } = await folderFixture(t)
  const storage = sessionWorkspacePath(workspace, 'demo')
  await mkdir(storage, { recursive: true })
  await writeFile(join(storage, 'index.html'), 'session html')
  let exists = true
  let allowed = true
  const state = { sessionId: 'demo', segmentIndex: 0 }
  const manager = { workspace,
    getSessionState: () => exists ? state : null,
    readSessionState: async () => exists ? state : null,
    assertFolderAccess: () => {},
    assertHistoricalFolderAccess: async () => { if (!allowed) throw new Error('folder revoked') },
  }
  const app = new Hono()
  registerGatewayRoutes(app, [sessionsApiPlugin(manager as unknown as import('../sessions/session-manager.ts').SessionManager)], { launchCredential: 'fixture-secret' }, {})
  const create = () => app.request(origin + '/api/sessions/demo/workspace/html-preview?path=index.html', { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' } })
  const response = await create()
  assert.equal(response.status, 200)
  const lease = await response.json()
  assert.equal((await app.request(origin + lease.url)).status, 200)
  allowed = false
  assert.equal((await app.request(origin + lease.url)).status, 404)
  allowed = true
  const second = await (await create()).json()
  exists = false
  assert.equal((await app.request(origin + second.url)).status, 404)
})
