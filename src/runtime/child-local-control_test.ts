import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { ChildLocalControlService } from './child-local-control.ts'

test('local Child status is authenticated, non-cacheable and available while Main is pending', async t => {
  const token = 'status-test-credential'
  const expected = { version: 1, connection: 'offline', fingerprint: 'sha256:fixture', error: 'Main has not approved this device' }
  const service = new ChildLocalControlService({
    port: 0, launchCredential: token, requestShutdown: () => {}, childStatus: () => expected,
  })
  t.after(() => service.shutdown())
  await service.start(new AbortController().signal)
  service.markReady()
  const url = `http://127.0.0.1:${service.address!.port}/local/v1/child`
  assertEquals((await fetch(url)).status, 401)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'null' } })
  assertEquals(response.status, 200)
  assertEquals(response.headers.get('cache-control'), 'no-store')
  assertEquals(response.headers.get('access-control-allow-origin'), 'null')
  assertEquals(await response.json(), expected)
})

test('Child local control serves authenticated readiness and shuts down cleanly', async () => {
  let shutdownRequests = 0
  const service = new ChildLocalControlService({
    port: 0,
    launchCredential: 'child-local-secret',
    requestShutdown: () => {
      shutdownRequests++
    },
  })
  const lifecycle = new AbortController()
  await service.start(lifecycle.signal)
  const address = service.address
  if (!address) throw new Error('local control address is unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { Authorization: 'Bearer child-local-secret' }

  assertEquals((await fetch(`${base}/local/v1/readiness`)).status, 401)
  const starting = await fetch(`${base}/local/v1/readiness`, { headers })
  assertEquals(starting.status, 503)
  assertEquals(await starting.json(), {
    version: 1,
    role: 'child',
    status: 'starting',
  })
  service.markReady()
  assertEquals(
    (await fetch(`${base}/local/v1/readiness`, { headers })).status,
    200,
  )
  const approvalsResponse = await fetch(`${base}/local/v1/approvals`, {
    headers,
  })
  assertEquals(approvalsResponse.status, 404)
  assertEquals((await fetch(`${base}/local/v1/approvals/retired/decision`, { method: 'POST', headers })).status, 404)
  assertEquals((await fetch(`${base}/local/v1/grants/revoke`, { method: 'POST', headers })).status, 404)

  const shutdown = await fetch(`${base}/local/v1/shutdown`, {
    method: 'POST',
    headers,
  })
  assertEquals(shutdown.status, 202)
  await Promise.resolve()
  assertEquals(shutdownRequests, 1)
  await service.shutdown()
  await assertRejects(() => fetch(`${base}/local/v1/readiness`, { headers }))
})
