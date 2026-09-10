import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { LocalRuntimeControl } from './local-control.ts'

test('local control reports starting, ready, and stopping readiness', async () => {
  const app = new Hono()
  const control = new LocalRuntimeControl('main', () => {})
  control.plugin()(app)

  const starting = await app.request('/local/v1/readiness')
  assertEquals(starting.status, 503)
  assertEquals(await starting.json(), {
    version: 1,
    role: 'main',
    status: 'starting',
  })

  control.markReady()
  const ready = await app.request('/local/v1/readiness')
  assertEquals(ready.status, 200)
  assertEquals(await ready.json(), {
    version: 1,
    role: 'main',
    status: 'ready',
  })

  control.markStopping()
  const stopping = await app.request('/local/v1/readiness')
  assertEquals(stopping.status, 503)
  assertEquals(await stopping.json(), {
    version: 1,
    role: 'main',
    status: 'stopping',
  })
})

test('local control schedules shutdown asynchronously and idempotently', async () => {
  const app = new Hono()
  let shutdownCalls = 0
  const control = new LocalRuntimeControl('main', () => {
    shutdownCalls++
  })
  control.markReady()
  control.plugin()(app)

  const firstResponse = app.request('/local/v1/shutdown', { method: 'POST' })
  assertEquals(shutdownCalls, 0)
  const first = await firstResponse
  const second = await app.request('/local/v1/shutdown', { method: 'POST' })

  assertEquals(first.status, 202)
  assertEquals(await first.json(), { version: 1, accepted: true })
  assertEquals(second.status, 202)
  assertEquals(await second.json(), { version: 1, accepted: true })
  assertEquals(control.status, 'stopping')
  assertEquals(shutdownCalls, 1)
})

test('local control routes require the gateway bearer credential', async () => {
  const app = new Hono()
  const control = new LocalRuntimeControl('main', () => {})
  registerGatewayRoutes(app, [control.plugin()], {
    launchCredential: 'local-secret',
  })

  const readiness = await app.request('/local/v1/readiness')
  const shutdown = await app.request('/local/v1/shutdown', { method: 'POST' })
  const authorized = await app.request('/local/v1/readiness', {
    headers: { Authorization: 'Bearer local-secret' },
  })

  assertEquals(readiness.status, 401)
  assertEquals(shutdown.status, 401)
  assertEquals(authorized.status, 503)
  assertEquals(await readiness.json(), { error: 'unauthorized' })
})
