import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { request as httpRequest } from 'node:http'
import type { LLMProvider, LLMProviderOptions } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { appManifestSchema } from './contracts.ts'
import { MicroApps } from './service.ts'
import { microAppsPlugin } from './routes.ts'
import { localAppDirectory } from './store.ts'
import { MicroAppTool, microAppReceipt } from '../tools/micro-app.ts'
import { isAppPort } from './ports.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { Tools, SessionTools } from '../tools/registry.ts'

async function fixture(home: string) {
  const calls: LLMProviderOptions[] = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: async () => ['fixture'],
    chat: async (_messages, tools, options) => {
      assert.equal(tools.length, 0); calls.push(options)
      return { content: '日本語', toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }
    },
  }
  const service = new MicroApps('p', home, () => provider, () => 'fixture')
  await service.init()
  const directory = join(home, 'source'); await mkdir(directory)
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Fixture</title><button>Run</button>')
  const manifest = { version: 1, name: 'Fixture', description: 'Synthetic test app', entry: 'index.html',
    files: ['index.html'], llm: { maxCalls: 2, maxOutputTokens: 32 } }
  const publish = () => service.publish(directory, manifest, 'web:author', new AbortController().signal)
  const connect = async (id: string) => {
    const { url } = await service.open(id)
    const parsed = new URL(url), ticket = new URLSearchParams(parsed.hash.slice(1)).get('shadow_ticket')!
    const response = await fetch(`${parsed.origin}/_shadow/connect`, { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } })
    assert.equal(response.status, 200)
    const { token } = await response.json() as { token: string }
    return { origin: parsed.origin, token, ticket }
  }
  return { service, provider, calls, directory, manifest, publish, connect }
}
const post = (origin: string, path: string, token: string, body: unknown) => fetch(origin + path, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('publication checks distinguish current source from shipped files without changing approval or running code', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await writeFile(join(f.directory, 'old.txt'), 'old')
    const manifest = { ...f.manifest, files: ['index.html', 'old.txt'] }
    const app = await f.service.publish(f.directory, manifest, 'web:author', AbortSignal.timeout(5000))
    await f.service.approve(app.id, app.revision)
    const before = f.service.get(app.id)
    const check = (candidate = manifest) => f.service.checkPublication(app.id, app.revision, f.directory, candidate, AbortSignal.timeout(5000))
    const same = await check()
    assert.equal(same.publicationCheck.matchesPublished, true)
    assert.equal(same.publicationCheck.candidateRevision, app.revision)
    assert.equal(same.publicationCheck.scope, 'listed-bundle-files-only')
    assert.deepEqual(same.publicationCheck.files, { added: [], modified: [], removed: [] })
    await writeFile(join(f.directory, 'index.html'), '<title>Unpublished fix</title>')
    await writeFile(join(f.directory, 'helper.txt'), 'new')
    const candidate = { ...manifest, description: 'Updated draft', files: ['index.html', 'helper.txt'] }
    const changed = await check(candidate)
    assert.equal(changed.publicationCheck.matchesPublished, false)
    assert.equal(changed.publicationCheck.manifestChanged, true)
    assert.deepEqual(changed.publicationCheck.files, { added: ['helper.txt'], modified: ['index.html'], removed: ['old.txt'] })
    assert.deepEqual(f.service.get(app.id), before, 'Inspection must not publish, clear approval or create a run')
    assert.equal(f.calls.length, 0)
    const updated = await f.service.publish(f.directory, candidate, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    assert.equal(updated.revision, changed.publicationCheck.candidateRevision)
    assert.equal(updated.approval, undefined)
    assert.equal((await f.service.checkPublication(app.id, updated.revision, f.directory, candidate, AbortSignal.timeout(5000))).publicationCheck.matchesPublished, true)
    await assert.rejects(f.service.start(app.id), /approve/)
  } finally { await f.service.shutdown() }
}))

test('publication checks reject stale, canceled and concurrently replaced revisions', async t => withTempWorkspace(async home => {
  const f = await fixture(home)
  const resume = Promise.withResolvers<void>()
  try {
    const app = await f.publish()
    await assert.rejects(f.service.checkPublication(app.id, '0'.repeat(64), f.directory, f.manifest, AbortSignal.timeout(5000)), /Reload/)
    const reason = new Error('Canceled comparison')
    await assert.rejects(f.service.checkPublication(app.id, app.revision, f.directory, f.manifest, AbortSignal.abort(reason)), error => error === reason)
    const entered = Promise.withResolvers<void>(), original = f.service.store.bundle.bind(f.service.store)
    t.mock.method(f.service.store, 'bundle', async (...args: Parameters<typeof original>) => {
      const bundle = await original(...args)
      entered.resolve()
      await resume.promise
      return bundle
    })
    const checking = f.service.checkPublication(app.id, app.revision, f.directory, f.manifest, AbortSignal.timeout(5000))
    await entered.promise
    await writeFile(join(f.directory, 'index.html'), 'New publication')
    await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    resume.resolve()
    await assert.rejects(checking, /changed during the publication check/)
  } finally { resume.resolve(); await f.service.shutdown() }
}))

