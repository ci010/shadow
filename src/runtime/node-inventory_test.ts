import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostname } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectRegistry } from '../projects/registry.ts'
import { authorizeMainNodeInventory, childLocalNodeInventory, mainLocalNodeInventory } from './node-inventory.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from '../gateway/server.ts'
import { Hono } from 'hono'
import { createMainCluster } from '../cluster/main-cluster.ts'
import { InMemoryRegistrySnapshotAdapter } from '../cluster/persistence.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'

test('credentialless Main inventory requires a captured loopback peer and local hostname', async () => {
  const addresses = new GatewayClientAddressRegistry()
  const local = new Request('http://localhost:3123/nodes/v1')
  assert.equal(await authorizeMainNodeInventory(local, undefined, addresses), false)
  addresses.capture(local, { transport: 'tcp', hostname: '127.0.0.1' })
  assert.equal(await authorizeMainNodeInventory(local, undefined, addresses), true)
  assert.equal(await authorizeMainNodeInventory(local, 'configured-secret', addresses), false)

  for (const hostname of ['::1', '::ffff:127.0.0.1']) {
    addresses.capture(local, { transport: 'tcp', hostname })
    assert.equal(await authorizeMainNodeInventory(local, undefined, addresses), true)
  }
  const remote = new Request('http://localhost:3123/nodes/v1', {
    headers: {
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
    },
  })
  addresses.capture(remote, { transport: 'tcp', hostname: '192.0.2.10' })
  assert.equal(await authorizeMainNodeInventory(remote, undefined, addresses), false)
  const hostileHost = new Request('http://attacker.example/nodes/v1')
  addresses.capture(hostileHost, { transport: 'tcp', hostname: '127.0.0.1' })
  assert.equal(await authorizeMainNodeInventory(hostileHost, undefined, addresses), false)
  const credentialed = new Request('http://main.example/nodes/v1', {
    headers: { Authorization: 'Bearer configured-secret' },
  })
  addresses.capture(credentialed, { transport: 'tcp', hostname: '192.0.2.10' })
  assert.equal(await authorizeMainNodeInventory(credentialed, 'configured-secret', addresses), true)
})

test('local Main inventory works without a credential while pairing and admin remain closed', async (t) => {
  const addresses = new GatewayClientAddressRegistry()
  const cluster = await createMainCluster({
    snapshotAdapter: new InMemoryRegistrySnapshotAdapter(),
    localHello: {
      protocolMajor: 1, protocolMinor: 0, implementationVersion: 'fixture', features: [],
    },
    authorizeOfferCreation: () => false,
    authorizeInventory: (request) => authorizeMainNodeInventory(request, undefined, addresses),
    clientKey: (request) => addresses.resolve(request),
    localNodeInventory: () => ({
      nodeId: 'local', displayName: hostname(), role: 'main',
      connection: 'connected', capabilities: [],
    }),
  })
  const app = new Hono()
  registerGatewayRoutes(app, [...cluster.plugins])
  const server = serveGateway(app, {
    host: '127.0.0.1', port: 0, clientAddresses: addresses,
  })
  await server.ready
  t.after(async () => {
    await cluster.closeNodeConnections()
    await server.shutdown()
  })
  const base = `http://127.0.0.1:${server.addr.port}`
  const response = await fetch(`${base}/nodes/v1`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).nodes[0].nodeId, 'local')
  assert.equal((await fetch(`${base}/nodes/v1/pending`)).status, 401)
  assert.equal((await fetch(`${base}/pair/v1/offers`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/nodes/v1`, {
    headers: { Origin: 'https://attacker.example' },
  })).status, 403)
  assert.equal((await app.request(`${base}/nodes/v1`, {
    headers: { 'X-Forwarded-For': '127.0.0.1' },
  })).status, 401)
})

test('Main inventory uses configured identity and live registered project availability', async () => {
  await withTempWorkspace(async (root) => {
    const projects = new ProjectRegistry(root)
    await projects.init()
    const options = {
      localNodeId: 'installation-main',
      implementationVersion: 'test-build',
      projects,
      shellAvailable: false,
    }
    assert.deepEqual(mainLocalNodeInventory(options), {
      nodeId: 'installation-main',
      displayName: hostname(),
      role: 'main',
      connection: 'connected',
      implementationVersion: 'test-build',
      capabilities: [],
    })
    const directory = join(root, 'actual-project')
    await mkdir(directory)
    const project = await projects.register(directory)
    const inventory = () => mainLocalNodeInventory({ ...options, shellAvailable: true })
    assert.deepEqual(inventory().capabilities, [
      { capabilityId: 'process-execute', kind: 'shell', displayName: 'Local shell', online: true },
      {
        capabilityId: `local-project-v1:${project.id}`,
        kind: 'workdir',
        displayName: project.name,
        displayPath: project.path,
        online: true,
      },
    ])
    await rm(directory, { recursive: true })
    assert.equal(inventory().capabilities[1].online, false)
    assert.equal(inventory().capabilities[1].displayPath, project.path)
    assert.ok(!('lastSeen' in inventory()))
  })
})

test('Child inventory exposes only executor descriptors and configured local workdir paths', async () => {
  await withTempWorkspace(async (root) => {
    const config: ChildBootstrapConfigV1 = {
      version: 1,
      mode: 'child',
      dataDir: root,
      localNodeId: 'configured-child',
      mainEndpoint: 'https://private-main.example.invalid',
      workdirs: [
        { capabilityId: 'workdir-1', displayName: 'Available folder', rootPath: root },
        { capabilityId: 'workdir-2', displayName: 'Missing folder', rootPath: join(root, 'missing') },
      ],
    }
    const capabilities: CapabilityDescriptorV1[] = config.workdirs!.map((workdir) => ({
      version: 1,
      nodeId: config.localNodeId,
      kind: 'workdir',
      capabilityId: workdir.capabilityId,
      displayName: workdir.displayName,
      online: true,
      approvalPolicy: 'grant',
      permissions: ['private-operation'],
    }))
    const inventory = await childLocalNodeInventory(config, capabilities, 'test-build')
    assert.equal(inventory.nodeId, config.localNodeId)
    assert.equal(inventory.role, 'child')
    assert.equal(inventory.displayName, hostname())
    assert.equal(inventory.capabilities[0].displayPath, root)
    assert.equal(inventory.capabilities[0].online, true)
    assert.equal(inventory.capabilities[1].online, false)
    assert.ok(!JSON.stringify(inventory).includes('private'))
    assert.ok(!JSON.stringify(inventory).includes('approvalPolicy'))
    assert.ok(!('lastSeen' in inventory))
  })
})
