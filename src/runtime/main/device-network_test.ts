import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { createMainCluster } from '../../cluster/main-cluster.ts'
import { InMemoryRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes } from '../../gateway/server.ts'
import { folderFixture } from '../../folders/test-fixtures.ts'
import {
  MainDeviceNetwork,
  isPrivateDeviceAddress,
  parseDeviceNetworkConfig,
  type DeviceNetworkConfig,
} from './device-network.ts'

const credential = 'synthetic-device-network-admin'
const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
const addresses = () => [{ name: 'Test loopback', address: '127.0.0.1' }]

async function unusedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function fixture(t: TestContext) {
  const { root } = await folderFixture(t)
  const clientAddresses = new GatewayClientAddressRegistry()
  const authorize = (request: Request) => request.headers.get('Authorization') === `Bearer ${credential}`
  const cluster = await createMainCluster({
    snapshotAdapter: new InMemoryRegistrySnapshotAdapter(),
    localHello: { protocolMajor: 1, protocolMinor: 0, implementationVersion: 'test', features: ['jobs-v1'] },
    authorizeOfferCreation: authorize,
    clientKey: request => clientAddresses.resolve(request),
  })
  t.after(() => cluster.closeNodeConnections())
  const configPath = join(root, 'device-network.json')
  const options = { cluster, clientAddresses, authorize, configPath, addresses }
  const network = new MainDeviceNetwork(options)
  t.after(() => network.shutdown())
  await network.init()
  const app = new Hono()
  registerGatewayRoutes(app, [network.plugin()], { launchCredential: credential })
  const config: DeviceNetworkConfig = {
    version: 1, enabled: true, host: '127.0.0.1', port: await unusedPort(), allowInsecureLocalTransport: true,
  }
  return { app, config, configPath, network, options }
}

test('device network only accepts explicitly acknowledged private addresses and unprivileged ports', () => {
  for (const address of ['10.0.0.1', '172.16.4.1', '172.31.2.1', '192.168.2.1', '169.254.2.2', '100.64.1.2', '100.127.1.2', '127.0.0.1']) {
    assert.equal(isPrivateDeviceAddress(address), true, address)
  }
  for (const address of ['0.0.0.0', '8.8.8.8', '172.32.1.1', '100.128.1.2', 'localhost', '::', '192.168.1.999']) {
    assert.equal(isPrivateDeviceAddress(address), false, address)
  }
  const config = { version: 1, enabled: true, host: '192.168.1.2', port: 3124, allowInsecureLocalTransport: true }
  assert.deepEqual(parseDeviceNetworkConfig(config), config)
  for (const value of [
    null, [], {}, { ...config, allowInsecureLocalTransport: false }, { ...config, port: 80 },
    { ...config, port: 65536 }, { ...config, port: '3124' }, { ...config, port: 3124.1 },
    { ...config, host: '0.0.0.0' }, { ...config, injected: true }, { ...config, enabled: 1 },
  ]) assert.throws(() => parseDeviceNetworkConfig(value), TypeError)
})

test('device network stays disabled by default and settings require authenticated bounded JSON', async t => {
  const { app, config, network } = await fixture(t)
  assert.equal(network.getState().state, 'disabled')
  assert.equal(network.getState().enabled, false)
  assert.equal(network.getState().endpoint, null)
  for (const method of ['GET', 'PUT']) {
    assert.equal((await app.request('/nodes/v1/network', { method })).status, 401)
  }
  const state = await app.request('/nodes/v1/network', { headers })
  assert.equal(state.headers.get('cache-control'), 'no-store')
  assert.equal((await state.json()).state, 'disabled')
  assert.equal((await app.request('/nodes/v1/network', {
    method: 'PUT', headers: { authorization: headers.authorization }, body: JSON.stringify(config),
  })).status, 415)
  assert.equal((await app.request('/nodes/v1/network', {
    method: 'PUT', headers, body: '{',
  })).status, 400)
  assert.equal((await app.request('/nodes/v1/network', {
    method: 'PUT', headers, body: JSON.stringify({ ...config, padding: 'x'.repeat(3000) }),
  })).status, 413)
  assert.equal((await app.request('/nodes/v1/network', {
    method: 'PUT', headers, body: JSON.stringify({ ...config, host: '10.99.99.99' }),
  })).status, 400)
  assert.equal(network.getState().state, 'disabled')
})

test('device-only listener persists, restores, and never exposes Main administration or browser surfaces', { timeout: 15_000 }, async t => {
  const { app, config, configPath, network, options } = await fixture(t)
  const response = await app.request('/nodes/v1/network', { method: 'PUT', headers, body: JSON.stringify(config) })
  assert.equal(response.status, 200)
  const state = await response.json()
  assert.equal(state.state, 'listening')
  assert.equal(state.endpoint, `http://127.0.0.1:${config.port}`)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config)
  for (const path of ['/', '/api/projects', '/nodes/v1', '/nodes/v1/network', '/nodes/v1/pending', '/local/v1/readiness', '/local/v1/web-pairing', '/pair/v1/offers']) {
    const result = await fetch(state.endpoint + path, { headers, signal: AbortSignal.timeout(3000) })
    assert.equal(result.status, 404, path)
  }
  assert.equal((await fetch(state.endpoint + '/pair/v1/offers', {
    method: 'POST', headers, signal: AbortSignal.timeout(3000),
  })).status, 404)
  assert.equal((await fetch(state.endpoint + '/pair/v1/present', {
    method: 'POST', headers: { ...headers, origin: 'https://malicious.example' }, body: '{}',
    signal: AbortSignal.timeout(3000),
  })).status, 403)
  assert.equal((await fetch(state.endpoint + '/cluster/v1/node', { signal: AbortSignal.timeout(3000) })).status, 426)
  assert.equal((await fetch(state.endpoint + '/pair/v1/present', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
  })).status, 400)
  await network.shutdown()
  const restored = new MainDeviceNetwork(options)
  t.after(() => restored.shutdown())
  await restored.init()
  assert.equal(restored.getState().state, 'listening')
  assert.equal(restored.getState().endpoint, state.endpoint)
  await restored.configure({ ...config, enabled: false })
  assert.equal(restored.getState().state, 'disabled')
  await assert.rejects(fetch(state.endpoint + '/cluster/v1/node', { signal: AbortSignal.timeout(3000) }))
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).enabled, false)
})