test('publication checks share file limits, link rejection and published integrity checks', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish()
    const check = (manifest = f.manifest) => f.service.checkPublication(app.id, app.revision, f.directory, manifest, AbortSignal.timeout(5000))
    await assert.rejects(check({ ...f.manifest, files: ['index.html', 'missing.txt'] }), { code: 'ENOENT' })
    await writeFile(join(f.directory, 'large.txt'), Buffer.alloc(4 * 1024 * 1024 + 1))
    await assert.rejects(check({ ...f.manifest, files: ['index.html', 'large.txt'] }), /exceeds 4 MiB/)
    const target = join(home, 'linked-source')
    await mkdir(target)
    await writeFile(join(target, 'helper.txt'), 'not a regular bundled path')
    await fs.promises.symlink(target, join(f.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(check({ ...f.manifest, files: ['index.html', 'linked/helper.txt'] }), /symbolic links/)
    const bundle = await f.service.store.bundle(f.service.store.get(app.id))
    bundle.files['index.html'] = Buffer.from('Tampered published code').toString('base64')
    await writeFile(join(f.service.store.root, app.id, `${app.revision}.json`), JSON.stringify(bundle))
    await assert.rejects(check(), /changed after publication/)
  } finally { await f.service.shutdown() }
}))

test('packaged dependency failures can be diagnosed, republished, reviewed and reopened without author-directory assumptions', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  let restored: MicroApps | undefined
  try {
    await writeFile(join(f.directory, 'helper.mjs'), 'export const ready = "packaged ready";')
    await writeFile(join(f.directory, 'server.mjs'), `
      import {createServer} from 'node:http';
      import {ready} from './helper.mjs';
      createServer((request,response)=>{
        if(request.headers.authorization !== 'Bearer ' + process.env.SHADOW_APP_TOKEN) {
          response.writeHead(401).end(); return;
        }
        response.end(ready);
      }).listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');
    `)
    const manifest = { ...f.manifest, files: ['index.html', 'server.mjs'],
      backend: { runtime: 'node', entry: 'server.mjs' } }
    const app = await f.service.publish(f.directory, manifest, 'web:author', AbortSignal.timeout(5000))
    const same = await f.service.checkPublication(app.id, app.revision, f.directory, manifest, AbortSignal.timeout(5000))
    assert.equal(same.publicationCheck.matchesPublished, true, 'Matching listed files cannot certify unlisted dependencies')
    await f.service.approve(app.id, app.revision)
    await assert.rejects(f.service.start(app.id), /missing or unloadable dependency/)
    assert.match(f.service.get(app.id).lastRun!.error!, /published file list/)
    assert.equal(f.service.get(app.id).status, 'failed')
    assert.equal(f.service.get(app.id).cleanupPending, false)
    const complete = { ...manifest, files: [...manifest.files, 'helper.mjs'] }
    const draft = await f.service.checkPublication(app.id, app.revision, f.directory, complete, AbortSignal.timeout(5000))
    assert.equal(draft.publicationCheck.matchesPublished, false)
    assert.deepEqual(draft.publicationCheck.files.added, ['helper.mjs'])
    const fixed = await f.service.publish(f.directory, complete, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    assert.equal(fixed.revision, draft.publicationCheck.candidateRevision)
    assert.equal(fixed.status, 'awaiting_approval')
    await assert.rejects(f.service.start(app.id), /approve/)
    await f.service.approve(app.id, fixed.revision)
    const first = await f.connect(app.id)
    assert.equal(await (await post(first.origin, '/backend/health', first.token, {})).text(), 'packaged ready')
    const runId = f.service.get(app.id).lastRun!.id
    await f.service.shutdown()
    restored = new MicroApps('p', home, () => f.provider, () => 'fixture')
    await restored.init()
    await restored.start(app.id)
    assert.equal(restored.get(app.id).revision, fixed.revision)
    assert.equal(restored.get(app.id).status, 'running')
    assert.notEqual(restored.get(app.id).lastRun!.id, runId)
    assert.equal(f.calls.length, 0)
  } finally { await restored?.shutdown(); await f.service.shutdown() }
}))

