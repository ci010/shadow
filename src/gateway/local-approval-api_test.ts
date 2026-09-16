import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes } from './server.ts'
import type { JobRequestV1 } from '../execution/contracts.ts'
import { localApprovalApiPlugin } from './local-approval-api.ts'
import { InMemoryLocalApprovalService } from '../execution/local-approval.ts'

function request(): JobRequestV1 {
  const now = new Date()
  return {
    version: 1,
    jobId: 'approval-1',
    idempotencyKey: 'approval-key-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'child-1',
    capabilityId: 'workdir-1',
    operation: 'filesystem.write',
    args: { path: 'notes.txt', content: 'secret content' },
    createdAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + 10_000).toISOString(),
    approval: 'none',
  }
}

test('local approval API requires bearer auth and returns safe no-store state', async () => {
  const service = new InMemoryLocalApprovalService([{
    capabilityId: 'workdir-1',
    displayName: 'Project files',
    policy: 'grant',
  }])
  const pending = service.authorize(
    request(),
    new AbortController().signal,
    () => {},
  )
  const app = new Hono()
  registerGatewayRoutes(app, [localApprovalApiPlugin({ service })], {
    launchCredential: 'local-secret',
  })

  assertEquals((await app.request('/local/v1/approvals')).status, 401)
  const state = await app.request('/local/v1/approvals', {
    headers: { Authorization: 'Bearer local-secret' },
  })
  assertEquals(state.status, 200)
  assertEquals(state.headers.get('Cache-Control'), 'no-store')
  const stateText = await state.text()
  assertEquals(stateText.includes('secret content'), false)
  assertEquals(
    JSON.parse(stateText).pending[0].summary.detail,
    '14 UTF-8 bytes',
  )

  const approved = await app.request(
    '/local/v1/approvals/approval-1/decision',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        decision: 'approve',
        scope: 'capability',
      }),
    },
  )
  assertEquals(approved.status, 200)
  assertEquals(await pending, true)

  const grants = await app.request('/local/v1/approvals', {
    headers: { Authorization: 'Bearer local-secret' },
  })
  assertEquals((await grants.json()).grants, [{
    version: 1,
    scope: 'capability',
    capabilityId: 'workdir-1',
    operation: 'filesystem.write',
  }])
  const revoked = await app.request('/local/v1/grants/revoke', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      capabilityId: 'workdir-1',
      operation: 'filesystem.write',
    }),
  })
  assertEquals(await revoked.json(), { version: 1, revoked: 1 })
  assertEquals(service.listGrants(), [])
})

test('local approval API validates decision schemas and body limits', async () => {
  const service = new InMemoryLocalApprovalService([{
    capabilityId: 'workdir-1',
    displayName: 'Project files',
    policy: 'always',
  }])
  void service.authorize(request(), new AbortController().signal, () => {})
  const app = new Hono()
  registerGatewayRoutes(app, [
    localApprovalApiPlugin({ service, maxBodyBytes: 64 }),
  ], {
    launchCredential: 'local-secret',
  })
  const headers = {
    Authorization: 'Bearer local-secret',
    'Content-Type': 'application/json',
  }

  const invalidScope = await app.request(
    '/local/v1/approvals/approval-1/decision',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        decision: 'approve',
        scope: 'session',
      }),
    },
  )
  assertEquals(invalidScope.status, 404)
  const unknownField = await app.request(
    '/local/v1/approvals/approval-1/decision',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, decision: 'deny', extra: true }),
    },
  )
  assertEquals(unknownField.status, 400)
  const tooLarge = await app.request('/local/v1/grants/revoke', {
    method: 'POST',
    headers: { ...headers, 'Content-Length': '65' },
    body: '{}',
  })
  assertEquals(tooLarge.status, 413)
})
