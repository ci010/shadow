import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { MainDeviceUi, DEVICE_UI_REQUEST } from './device-ui.ts'
import type { MainCluster } from './main-cluster.ts'
import { encodeDeviceChallengeProtocol } from './device-challenge.ts'

test('Project usage authorization covers recall for owner, mobile and approved Child UI', async t => {
  const authentication = { deviceId: 'device', credentialId: 'credential', nodeId: 'node' }
  let revoked = false
  const cluster = {
    authority: { verify: async () => authentication },
    registry: { authenticate: () => { if (revoked) throw new Error('revoked'); return authentication } },
  } as unknown as MainCluster
  const addresses = new GatewayClientAddressRegistry()
  const project = new Hono()
  const bridge = new MainDeviceUi(cluster, addresses, async request => {
    const url = new URL(request.url)
    url.pathname = url.pathname.replace(/^\/projects\/p1/, '')
    const forwarded = new Request(url, request)
    addresses.inherit(request, forwarded)
    return project.fetch(forwarded)
  })
  t.after(() => bridge.close())
  const ingress = new Hono()
  bridge.plugin()(ingress)
  const owner = (request: Request) => request.headers.get('authorization') === 'Bearer main-private'
  const mobile = (request: Request) => request.headers.get('authorization') === 'Bearer mobile-private'
  sessionsApiPlugin({
    projectId: 'p1', getProjectUsage: async () => ({ projectId: 'p1' }),
    getProjectUsagePage: async (page: number) => ({ projectId: 'p1', page }),
  } as unknown as SessionManager, {
    authorizeContext: request => owner(request) || mobile(request) || bridge.authorize(request),
    recall: () => ({ coverage: 'complete', skills: [{ entry: 'skill', reads: 4 }], memory: [] }),
  })(project)
  const throughChild = (path: string) => ingress.request(DEVICE_UI_REQUEST, { method: 'POST', headers: {
    'X-Shadow-Device-Proof': encodeDeviceChallengeProtocol({ ...authentication, version: 1, challengeId: 'challenge', signature: 'stub' }),
    'X-Shadow-Ui-Path': '/projects/p1' + path, 'X-Shadow-Ui-Method': 'GET',
  } })
  const usage = '/api/project/usage'
  for (const suffix of ['', '/daily?page=2']) {
    const main = await project.request(usage + suffix, { headers: { Authorization: 'Bearer main-private' } })
    const child = await throughChild(usage + suffix)
    assert.equal(main.status, 200)
    assert.equal(child.status, 200)
    const payload = await child.json()
    assert.deepEqual(payload, await main.json())
    if (!suffix) assert.equal(payload.recall.skills[0].reads, 4)
    else {
      assert.equal(payload.page, 2)
      assert.equal('recall' in payload, false)
    }
  }
  const mobileUsage = await project.request(usage, { headers: { Authorization: 'Bearer mobile-private' } })
  assert.equal(mobileUsage.status, 200)
  assert.equal((await mobileUsage.json()).recall.skills[0].reads, 4)
  assert.equal((await project.request(usage)).status, 401)
  assert.equal((await project.request(usage, { headers: { Authorization: 'Bearer child-private' } })).status, 401)
  revoked = true
  assert.equal((await throughChild(usage)).status, 401)
})