test('cleanup failures remain visible and retryable without losing approval or permitting a new run', async t => withTempWorkspace(async home => {
  const f = await fixture(home)
  const original = fs.promises.rm
  let failed = false
  let restore: (() => void) | undefined
  try {
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    await f.connect(app.id)
    const record = f.service.get(app.id)
    const runPath = join(f.service.store.root, app.id, 'runs', record.lastRun!.id)
    await mkdir(runPath, { recursive: true })
    await writeFile(join(runPath, 'pending.tmp'), 'Synthetic temporary app data')
    const remove = t.mock.method(fs.promises, 'rm', async (...[path, options]: Parameters<typeof original>) => {
      if (!failed && String(path) === runPath) {
        failed = true
        throw Object.assign(new Error('Synthetic busy file'), { code: 'EBUSY' })
      }
      return original(path, options)
    })
    restore = () => { remove.mock.restore(); syncBuiltinESMExports() }
    syncBuiltinESMExports()
    await assert.rejects(f.service.stop(app.id), /cleanup failed during temporary run removal/)
    const pending = f.service.get(app.id)
    assert.equal(pending.status, 'failed')
    assert.equal(pending.cleanupPending, true)
    assert.deepEqual(pending.approval, record.approval)
    assert.equal(pending.calls, record.calls)
    await assert.rejects(f.service.open(app.id), /Retry Stop/)
    await assert.rejects(f.service.approve(app.id, app.revision), /Stop the app/)
    await Promise.all([f.service.stop(app.id), f.service.stop(app.id)])
    assert.equal(f.service.get(app.id).cleanupPending, false)
    assert.equal(f.service.get(app.id).status, 'stopped')
    assert.deepEqual(await readdir(join(f.service.store.root, app.id, 'runs')), [])
    await f.connect(app.id)
    assert.notEqual(f.service.get(app.id).lastRun!.id, record.lastRun!.id)
  } finally {
    restore?.()
    await f.service.shutdown()
  }
}))

test('failed startup cleanup reports a failed retained run and remains retryable', async t => withTempWorkspace(async home => {
  const f = await fixture(home)
  const original = fs.promises.rm
  let restore: (() => void) | undefined
  try {
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    t.mock.method(f.service.store, 'bundle', async () => { throw new Error('Synthetic bundle failure') }, { times: 1 })
    const remove = t.mock.method(fs.promises, 'rm', async () => { throw new Error('Synthetic cleanup failure') })
    restore = () => { remove.mock.restore(); syncBuiltinESMExports() }
    syncBuiltinESMExports()
    await assert.rejects(f.service.open(app.id), /cleanup failed during temporary run removal/)
    assert.equal(f.service.get(app.id).status, 'failed')
    assert.equal(f.service.get(app.id).cleanupPending, true)
    assert.match(f.service.get(app.id).lastRun!.error!, /temporary run removal/)
    await assert.rejects(f.service.open(app.id), /Retry Stop/)
    restore()
    assert.equal(fs.promises.rm, original)
    await f.service.stop(app.id)
    assert.equal(f.service.get(app.id).cleanupPending, false)
    await f.connect(app.id)
  } finally {
    restore?.()
    await f.service.shutdown()
  }
}))

test('app state persists independently of browser origins and requires scoped access and the current version', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish(), other = await f.publish()
    await f.service.approve(app.id, app.revision)
    await f.service.approve(other.id, other.revision)
    const first = await f.connect(app.id), second = await f.connect(other.id)
    const get = (origin: string, token: string) => fetch(origin + '/_shadow/state', { headers: { Authorization: `Bearer ${token}` } })
    const put = (token: string, body: unknown) => fetch(first.origin + '/_shadow/state', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal((await fetch(first.origin + '/_shadow/state')).status, 401)
    assert.equal((await get(first.origin, second.token)).status, 401)
    assert.deepEqual(await (await get(first.origin, first.token)).json(), { version: 0, values: {} })
    const concurrent = await Promise.all(['ja', 'en'].map(language => put(first.token, { version: 0, values: { language } })))
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
    const conflict = concurrent.find(r => r.status === 409)!
    assert.equal((await conflict.json()).error, 'app_state_conflict')
    const values = { language: 'ja', device: { id: 'synthetic-device', volume: .5 }, choices: ['a', null, true] }
    assert.equal((await put(first.token, { version: 1, values })).status, 200)
    assert.equal((await put(first.token, { values })).status, 400)
    assert.equal((await put(first.token, { version: 2, values: { text: 'x'.repeat(65536) } })).status, 413)
    assert.deepEqual(await (await get(first.origin, first.token)).json(), { version: 2, values })
    assert.deepEqual(await (await get(second.origin, second.token)).json(), { version: 0, values: {} })
    assert.equal(f.service.get(app.id).calls, 0)
    const status = await (await fetch(first.origin + '/_shadow/status', { headers: { Authorization: `Bearer ${first.token}` } })).json()
    assert.equal(status.capabilities.storage.browserPartition, 'ephemeral-per-native-window')
    await f.service.stop(app.id)
    const reopened = await f.connect(app.id)
    assert.equal((await get(reopened.origin, first.token)).status, 401)
    assert.deepEqual(await (await get(reopened.origin, reopened.token)).json(), { version: 2, values })
    await f.service.shutdown()
    const restored = new MicroApps('p', home, () => f.provider, () => 'fixture')
    try {
      await restored.init()
      assert.deepEqual(restored.store.loadState(app.id), { version: 2, values })
      await writeFile(join(f.directory, 'index.html'), '<title>New revision</title>')
      const changed = await restored.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
      assert.equal(changed.approval, undefined)
      assert.deepEqual(restored.store.loadState(app.id), { version: 2, values })
    } finally { await restored.shutdown() }
  } finally { await f.service.shutdown() }
}))

