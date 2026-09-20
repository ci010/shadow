import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import { ConfigSchema } from '../../config/schema.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startProjectHost } from './host.ts'

test('PIN-only Main requires a browser session at both host and Project admin boundaries', async () => {
  await withTempWorkspace(async root => {
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const config = ConfigSchema.parse({
      agent: { workspace: join(root, 'home'), model: 'fixture@openai' },
      providers: { openai: { apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {},
    })
    const pin = 'fixture-admin-3278'
    let authorizeProject: ((request: Request) => boolean | Promise<boolean>) | undefined
    const runtime = await startProjectHost(config, { gateway: {
      host: '127.0.0.1', port: address.port, browserPinHash: createHash('sha256').update(pin).digest('hex'),
    } }, async (_config, dependencies) => {
      authorizeProject = dependencies.authorize
      const app = new Hono()
      app.get('/api/admin-fixture', async c => c.json({ allowed: await dependencies.authorize(c.req.raw) }))
      return { app, folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(), async shutdown() {}, updateConfig() {} }
    }, process.cwd())
    try {
      const base = `http://127.0.0.1:${address.port}`
      assert.equal((await fetch(base + '/api/projects')).status, 401)
      assert.equal((await fetch(base + '/projects/default/api/admin-fixture')).status, 401)
      assert(authorizeProject)
      assert.equal(await authorizeProject(new Request(base + '/api/projects')), false)
      const login = await fetch(base + '/api/web-auth/pair', {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ pin }),
      })
      assert.equal(login.status, 200)
      const headers = { origin: base, cookie: login.headers.get('set-cookie')!.split(';')[0]! }
      assert.equal((await fetch(base + '/api/projects', { headers })).status, 200)
      assert.deepEqual(await (await fetch(base + '/projects/default/api/admin-fixture', { headers })).json(), { allowed: true })
      assert.equal((await fetch(base + '/local/v1/readiness', { headers })).status, 401)
      assert.equal((await fetch(base + '/api/web-auth/session', { method: 'DELETE', headers })).status, 200)
      assert.equal((await fetch(base + '/api/projects', { headers })).status, 401)
    } finally { await runtime.shutdown() }
  })
})
