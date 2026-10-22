import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ConfigSchema } from '../../config/schema.ts'
import { FolderRegistry } from '../../folders/registry.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startProjectHost } from './host.ts'
import type { MainRuntimeHandle } from './contracts.ts'

async function freePort(): Promise<number> {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return address.port
}

test('Main composes isolated mobile access, scoped authorization and revocable real live streams', { timeout: 20_000 }, async () => {
  await withTempWorkspace(async root => {
    const previous = new Map(['SHADOW_MOBILE_ORIGIN', 'SHADOW_MOBILE_PORT', 'GITHUB_COPILOT_TOKEN_DIR'].map(key => [key, process.env[key]]))
    const credential = 's'.repeat(43)
    const mainPort = await freePort()
    const mobilePort = await freePort()
    process.env.SHADOW_MOBILE_ORIGIN = 'https://mobile.example.test'
    process.env.SHADOW_MOBILE_PORT = String(mobilePort)
    process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
    let runtime: MainRuntimeHandle | undefined
    try {
      runtime = await startProjectHost(ConfigSchema.parse({
        agent: { workspace: join(root, 'home'), model: 'fixture@openai' },
        providers: { openai: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' } },
        channels: {}, mcp: {},
      }), { gateway: { host: '127.0.0.1', port: mainPort, launchCredential: credential } }, async (_config, dependencies) => {
        const app = new Hono()
        app.post('/api/fixture', async c => dependencies.authorize && await dependencies.authorize(c.req.raw)
          ? c.json({ project: dependencies.project.id, data: await c.req.json() })
          : c.json({ error: 'unauthorized' }, 401))
        const publisher = dependencies.realtimeHub!.registerProject(dependencies.project.id)
        return {
          app, folders: new FolderRegistry(dependencies.home), ready: Promise.resolve(), updateConfig() {},
          async shutdown() { publisher.close() },
        }
      })
      await runtime.ready
      const mainBase = `http://127.0.0.1:${mainPort}`
      const mobileBase = `http://127.0.0.1:${mobilePort}`
      const ownerHeaders = { Authorization: `Bearer ${credential}` }
      const offer = await fetch(`${mainBase}/local/v1/mobile-pairing`, { method: 'POST', headers: ownerHeaders })
      assert.equal(offer.status, 200)
      const paired = await fetch(`${mobileBase}/mobile/v1/pair`, {
        method: 'POST', headers: { Origin: 'capacitor://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: (await offer.json()).code }),
      })
      assert.equal(paired.status, 200)
      const { accessToken } = await paired.json()
      const headers = { Authorization: `Bearer ${accessToken}`, Origin: 'capacitor://localhost', 'Content-Type': 'application/json' }
      assert.equal((await fetch(`${mobileBase}/api/projects`)).status, 401)
      assert.equal((await fetch(`${mainBase}/api/projects`, { headers: { Authorization: `Bearer ${accessToken}` } })).status, 401)
      const projects = await fetch(`${mobileBase}/api/projects`, { headers })
      assert.equal(projects.status, 200)
      assert.equal(projects.headers.get('Access-Control-Allow-Origin'), 'capacitor://localhost')
      const scoped = await fetch(`${mobileBase}/projects/default/api/fixture`, { method: 'POST', headers, body: '{"value":1}' })
      assert.equal(scoped.status, 200)
      assert.deepEqual(await scoped.json(), { project: 'default', data: { value: 1 } })
      for (const path of ['/local/v1/readiness', '/nodes/v1/network', '/pair/v1/offers']) {
        assert.equal((await fetch(mobileBase + path, { headers })).status, 403)
      }
      const topics = encodeURIComponent(JSON.stringify([{ kind: 'sessions', projectId: 'default' }]))
      const live = await fetch(`${mobileBase}/api/live?topics=${topics}`, { headers, signal: AbortSignal.timeout(5000) })
      assert.equal(live.status, 200)
      const reader = live.body!.getReader()
      assert.equal((await reader.read()).done, false)
      assert.equal((await fetch(`${mobileBase}/mobile/v1/session`, { method: 'DELETE', headers })).status, 204)
      while (!(await reader.read()).done) { /* Drain already emitted frames before the revocation close. */ }
      assert.equal((await fetch(`${mobileBase}/api/projects`, { headers })).status, 401)
    } finally {
      await runtime?.shutdown()
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