test('invalid persistent app state is reported rather than silently reset or overwritten', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    const { origin, token } = await f.connect(app.id)
    const path = join(f.service.store.root, app.id, 'state.json')
    for (const corrupt of ['{broken', '{"version":-1,"values":{}}', 'x'.repeat(65537)]) {
      await writeFile(path, corrupt)
      const response = await fetch(origin + '/_shadow/state', { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error, 'invalid_app_state')
      assert.throws(() => f.service.store.saveState(app.id, { version: 0, values: {} }), /Stored app state/)
      assert.equal(await readFile(path, 'utf8'), corrupt)
    }
  } finally { await f.service.shutdown() }
}))

test('reviewed PNG branding has a bounded owner-only endpoint and changes invalidate approval', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQiT74HwAEJwJAst2PdAAAAABJRU5ErkJggg==', 'base64')
  try {
    const legacy = await f.publish()
    await f.service.approve(legacy.id, legacy.revision)
    const same = await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), legacy.id, legacy.revision)
    assert.equal(same.revision, legacy.revision)
    assert.ok(same.approval)
    await writeFile(join(f.directory, 'icon.png'), png)
    const manifest = { ...f.manifest, icon: 'icon.png', files: ['index.html', 'icon.png'] }
    const branded = await f.service.publish(f.directory, manifest, 'web:author', AbortSignal.timeout(5000), legacy.id, legacy.revision)
    assert.equal(branded.approval, undefined)
    assert.notEqual(branded.revision, legacy.revision)
    const host = new Hono()
    microAppsPlugin(f.service, req => req.headers.get('x-owner') === 'yes')(host)
    const url = `/api/microapps/${branded.id}/icon?revision=${branded.revision}`
    assert.equal((await host.request(url)).status, 401)
    const response = await host.request(url, { headers: { 'x-owner': 'yes' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
    assert.equal((await host.request(`/api/microapps/${branded.id}/icon?revision=${legacy.revision}`, { headers: { 'x-owner': 'yes' } })).status, 409)
    const metadata = await (await host.request(`/api/microapps/${branded.id}/status`, { headers: { 'x-owner': 'yes' } })).json()
    assert.equal(metadata.files, undefined)
    assert.equal(metadata.manifest.icon, 'icon.png')
    await f.service.approve(branded.id, branded.revision)
    await writeFile(join(f.directory, 'next.png'), png)
    const changed = await f.service.publish(f.directory, { ...manifest, icon: 'next.png', files: ['index.html', 'icon.png', 'next.png'] },
      'web:author', AbortSignal.timeout(5000), branded.id, branded.revision)
    assert.equal(changed.approval, undefined)
    await assert.rejects(f.service.publish(f.directory, { ...manifest, icon: 'missing.png' }, 'author', AbortSignal.timeout(5000)), /Icon must be in files/)
    await assert.rejects(f.service.publish(f.directory, { ...manifest, icon: 'icon.svg' }, 'author', AbortSignal.timeout(5000)), /PNG/)
    const oversized = Buffer.from(png); oversized.writeUInt32BE(513, 16)
    await writeFile(join(f.directory, 'icon.png'), oversized)
    await assert.rejects(f.service.publish(f.directory, manifest, 'author', AbortSignal.timeout(5000)), /512/)
    await writeFile(join(f.directory, 'icon.png'), 'not a PNG')
    await assert.rejects(f.service.publish(f.directory, manifest, 'author', AbortSignal.timeout(5000)), /PNG/)
  } finally { await f.service.shutdown() }
}))

test('ephemeral ports must also be accepted by browser and Node Fetch', async () => {
  for (const port of [0, -1, 65536, 6000, 6665, 6666, 6697, 10080]) assert.equal(isAppPort(port), false)
  for (const port of [1024, 5273, 15000, 49152, 65535]) assert.equal(isAppPort(port), true)
  await assert.rejects(fetch('http://127.0.0.1:6000'), error => error instanceof TypeError && error.cause instanceof Error && error.cause.message === 'bad port')
})

