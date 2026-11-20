import assert from 'node:assert/strict'
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from './server.ts'
import { THREE_LIMITS } from '../execution/filesystem/three-snapshot.ts'
import { FolderError, FolderRegistry } from '../folders/registry.ts'
import { FolderService } from '../folders/routes.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'

const marker = 'playground.three.json'
const query = (path = marker) => `/three-snapshot?path=${encodeURIComponent(path)}`

test('Playground HTTP snapshots honor folder/session roots, poll via ETag, and never run source', async t => {
  const { workspace, folders } = await folderFixture(t)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  const folder = await registry.register(folders)
  const service = new FolderService({ registry, createSession: async () => { throw new Error('unused') } })
  t.after(() => service.dispose())
  const app = new Hono()
  service.plugin(app)
  sessionsApiPlugin({
    workspace,
    readSessionState: async (key: string) => key === 'missing' ? null : ({ sessionId: key,
      workdir: { version: 2, nodeId: key === 'remote' ? 'child' : key === 'layerfs' ? 'layerfs' : 'local', workdirId: 'folder' } }),
    assertHistoricalFolderAccess: async (key: string) => { if (key === 'denied') throw new FolderError('folder_denied', folders, 409) },
    workdirLookup: (ref: { nodeId: string }) => ref.nodeId !== 'local'
      ? { node: 'offline' } : { node: 'online', workdir: { online: true, path: folders } },
  } as unknown as SessionManager)(app)
  const managed = sessionWorkspacePath(workspace, 'play')
  const js = 'throw new Error("must not execute");'
  for (const dir of [folders, managed]) {
    await mkdir(join(dir, 'assets'), { recursive: true })
    await mkdir(join(dir, 'shaders'))
    await writeFile(join(dir, marker), JSON.stringify({ files: ['main.mjs'], assets: ['assets/a.bin', 'scene.json', 'assets/data.json'],
      shaders: [{ objectId: 'cube', slot: 0, vertex: 'shaders/a.vert', fragment: 'shaders/a.frag' }] }))
    await writeFile(join(dir, 'main.mjs'), js)
    await writeFile(join(dir, 'assets/a.bin'), Buffer.from([0, 255]))
    await writeFile(join(dir, 'scene.json'), '{"name":"魔方"}')
    await writeFile(join(dir, 'assets/data.json'), '{}')
    await writeFile(join(dir, 'assets/unlisted.json'), '{}')
    await writeFile(join(dir, 'shaders/a.vert'), 'vertex')
    await writeFile(join(dir, 'shaders/a.frag'), 'fragment')
    await writeFile(join(dir, 'unlisted.mjs'), 'not returned')
  }
  for (const base of [`/api/folders/${folder.id}`, '/api/sessions/play', '/api/sessions/play/workspace']) {
    const response = await app.request(base + query())
    assert.equal(response.status, 200)
    const etag = response.headers.get('etag')!
    assert.match(etag, /^"[a-f0-9]{64}"$/)
    const body = await response.json()
    assert.match(body.version, /^[a-f0-9]{64}$/)
    assert.deepEqual(body.files, { 'main.mjs': js })
    assert.deepEqual(body.assets, { 'assets/a.bin': 'AP8=', 'assets/data.json': 'e30=', 'scene.json': Buffer.from('{"name":"魔方"}').toString('base64') })
    assert.deepEqual(body.shaders, [{ objectId: 'cube', slot: 0, vertex: 'vertex', fragment: 'fragment' }])
    const unchanged = await app.request(base + query(), { headers: { 'If-None-Match': etag } })
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.headers.get('etag'), etag)
    assert.equal(await unchanged.text(), '')
  }
  const browser = new Hono()
  const origin = 'http://localhost:5273'
  registerGatewayRoutes(browser, [service.plugin], { allowedOrigins: [origin], launchCredential: 'fixture' })
  const corsUrl = `/api/folders/${folder.id}` + query()
  const preflight = await browser.request(corsUrl, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization, If-None-Match',
  } })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-headers')!, /If-None-Match/i)
  const headers = { Origin: origin, Authorization: 'Bearer fixture' }
  const corsSnapshot = await browser.request(corsUrl, { headers })
  assert.equal(corsSnapshot.status, 200)
  const corsPoll = await browser.request(corsUrl, { headers: { ...headers, 'If-None-Match': corsSnapshot.headers.get('etag')! } })
  assert.equal(corsPoll.status, 304)
  assert.equal(corsPoll.headers.get('access-control-allow-origin'), origin)
  assert.match(corsPoll.headers.get('access-control-expose-headers')!, /ETag/i)

  const url = '/api/sessions/play' + query()
  const original = await app.request(url)
  const previous = await original.json()
  assert.equal(Object.hasOwn(previous, 'preview'), false)
  const markerFile = join(folders, marker)
  const manifest = { files: ['main.mjs'], assets: ['assets/a.bin', 'scene.json', 'assets/data.json'],
    shaders: [{ objectId: 'cube', slot: 0, vertex: 'shaders/a.vert', fragment: 'shaders/a.frag' }] }
  const preview = { toneMapping: 'aces', exposure: 4 }
  await writeFile(markerFile, JSON.stringify({ ...manifest, preview }))
  const previewResponse = await app.request(url, { headers: { 'If-None-Match': original.headers.get('etag')! } })
  assert.equal(previewResponse.status, 200)
  const previewBody = await previewResponse.json()
  assert.notEqual(previewBody.version, previous.version)
  assert.deepEqual({ ...previewBody, version: previous.version }, { ...previous, preview })
  for (const bad of ['null', '[]', '{"toneMapping":"linear"}', '{"exposure":1e999}', '{"exposure":0}', '{"exposure":4.01}', '{"exposure":"1"}', '{"extra":true}']) {
    await writeFile(markerFile, JSON.stringify(manifest).slice(0, -1) + `,"preview":${bad}}`)
    const response = await app.request(url)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'invalid_snapshot_preview')
  }
  await writeFile(markerFile, JSON.stringify(manifest))
  const file = join(folders, 'scene.json')
  await utimes(file, 1000, 1000)
  const touched = await app.request(url, { headers: { 'If-None-Match': original.headers.get('etag')! } })
  assert.notEqual(touched.headers.get('etag'), original.headers.get('etag'))
  assert.equal((await touched.json()).version, previous.version)
  await writeFile(file, '{"name":"新版"}')
  const edited = await app.request(url, { headers: { 'If-None-Match': touched.headers.get('etag')! } })
  assert.equal(edited.status, 200)
  assert.notEqual(edited.headers.get('etag'), touched.headers.get('etag'))
  assert.notEqual((await edited.json()).version, previous.version)
  // JSON assets stay opaque to the gateway, including invalid UTF-8/JSON.
  const invalid = Buffer.from([0x22, 0xff, 0x22])
  await writeFile(file, invalid)
  const opaque = await app.request(url)
  assert.equal(opaque.status, 200)
  assert.equal((await opaque.json()).assets['scene.json'], invalid.toString('base64'))
  for (const [key, status, code] of [['denied', 409, 'folder_denied'], ['remote', 501, 'remote_unsupported'], ['layerfs', 501, 'layerfs_unsupported'], ['missing', 404, 'session_not_found']] as const) {
    const response = await app.request(`/api/sessions/${key}` + query())
    assert.equal(response.status, status)
    const body = await response.json()
    assert.equal(body.error, code)
    assert.ok(body.id)
    assert.ok(!JSON.stringify(body).includes(folders))
  }
})

