import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { folderFixture } from '../../folders/test-fixtures.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../../gateway/server.ts'
import { MainMobileNetwork, parseMobileNetworkSettings } from './mobile-network.ts'

const credential = 'synthetic-phone-admin'
const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }
async function unusedPort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address(); assert(addr && typeof addr !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return addr.port
}
async function fixture(t: TestContext) {
  const { root } = await folderFixture(t)
  const main = new Hono(), clientAddresses = new GatewayClientAddressRegistry()
  let addresses = ['127.0.0.1']
  const options = { configPath: join(root, 'mobile.json'), launchCredential: credential, clientAddresses, main, addresses: () => addresses }
  const network = new MainMobileNetwork(options)
  t.after(() => network.shutdown())
  registerGatewayRoutes(main, [network.plugin(), app => {
    app.get('/api/private', c => c.json({ authorized: network.authorizeMain(c.req.raw) }))
  }], { launchCredential: credential, clientAddresses, authorizeClient: request => network.authorizeMain(request) })
  await network.init()
  function request(path: string, method = 'GET', body?: unknown, peer = '127.0.0.1', authenticated = true) {
    const request = new Request(`http://127.0.0.1/nodes/v1/mobile/${path}`, { method,
      headers: authenticated ? headers : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    clientAddresses.capture(request, { transport: 'tcp', hostname: peer })
    return main.request(request)
  }
  return { network, options, request, setAddresses: (value: string[]) => { addresses = value } }
}

test('phone settings require explicit LAN consent and reject unknown keys and invalid ports', () => {
  const settings = { enabled: true, port: 3125, allowLanHttp: true }
  assert.deepEqual(parseMobileNetworkSettings(settings), settings)
  for (const value of [null, [], {}, { ...settings, enabled: 1 }, { ...settings, port: 80 }, { ...settings, port: '3125' },
    { ...settings, port: 65536 }, { ...settings, allowLanHttp: false }, { ...settings, host: '0.0.0.0' }]) {
    assert.throws(() => parseMobileNetworkSettings(value), TypeError)
  }
})

test('phone listener defaults off; only loopback launch owner can configure or pair', async t => {
  const f = await fixture(t)
  assert.equal(f.network.state().state, 'disabled')
  assert.equal((await f.request('settings', 'GET', undefined, '127.0.0.1', false)).status, 401)
  for (const path of ['settings', 'pairing']) {
    assert.equal((await f.request(path, path === 'pairing' ? 'POST' : 'GET', undefined, '192.168.1.3')).status, 401)
  }
  assert.equal((await f.request('pairing', 'POST')).status, 409)
  assert.equal((await f.request('settings', 'PUT', { enabled: true, port: 3125, allowLanHttp: false })).status, 400)
})

test('phone listener persists, pairs once, revokes and stops without exposing local administration', async t => {
  const f = await fixture(t)
  const port = await unusedPort(), settings = { enabled: true, port, allowLanHttp: true }
  const response = await f.request('settings', 'PUT', settings)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).state, 'listening')
  assert.deepEqual(JSON.parse(await readFile(f.options.configPath, 'utf8')), settings)
  const pairing = await (await f.request('pairing', 'POST')).json()
  assert.equal(pairing.url, `http://127.0.0.1:${port}`)
  const remote = (path: string, init?: RequestInit) => fetch(`${pairing.url}${path}`, init)
  const pair = () => remote('/mobile/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'capacitor://localhost' }, body: JSON.stringify({ code: pairing.code }) })
  assert.equal((await remote('/api/private')).status, 401)
  const login = await pair(); assert.equal(login.status, 200)
  const { accessToken } = await login.json()
  assert.equal((await pair()).status, 401)
  const authorized = { headers: { Authorization: `Bearer ${accessToken}` } }
  assert.deepEqual(await (await remote('/api/private', authorized)).json(), { authorized: true })
  for (const path of ['/nodes/v1/mobile/settings', '/local/v1/mobile-pairing', '/local/v1/readiness', '/api/web-auth']) {
    assert.equal((await remote(path, authorized)).status, 403, path)
  }
  const sessions = f.network.state().sessions
  assert.equal(sessions.length, 1)
  assert.equal((await f.request(`sessions/${sessions[0]!.id}`, 'DELETE')).status, 200)
  assert.equal((await remote('/api/private', authorized)).status, 401)
  await f.network.shutdown()
  const restored = new MainMobileNetwork(f.options); t.after(() => restored.shutdown())
  await restored.init(); assert.equal(restored.state().state, 'listening')
  await restored.configure({ ...settings, enabled: false })
  assert.equal(restored.state().state, 'disabled')
  await restored.shutdown()
  const disabled = new MainMobileNetwork(f.options); t.after(() => disabled.shutdown())
  await disabled.init(); assert.equal(disabled.state().state, 'disabled')
})

test('missing LAN and port conflicts remain diagnosable and recoverable; shutdown serializes with settings', async t => {
  const f = await fixture(t), port = await unusedPort()
  f.setAddresses([])
  const settings = { enabled: true, port, allowLanHttp: true }
  let state = await f.network.configure(settings)
  assert.equal(state.state, 'error'); assert.match(state.error!, /No private LAN/)
  f.setAddresses(['127.0.0.1'])
  const occupied = createServer().listen(port, '127.0.0.1'); await once(occupied, 'listening')
  state = await f.network.configure(settings)
  assert.equal(state.state, 'error'); assert.match(state.error!, /already in use/)
  await new Promise<void>(resolve => occupied.close(() => resolve()))
  state = await f.network.configure(settings); assert.equal(state.state, 'listening')
  const changing = f.network.configure(settings), closing = f.network.shutdown()
  await assert.rejects(changing, /stopping/); await closing
  await assert.rejects(f.network.configure(settings), /stopping/)
})