test('immutable publication and approval survive restart without replaying processes or resetting call allowance', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish()
    assert.equal(app.status, 'awaiting_approval')
    await assert.rejects(f.service.start(app.id), /approve/)
    await assert.rejects(f.service.approve(app.id, '0'.repeat(64)), /current app revision/)
    await f.service.approve(app.id, app.revision)
    const { origin, token, ticket } = await f.connect(app.id)
    assert.equal((await fetch(origin)).status, 200)
    assert.equal((await fetch(origin)).headers.get('x-content-type-options'), 'nosniff')
    assert.match((await fetch(origin)).headers.get('content-security-policy')!, /connect-src 'self'/)
    assert.equal((await post(origin, '/_shadow/connect', ticket, {})).status, 401, 'One-use opening')
    const input = { messages: [{ role: 'user', content: 'Translate' }], maxTokens: 4096 }
    assert.equal((await post(origin, '/_shadow/generate', token, input)).status, 200)
    assert.equal(f.calls[0].maxTokens, 32)
    assert.equal(f.calls[0].model, 'fixture')
    assert.equal(f.service.get(app.id).calls, 1)
    await f.service.stop(app.id)
    await assert.rejects(fetch(origin))
    const reopened = await f.connect(app.id)
    assert.equal((await post(reopened.origin, '/_shadow/generate', token, input)).status, 401, 'Old token cannot access a new run')
    assert.equal((await post(reopened.origin, '/_shadow/generate', reopened.token, input)).status, 200)
    assert.equal((await post(reopened.origin, '/_shadow/generate', reopened.token, input)).status, 429)
    await f.service.shutdown()
    const fresh = new MicroApps('p', home, () => f.provider, () => 'fixture')
    await fresh.init()
    try {
      assert.equal(fresh.get(app.id).calls, 2)
      assert.equal(fresh.get(app.id).status, 'stopped')
      await fresh.start(app.id)
      assert.equal(fresh.get(app.id).status, 'running')
    } finally { await fresh.shutdown() }
  } finally { await f.service.shutdown() }
}))

test('scoped credentials cannot cross apps, origins, host routes, model grants or request schemas', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const a = await f.publish(), b = await f.publish()
    await f.service.approve(a.id, a.revision)
    await f.service.approve(b.id, b.revision)
    const first = await f.connect(a.id), second = await f.connect(b.id)
    const input = { messages: [{ role: 'user', content: 'Hello' }] }
    assert.equal((await post(second.origin, '/_shadow/generate', first.token, input)).status, 401)
    assert.equal((await fetch(first.origin + '/_shadow/status', { headers: { Authorization: `Bearer ${first.token}`, Origin: 'https://untrusted.test' } })).status, 403)
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(first.origin, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject).end()
    })
    assert.equal(wrongHost, 403)
    assert.equal((await post(first.origin, '/api/microapps', first.token, {})).status, 404)
    for (const extra of [{ model: 'unapproved' }, { tools: [] }, { messages: [{ role: 'tool', content: 'x' }] }]) {
      assert.equal((await post(first.origin, '/_shadow/generate', first.token, { ...input, ...extra })).status, 400)
    }
    assert.equal(f.calls.length, 0)
    await f.service.revoke(a.id)
    await assert.rejects(fetch(first.origin))
    await assert.rejects(f.service.open(a.id), /approve/)
    assert.equal((await post(second.origin, '/_shadow/generate', second.token, input)).status, 200)
  } finally { await f.service.shutdown() }
}))

test('changed code requires review again; tampered snapshots and concurrent control never use old approval', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    const unchanged = await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    assert.ok(unchanged.approval)
    await writeFile(join(f.directory, 'index.html'), '<title>Changed app</title>')
    await assert.rejects(f.service.publish(f.directory, f.manifest, 'web:other', AbortSignal.timeout(5000), app.id, app.revision), /original author/)
    const changed = await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    assert.notEqual(changed.revision, app.revision)
    assert.equal(changed.approval, undefined)
    await assert.rejects(f.service.start(app.id), /approve/)
    await f.service.approve(app.id, changed.revision)
    const path = join(f.service.store.root, app.id, `${changed.revision}.json`)
    const bundle = JSON.parse(await readFile(path, 'utf8'))
    bundle.files['index.html'] = Buffer.from('tampered').toString('base64')
    await writeFile(path, JSON.stringify(bundle))
    await assert.rejects(f.service.start(app.id), /changed after publication/)
    assert.equal(f.service.get(app.id).status, 'failed')
  } finally { await f.service.shutdown() }
}))

