import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryLocalApprovalService } from '../execution/local-approval.ts'
import { ChildLocalControlService } from './child-local-control.ts'

test('Child local control serves authenticated readiness and shuts down cleanly', async () => {
  const approvals = new InMemoryLocalApprovalService([])
  let shutdownRequests = 0
  const service = new ChildLocalControlService({
    port: 0,
    launchCredential: 'child-local-secret',
    approvalService: approvals,
    requestShutdown: () => {
      shutdownRequests++
    },
  })
  const lifecycle = new AbortController()
  await approvals.start(lifecycle.signal)
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
  assertEquals(await approvalsResponse.json(), {
    version: 1,
    pending: [],
    grants: [],
  })

  const shutdown = await fetch(`${base}/local/v1/shutdown`, {
    method: 'POST',
    headers,
  })
  assertEquals(shutdown.status, 202)
  await Promise.resolve()
  assertEquals(shutdownRequests, 1)
  await service.shutdown()
  await assertRejects(() => fetch(`${base}/local/v1/readiness`, { headers }))
  await approvals.shutdown()
})