test('optional loopback supports a second device ingress without changing the saved endpoint', { timeout: 15_000 }, async t => {
  const { config, configPath, options } = await fixture(t)
  const host = '127.0.0.2' // Synthetic primary interface; never bind a real network interface in this test.
  const primaryConfig = { ...config, host }
  const probe = createServer().listen(0, host)
  try { await once(probe, 'listening') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw error
    t.skip('This OS does not provide a second loopback address')
    return
  }
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const instanceOptions = { ...options, addresses: () => [...addresses(), { name: 'Test primary', address: host }] }
  const dual = new MainDeviceNetwork(instanceOptions)
  t.after(() => dual.shutdown())
  const lan = `http://${host}:${config.port}`
  const loopback = `http://127.0.0.1:${config.port}`
  const request = (base: string, path = '/cluster/v1/node', init?: RequestInit) =>
    fetch(base + path, { ...init, signal: AbortSignal.timeout(3000) })
  assert.equal((await dual.configure(primaryConfig)).endpoint, lan)
  assert.equal((await request(lan)).status, 426)
  await assert.rejects(request(loopback))

  const dualConfig = { ...primaryConfig, enableLoopbackListener: true }
  const blocker = createServer().listen(config.port, '127.0.0.1')
  await once(blocker, 'listening')
  try {
    const state = await dual.configure(dualConfig)
    assert.equal(state.state, 'listening')
    assert.equal(state.endpoint, lan)
    assert.equal(state.enableLoopbackListener, true)
    assert.equal(state.loopbackEndpoint, undefined)
    assert.equal((await request(lan)).status, 426)
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()))
  }
  const listening = await dual.configure(dualConfig)
  assert.equal(listening.endpoint, lan)
  assert.equal(listening.loopbackEndpoint, loopback)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), dualConfig)
  for (const endpoint of [lan, loopback]) {
    assert.equal((await request(endpoint)).status, 426)
    assert.equal((await request(endpoint, '/nodes/v1/network', { headers })).status, 404)
    assert.equal((await request(endpoint, '/pair/v1/present', {
      method: 'POST', headers: { ...headers, origin: 'https://browser.example' }, body: '{}',
    })).status, 403)
  }
  await dual.shutdown()
  const restored = new MainDeviceNetwork(instanceOptions)
  t.after(() => restored.shutdown())
  await restored.init()
  assert.equal(restored.getState().endpoint, lan)
  assert.equal(restored.getState().loopbackEndpoint, loopback)
  assert.equal((await request(loopback)).status, 426)
  assert.equal((await restored.configure({ ...dualConfig, enableLoopbackListener: false })).loopbackEndpoint, undefined)
  assert.equal((await request(lan)).status, 426)
  await assert.rejects(request(loopback))
  assert.equal((await restored.configure({ ...dualConfig, enabled: false })).state, 'disabled')
  await Promise.all([assert.rejects(request(lan)), assert.rejects(request(loopback))])
})

test('occupied port reports actionable failure without reporting a listening endpoint, then retries', { timeout: 15_000 }, async t => {
  const { app, config, network } = await fixture(t)
  const occupied = createServer().listen(config.port, config.host)
  await once(occupied, 'listening')
  let closed = false
  t.after(async () => {
    if (!closed) await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()))
  })
  const failed = await app.request('/nodes/v1/network', { method: 'PUT', headers, body: JSON.stringify(config) })
  assert.equal(failed.status, 503)
  assert.equal(network.getState().state, 'error')
  assert.equal(network.getState().endpoint, null)
  assert.match(network.getState().error!, /already in use/)
  await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()))
  closed = true
  const retried = await network.configure(config)
  assert.equal(retried.state, 'listening')
  assert.equal(retried.error, null)
})

test('missing saved interface leaves Main available with an explicit network error', async t => {
  const { config, configPath, options } = await fixture(t)
  await writeFile(configPath, JSON.stringify({ ...config, host: '10.99.99.99' }))
  const restored = new MainDeviceNetwork(options)
  t.after(() => restored.shutdown())
  await restored.init()
  assert.equal(restored.getState().enabled, true)
  assert.equal(restored.getState().state, 'error')
  assert.equal(restored.getState().endpoint, null)
  assert.match(restored.getState().error!, /unavailable/)
  assert.equal((await restored.configure({ ...config, enabled: false })).state, 'disabled')
})

test('corrupt settings are visible as a network error and never open a listener', async t => {
  const { configPath, options } = await fixture(t)
  await writeFile(configPath, '{"version":')
  const restored = new MainDeviceNetwork(options)
  t.after(() => restored.shutdown())
  await restored.init()
  assert.equal(restored.getState().state, 'error')
  assert.equal(restored.getState().endpoint, null)
  assert.equal(restored.getState().enabled, false)
})