test('backend readiness, proxy, private environment and persistent data use the owned process lifecycle', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const server = `import http from 'node:http'; import fs from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os';
      const data = path.join(process.env.SHADOW_APP_DATA, 'count.txt');
      const temporary = path.join(os.tmpdir(), 'transient-audio.wav'); await fs.writeFile(temporary, 'synthetic temporary audio');
      http.createServer(async (req, res) => {
        if(req.headers.authorization !== 'Bearer ' + process.env.SHADOW_APP_TOKEN) {res.writeHead(401).end();return;}
        if(req.url === '/health') {res.end('ok');return;}
        let count=0; try {count=Number(await fs.readFile(data,'utf8'))} catch(e) {if(e.code!=='ENOENT') throw e}
        await fs.writeFile(data,String(++count));res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({count,secret:!!process.env.SHADOW_TEST_PRIVATE_SECRET,nodeMode:process.env.ELECTRON_RUN_AS_NODE,pid:process.pid,
          temporary, temp:process.env.SHADOW_APP_TEMP, defaults:[process.env.TEMP,process.env.TMP,process.env.TMPDIR]}));
      }).listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');`
    await writeFile(join(f.directory, 'server.mjs'), server)
    const app = await f.service.publish(f.directory, { ...f.manifest, files: ['index.html', 'server.mjs'],
      backend: { runtime: 'node', entry: 'server.mjs' } }, 'web:author', AbortSignal.timeout(5000))
    await f.service.approve(app.id, app.revision)
    const before = process.env.SHADOW_TEST_PRIVATE_SECRET
    process.env.SHADOW_TEST_PRIVATE_SECRET = 'synthetic-must-not-inherit'
    let first: Awaited<ReturnType<typeof f.connect>>
    try { first = await f.connect(app.id) }
    finally { if (before === undefined) delete process.env.SHADOW_TEST_PRIVATE_SECRET; else process.env.SHADOW_TEST_PRIVATE_SECRET = before }
    assert.equal((await fetch(first.origin + '/server.mjs')).status, 404)
    assert.equal((await fetch(first.origin + '/backend/count')).status, 401)
    const value = await (await post(first.origin, '/backend/count', first.token, {})).json()
    assert.equal(value.count, 1); assert.equal(value.secret, false)
    assert.equal(value.nodeMode, '1', 'Packaged Electron runs app scripts as Node')
    assert.deepEqual(value.defaults, [value.temp, value.temp, value.temp])
    assert.equal(value.temporary, join(value.temp, 'transient-audio.wav'))
    assert.equal(await readFile(value.temporary, 'utf8'), 'synthetic temporary audio')
    assert.equal((await fetch(first.origin + '/.tmp/transient-audio.wav')).status, 404)
    await f.service.stop(app.id)
    assert.throws(() => process.kill(value.pid, 0), /ESRCH/)
    await assert.rejects(readFile(value.temporary), { code: 'ENOENT' })
    const second = await f.connect(app.id)
    const again = await (await post(second.origin, '/backend/count', second.token, {})).json()
    assert.equal(again.count, 2)
    assert.notEqual(again.temp, value.temp)
  } finally { await f.service.shutdown() }
}))

test('backend proxy preserves application headers and binary bodies without forwarding browser credentials or transport headers', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await writeFile(join(f.directory, 'server.mjs'), `
      import http from 'node:http';
      http.createServer(async (req,res)=>{
        if(req.headers.authorization !== 'Bearer ' + process.env.SHADOW_APP_TOKEN) {res.writeHead(401).end();return;}
        if(req.url === '/health') {res.end('ok');return;}
        const chunks=[]; for await(const chunk of req) chunks.push(chunk);
        const {authorization,...headers}=req.headers;
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({headers,body:Buffer.concat(chunks).toString('base64'),url:req.url}));
      }).listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');
    `)
    const app = await f.service.publish(f.directory, { ...f.manifest, files: ['index.html', 'server.mjs'],
      backend: { runtime: 'node', entry: 'server.mjs' } }, 'web:author', AbortSignal.timeout(5000))
    await f.service.approve(app.id, app.revision)
    const { origin, token } = await f.connect(app.id)
    const body = Buffer.from([82, 73, 70, 70, 0, 255, 128, 10])
    const response = await fetch(origin + '/backend/recognize?mode=file', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav',
        'X-Language': 'ja', 'X-App-Request': 'fixture-request', Accept: 'application/json' }, body,
    })
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.headers['x-language'], 'ja')
    assert.equal(value.headers['x-app-request'], 'fixture-request')
    assert.equal(value.headers['content-type'], 'audio/wav')
    assert.equal(value.headers.accept, 'application/json')
    assert.equal(value.body, body.toString('base64'))
    assert.equal(value.url, '/recognize?mode=file')
    assert.notEqual(value.headers.host, new URL(origin).host)

    const isolated = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const request = httpRequest(origin + '/backend/recognize', { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav', 'X-Language': 'en',
        Cookie: 'synthetic-browser-cookie', 'Proxy-Authorization': 'synthetic-proxy-credential',
        Origin: origin, Referer: origin + '/private', 'Sec-Fetch-Site': 'same-origin',
        Forwarded: 'host=untrusted.invalid', 'X-Forwarded-Host': 'untrusted.invalid',
        Connection: 'close, X-Transport-Only', 'X-Transport-Only': 'must-not-forward',
      } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
      })
      request.on('error', reject)
      request.end(body)
    })
    assert.equal(isolated.status, 200, 'Host supplies the backend credential, not the browser credential')
    const second = JSON.parse(isolated.body)
    assert.equal(second.headers['x-language'], 'en')
    assert.equal(second.body, body.toString('base64'))
    assert.equal(Number(second.headers['content-length']), body.length, 'Forwarded framing is regenerated for the buffered body')
    for (const name of ['cookie', 'proxy-authorization', 'origin', 'referer', 'sec-fetch-site',
      'forwarded', 'x-forwarded-host', 'x-transport-only', 'transfer-encoding']) {
      assert.equal(second.headers[name], undefined, `${name} must not cross the backend boundary`)
    }
    assert.equal(f.calls.length, 0)
  } finally { await f.service.shutdown() }
}))

