import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BrowserAuth } from '../gateway/web-auth.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../gateway/server.ts'
import { CredentialStore } from './store.ts'
import { CredentialRequests } from './requests.ts'
import { credentialsPlugin } from './routes.ts'

const origin = 'http://127.0.0.1:43123', credential = 'synthetic-launch-credential'

test('credential HTTP APIs retain browser authentication, CSRF, Project/request isolation and secret-free receipts', async () => {
  await withTempWorkspace(async workspace => {
    const clientAddresses = new GatewayClientAddressRegistry()
    const auth = new BrowserAuth({ clientAddresses, launchCredential: credential })
    const a = new CredentialStore(join(workspace, 'a')), b = new CredentialStore(join(workspace, 'b'))
    const requestsA = new CredentialRequests({ projectId: 'a', credentials: a })
    const requestsB = new CredentialRequests({ projectId: 'b', credentials: b })
    const app = new Hono()
    const projectA = new Hono(), projectB = new Hono()
    credentialsPlugin(a, request => auth.authorize(request), requestsA)(projectA)
    credentialsPlugin(b, request => auth.authorize(request), requestsB)(projectB)
    registerGatewayRoutes(app, [auth.plugin(), gateway => {
      gateway.route('/projects/a', projectA); gateway.route('/projects/b', projectB)
    }], { launchCredential: credential, browserAuth: auth, clientAddresses }, {})
    const request = (path: string, init: RequestInit = {}) => {
      const req = new Request(origin + path, init)
      clientAddresses.capture(req, { transport: 'tcp', hostname: '127.0.0.1' })
      return app.request(req)
    }
    try {
      const offer = await request('/local/v1/web-pairing', { method: 'POST', headers: { authorization: `Bearer ${credential}` } })
      assert.equal(offer.status, 200)
      const paired = await request('/api/web-auth/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: (await offer.json()).code }) })
      assert.equal(paired.status, 200)
      const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
      const headers = { cookie, origin, 'content-type': 'application/json' }
      const pending = requestsA.request({ name: 'service-key', purpose: 'Approved service' }, new AbortController().signal, 'web:owner-a')
      const id = requestsA.pending()!.id
      const path = `/projects/a/api/credential-requests/${id}`
      for (const deniedHeaders of [{}, { cookie }, { ...headers, origin: 'https://foreign.test' }, { ...headers, 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
        const result = await request(path, { method: 'POST', headers: deniedHeaders, body: JSON.stringify({ value: 'synthetic-secret' }) })
        assert.ok([401, 403].includes(result.status), String(result.status))
        assert.deepEqual(a.names(), [])
        assert.equal(requestsA.pending()?.id, id)
      }
      assert.equal((await request(`/projects/b/api/credential-requests/${id}`, { method: 'POST', headers, body: JSON.stringify({ value: 'synthetic-secret' }) })).status, 409)
      assert.deepEqual(b.names(), [])
      const metadata = await request('/projects/a/api/credential-requests', { headers })
      assert.equal(metadata.headers.get('cache-control'), 'no-store')
      assert.equal((await metadata.json()).request.sessionId, 'web:owner-a')
      const invalid = await request(path, { method: 'POST', headers, body: JSON.stringify({ value: 'synthetic-secret', projectId: 'b' }) })
      assert.equal(invalid.status, 400)
      const saved = await request(path, { method: 'POST', headers, body: JSON.stringify({ value: 'synthetic-secret' }) })
      assert.equal(saved.status, 200)
      assert.equal(saved.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await saved.text(), /synthetic-secret/)
      assert.equal((await pending).status, 'saved')
      assert.equal(a.resolve('service-key'), 'synthetic-secret')
      assert.equal((await request(path, { method: 'POST', headers, body: JSON.stringify({ value: 'replacement' }) })).status, 409)
      const names = await request('/projects/a/api/credentials', { headers })
      assert.equal(names.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await names.json(), { names: ['service-key'] })
      for (const old of ['credentials', 'credential-requests', 'publication-requests', 'probe-requests']) {
        assert.equal((await request(`/projects/a/api/agent-resources/${old}`, { headers })).status, 404)
      }
    } finally { requestsA.stop(); requestsB.stop(); auth.close() }
  })
})