test('Playground snapshots reject traversal, links, non-allowlisted inputs and oversized files', async t => {
  const { workspace, folders } = await folderFixture(t)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  const folder = await registry.register(folders)
  const service = new FolderService({ registry, createSession: async () => { throw new Error('unused') } })
  t.after(() => service.dispose())
  const app = new Hono()
  service.plugin(app)
  const base = `/api/folders/${folder.id}`
  for (const path of ['../' + marker, '.git/' + marker, `a\\b/${marker}`, '/' + marker]) {
    assert.equal((await app.request(base + query(path))).status, 400)
  }
  await symlink(workspace, join(folders, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await app.request(base + query(`escape/${marker}`))).status, 400)
  for (const file of ['../secret.mjs', '.secret.mjs', 'bot.config.js', 'data.txt', 'x\\y.mjs']) {
    await writeFile(join(folders, marker), JSON.stringify({ files: ['main.mjs', file] }))
    const response = await app.request(base + query())
    assert.equal(response.status, 400)
    assert.equal((await response.json()).file, marker)
  }
  await mkdir(join(folders, 'settings'))
  for (const file of ['config.json', 'settings/scene.json', 'SCENE.JSON']) {
    await writeFile(join(folders, file), '{}')
    await writeFile(join(folders, marker), JSON.stringify({ files: ['main.mjs'], assets: [file] }))
    const response = await app.request(base + query())
    assert.equal(response.status, 400, file)
    assert.equal((await response.json()).error, 'invalid_snapshot_path')
  }
  await writeFile(join(folders, marker), JSON.stringify({ files: ['main.mjs'] }))
  const missing = await app.request(base + query())
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).file, 'main.mjs')
  await writeFile(join(folders, 'main.mjs'), Buffer.alloc(THREE_LIMITS.source + 1))
  const large = await app.request(base + query())
  assert.equal(large.status, 413)
  assert.equal((await large.json()).file, 'main.mjs')
})