test('no model grant denies inference and synchronous provider failures release concurrency slots', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const noLlm = await f.service.publish(f.directory, { ...f.manifest, llm: undefined }, 'web:author', AbortSignal.timeout(5000))
    await f.service.approve(noLlm.id, noLlm.revision)
    const first = await f.connect(noLlm.id)
    assert.equal((await fetch(first.origin + '/_shadow/state', {
      method: 'PUT', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 0, values: { preference: 'local-only' } }),
    })).status, 200, 'Persistent state does not require a model grant or backend')
    const input = { messages: [{ role: 'user', content: 'x' }] }
    assert.equal((await post(first.origin, '/_shadow/generate', first.token, input)).status, 403)
    f.provider.chat = () => { throw new Error('Synthetic synchronous provider failure') }
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    const second = await f.connect(app.id)
    assert.equal((await post(second.origin, '/_shadow/generate', second.token, input)).status, 502)
    assert.equal((await post(second.origin, '/_shadow/generate', second.token, input)).status, 502)
    assert.equal(f.service.get(app.id).calls, 2)
  } finally { await f.service.shutdown() }
}))

test('interrupted startup is reported after restore, stale approvals are serialized and missing files never leave registered apps', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await assert.rejects(f.service.publish(f.directory, { ...f.manifest, files: ['index.html', 'missing.txt'] }, 'web:author', AbortSignal.timeout(5000)), /ENOENT/)
    assert.deepEqual(await readdir(f.service.store.root), [])
    const app = await f.publish()
    const approval = f.service.approve(app.id, app.revision)
    await assert.rejects(f.service.start(app.id), /progress/)
    await assert.rejects(f.service.revoke(app.id), /progress/)
    await approval
    const saved = f.service.store.get(app.id)
    saved.lastRun = { id: app.id, status: 'running' }
    f.service.store.save(saved)
    const restored = new MicroApps('p', home, () => f.provider, () => 'fixture')
    await restored.init()
    try {
      assert.equal(restored.get(app.id).status, 'interrupted')
      assert.match(restored.get(app.id).lastRun!.error!, /previous runtime ended/)
    } finally { await restored.shutdown() }
  } finally { await f.service.shutdown() }
}))

test('review includes auxiliary script source and another Project cannot see or authorize the app', async () => withTempWorkspace(async home => {
  const f = await fixture(home), other = await fixture(join(home, 'other-project'))
  try {
    await writeFile(join(f.directory, 'helper.ps1'), 'Write-Output "review this script"')
    const app = await f.service.publish(f.directory, { ...f.manifest, files: ['index.html', 'helper.ps1'] }, 'web:author', AbortSignal.timeout(5000))
    assert.equal((await f.service.review(app.id)).files.find(file => file.path === 'helper.ps1')!.text, 'Write-Output "review this script"')
    assert.deepEqual(other.service.list(), [])
    await assert.rejects(other.service.approve(app.id, app.revision), /not found in this Project/)
  } finally { await f.service.shutdown(); await other.service.shutdown() }
}))

test('failed startup is visible, releases the server and permits a corrected publication', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    await writeFile(join(f.directory, 'server.mjs'), 'process.exit(2)')
    const app = await f.service.publish(f.directory, { ...f.manifest, files: ['index.html', 'server.mjs'],
      backend: { runtime: 'node', entry: 'server.mjs' } }, 'web:author', AbortSignal.timeout(5000))
    await f.service.approve(app.id, app.revision)
    await assert.rejects(f.service.start(app.id), /exited before/)
    assert.equal(f.service.get(app.id).status, 'failed')
    const fixed = await f.service.publish(f.directory, f.manifest, 'web:author', AbortSignal.timeout(5000), app.id, app.revision)
    assert.equal(fixed.status, 'awaiting_approval')
  } finally { await f.service.shutdown() }
}))

test('model failures count against allowance and stop aborts in-flight calls without executing tools', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const entered = Promise.withResolvers<void>()
    f.provider.chat = async (_messages, _tools, options) => {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
      throw new Error('Unreachable')
    }
    const app = await f.publish()
    await f.service.approve(app.id, app.revision)
    const { origin, token } = await f.connect(app.id)
    const request = post(origin, '/_shadow/generate', token, { messages: [{ role: 'user', content: 'Hello' }] }).catch(() => undefined)
    await entered.promise
    await f.service.stop(app.id)
    await request
    assert.equal(f.service.get(app.id).calls, 1)
    assert.equal(f.service.get(app.id).status, 'stopped')
  } finally { await f.service.shutdown() }
}))

