import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { childWorkspacePlugin } from './child-workspace.ts'
import { DeviceApprovalUnavailableError, DeviceChallengeRequestError, requestDeviceChallengeProtocol } from '../cluster/device-challenge-client.ts'
import { DeviceCredentialProof } from '../cluster/device-credentials.ts'

test('workspace reports bounded challenge diagnostics, never secrets or speculative pending approval', async () => {
  for (const [failure, code] of [
    [new DeviceChallengeRequestError(401), 'main_workspace_challenge_http_401'],
    [new DeviceChallengeRequestError(404), 'main_workspace_challenge_http_404'],
    [new DeviceApprovalUnavailableError('private credential'), 'main_workspace_approval_unavailable'],
    [new Error('secret token endpoint'), 'main_workspace_unavailable'],
    [new Error('fetch failed', { cause: { code: 'ECONNREFUSED', address: 'private' } }), 'main_workspace_econnrefused'],
    [new Error('fetch failed', { cause: { code: 'secret' } }), 'main_workspace_unavailable'],
  ] as const) {
    const app = new Hono()
    childWorkspacePlugin({ endpoint: 'https://main.invalid', proof: async () => { throw failure } })(app)
    const response = await app.request('/api/projects')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: code, stage: 'challenge' })
  }
})

test('workspace preserves the same device endpoint prefix as its challenge and execution transport', async () => {
  for (const base of ['https://main.invalid/device', 'https://main.invalid/device/']) {
    await assert.rejects(requestDeviceChallengeProtocol(base, {
      deviceId: 'fixture-device', nodeId: 'fixture-node', credentialId: 'fixture-credential',
    }, new DeviceCredentialProof(async () => new Uint8Array()), async input => {
      assert.equal(String(input), 'https://main.invalid/device/cluster/v1/ui/challenges')
      return new Response(null, { status: 401 })
    }, undefined, '/cluster/v1/ui/challenges'), DeviceChallengeRequestError)
    const app = new Hono()
    childWorkspacePlugin({ endpoint: base, proof: async (_signal, path) => {
      assert.equal(path, '/cluster/v1/ui/challenges'); return 'synthetic-proof'
    }, fetch: async (input, init) => {
      assert.equal(String(input), 'https://main.invalid/device/cluster/v1/ui/request')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('X-Shadow-Ui-Path'), '/api/projects?test=1')
      assert.equal(headers.get('Authorization'), null)
      assert.equal(headers.get('Origin'), null)
      return Response.json({ projects: [] })
    } })(app)
    const response = await app.request('/api/projects?test=1', { headers: { Authorization: 'Bearer local-only', Origin: 'null' } })
    assert.equal(response.status, 200)
  }
})