test('Playground accepts Unicode directories and declared names and limits each shader source', async t => {
  const { workspace, folders } = await folderFixture(t)
  const registry = new FolderRegistry(workspace)
  await registry.init()
  const folder = await registry.register(folders)
  const service = new FolderService({ registry, createSession: async () => { throw new Error('unused') } })
  t.after(() => service.dispose())
  const app = new Hono()
  service.plugin(app)
  const dir = join(folders, '模型', '魔方')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(join(dir, 'shaders'))
  const module = '魔方٢\u0301.mjs'
  const vertex = 'shaders/顶点.vert'
  const fragment = 'shaders/片段.frag'
  await writeFile(join(dir, marker), JSON.stringify({ files: ['main.mjs', module], assets: ['assets/纹理.bin'],
    shaders: [{ objectId: '魔方', slot: 0, vertex, fragment }] }))
  await writeFile(join(dir, 'main.mjs'), `import './${module}'`)
  await writeFile(join(dir, module), 'export default "魔方"')
  await writeFile(join(dir, 'assets', '纹理.bin'), Buffer.from([255]))
  const text = '顶'.repeat(THREE_LIMITS.shaderText)
  await writeFile(join(dir, vertex), text)
  await writeFile(join(dir, fragment), '片段')
  const url = `/api/folders/${folder.id}` + query(`模型/魔方/${marker}`)
  const success = await app.request(url)
  assert.equal(success.status, 200)
  const body = await success.json()
  assert.equal(body.files[module], 'export default "魔方"')
  assert.deepEqual(body.assets, { 'assets/纹理.bin': '/w==' })
  assert.equal(body.shaders[0].vertex, text)

  await writeFile(join(dir, vertex), text + '顶')
  const tooLong = await app.request(url, { headers: { 'If-None-Match': success.headers.get('etag')! } })
  assert.equal(tooLong.status, 413)
  const error = await tooLong.json()
  assert.equal(error.error, 'snapshot_shader_text_limit')
  assert.equal(error.file, `模型/魔方/${vertex}`)

  for (const segment of ['COM¹', 'worKspace', '魔\u0000方', '魔\u202e方', '魔／方', '.魔方', '魔方\\目录']) {
    assert.equal((await app.request(`/api/folders/${folder.id}` + query(`模型/${segment}/${marker}`))).status, 400, segment)
  }
})