test('agent publication and owner approval use different authenticated surfaces', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  const host = new Hono()
  microAppsPlugin(f.service, request => request.headers.get('x-owner') === 'yes')(host)
  const tool = new MicroAppTool(f.service, id => assert.equal(id, 'web:author'))
  const context = { projectId: 'p', sessionId: 'web:author', cwd: home, signal: new AbortController().signal,
    tools: new SessionTools(new Tools(home), home) } as ExecutionContext
  try {
    const capabilities = JSON.parse(await tool.execute({ action: 'capabilities' }, context))
    assert.equal(tool.readonly({ action: 'capabilities' }), true)
    assert.equal(capabilities.storage.state.persistent, true)
    assert.equal(capabilities.approval.agentMayApprove, false)
    await assert.rejects(tool.execute({ action: 'capabilities' }, { ...context, projectId: 'other' }), /owning local Project/)
    await writeFile(join(f.directory, 'shadow-app.json'), JSON.stringify(f.manifest))
    const app = JSON.parse(await tool.execute({ action: 'publish', directory: 'source' }, context))
    assert.equal(app.manifest, undefined)
    assert.equal(app.approval, null)
    assert.equal(app.name, f.manifest.name)
    assert.deepEqual(app.llm, f.manifest.llm)
    assert.deepEqual(JSON.parse(await tool.execute(app.detail, context)), f.service.get(app.id))
    const check = { action: 'check', directory: 'source', id: app.id, revision: app.revision }
    assert.equal(tool.readonly(check), true)
    assert.equal(JSON.parse(await tool.execute(check, context)).publicationCheck.matchesPublished, true)
    assert.deepEqual(JSON.parse(await tool.execute(check, context)).publicationCheck,
      (await f.service.checkPublication(app.id, app.revision, f.directory, f.manifest, context.signal)).publicationCheck)
    assert.equal(f.service.get(app.id).status, 'awaiting_approval')
    await assert.rejects(tool.execute({ ...check, revision: undefined }, context))
    await assert.rejects(tool.execute(check, { ...context, projectId: 'other' }), /owning local Project/)
    await assert.rejects(tool.execute({ ...check, directory: '..' }, { ...context, cwd: f.directory }), /effective local workdir/)
    await assert.rejects(tool.execute(check, { ...context, remoteWorkdir: {
      nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not interpret remote paths on Main') },
    } }), /owning local Project/)
    assert.equal((await host.request('/api/microapps')).status, 401)
    assert.equal((await host.request(`/api/microapps/${app.id}/approve`, { method: 'POST', body: JSON.stringify({ revision: app.revision, confirm: true }) })).status, 401)
    await assert.rejects(tool.execute({ action: 'approve', id: app.id }, context))
    const approved = await host.request(`/api/microapps/${app.id}/approve`, {
      method: 'POST', headers: { 'x-owner': 'yes' }, body: JSON.stringify({ revision: app.revision, confirm: true }),
    })
    assert.equal(approved.status, 200)
    await tool.execute({ action: 'start', id: app.id }, context)
    assert.equal(f.service.get(app.id).status, 'running')
    assert.equal('token' in f.service.get(app.id), false)
    assert.equal('url' in f.service.get(app.id), false)
    await assert.rejects(tool.execute({ action: 'list' }, { ...context, projectId: 'other' }), /owning local Project/)
    await assert.rejects(localAppDirectory(f.directory, '..'), /effective local workdir/)
    for (const path of ['../outside.html', '/absolute.html', '.env', 'a\\b.html']) {
      assert.equal(appManifestSchema.safeParse({ ...f.manifest, files: [path], entry: path }).success, false)
    }
  } finally { await f.service.shutdown() }
}))

test('compact Micro App receipts preserve approval, failures and exact scope refs without duplicating evidence', async () => withTempWorkspace(async home => {
  const f = await fixture(home)
  try {
    const app = await f.publish()
    const work = [{ key: 'work:fixture', revision: 3, acceptance: Array.from({ length: 8 }, (_, index) =>
      `${index}: Verify startup, state, recovery and repeat-use behavior. `.repeat(8)) }]
    const record = { ...app, manifest: { ...app.manifest, description: 'Detailed app description. '.repeat(12) },
      work, lastRun: { id: app.id, status: 'failed' as const, error: 'Backend dependency missing' },
      approval: { revision: app.revision, at: new Date().toISOString(), model: 'fixture' },
      acceptance: { id: app.id, revision: app.revision, approvalAt: new Date().toISOString(),
        status: 'blocked' as const, sequence: 3, observations: [], work, error: 'Device use not approved' } }
    const before = structuredClone(record), receipt = microAppReceipt(record)
    assert.ok(JSON.stringify(receipt).length < JSON.stringify(record).length * 0.4, 'Representative receipt shrinks by at least 60%')
    assert.deepEqual(receipt.approval, record.approval)
    assert.equal(receipt.lastRun?.error, 'Backend dependency missing')
    assert.equal(receipt.acceptanceSummary?.error, 'Device use not approved')
    assert.equal(receipt.acceptanceSummary?.status, 'blocked')
    assert.equal(receipt.acceptanceSummary?.reportSaved, false)
    assert.deepEqual(receipt.workRefs, [{ key: 'work:fixture', revision: 3, acceptanceCount: 8 }])
    assert.deepEqual(record, before)
    assert.deepEqual(f.service.get(app.id), app, 'Projection does not update storage or grant access')
  } finally { await f.service.shutdown() }
}))
