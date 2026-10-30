import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostname } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { authorizeMainNodeInventory, childLocalNodeInventory, mainLocalNodeInventory } from './node-inventory.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from '../gateway/server.ts'
import { Hono } from 'hono'
import { createMainCluster } from '../cluster/main-cluster.ts'
import { InMemoryRegistrySnapshotAdapter } from '../cluster/persistence.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import type { ExecutionSupport } from '../cluster/contracts.ts'

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
      connection: 'connected', support: { operations: [] }, workdirs: [], executionProtocol: 'compatible',
    }),
  })
  const app = new Hono()
  registerGatewayRoutes(app, [...cluster.plugins], { clientAddresses: addresses })
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

test('Main inventory uses configured identity and live registered folder availability', async () => {
  await withTempWorkspace(async (root) => {
    const folders = new FolderRegistry(root)
    await folders.init()
    const options = {
      localNodeId: 'installation-main',
      implementationVersion: 'test-build',
      folders,
      shellAvailable: false,
    }
    assert.deepEqual(mainLocalNodeInventory(options), {
      nodeId: 'installation-main',
      displayName: hostname(),
      role: 'main',
      connection: 'connected',
      implementationVersion: 'test-build',
      support: { operations: [] }, workdirs: [], executionProtocol: 'compatible',
    })
    const directory = join(root, 'actual-folder')
    await mkdir(directory)
    const folder = await folders.register(directory)
    const inventory = () => mainLocalNodeInventory({ ...options, shellAvailable: true })
    assert.deepEqual(inventory().support, { operations: ['process.execute'] })
    assert.deepEqual(inventory().workdirs, [{ version: 2 as const, nodeId: 'installation-main', workdirId: `local-project-v1:${folder.id}`, displayName: folder.name, displayPath: folder.path, online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute'] } }])
    assert.equal(inventory().workdirs[0].workdirId, `local-project-v1:${folder.id}`)
    assert.equal(inventory().workdirs[0].support.operations.includes('workdir.process.execute'), true)
    assert.equal(inventory().workdirs[0].support.operations.includes('workdir.process.execute-once'), false)
    const coordinator = mainLocalNodeInventory({ ...options, shellAvailable: false })
    assert.equal(coordinator.workdirs.some(w => w.support.operations.some(op => op.includes('process.'))), false)
    assert.equal(coordinator.workdirs[0].support.operations.includes('filesystem.read'), true)
    await rm(directory, { recursive: true })
    assert.equal(inventory().workdirs[0].online, false)
    assert.equal(inventory().workdirs[0].online, false)
    assert.equal(inventory().workdirs[0].displayPath, folder.path)
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
        { workdirId: 'workdir-1', displayName: 'Available folder', rootPath: root },
        { workdirId: 'workdir-2', displayName: 'Missing folder', rootPath: join(root, 'missing') },
      ],
    }
    const workdirs: import('../execution/workdir-contracts.ts').WorkdirAdvertisement[] = config.workdirs!.map((workdir) => ({ version: 2 as const, nodeId: config.localNodeId, workdirId: workdir.workdirId, displayName: workdir.displayName, online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute'] } }))
    const inventory = await childLocalNodeInventory(config, workdirs, { operations: [] }, 'test-build')
    assert.equal(inventory.nodeId, config.localNodeId)
    assert.equal(inventory.role, 'child')
    assert.equal(inventory.displayName, hostname())
    assert.equal(inventory.workdirs[0].displayPath, root)
    assert.equal(inventory.workdirs[0].online, true)
    assert.equal(inventory.workdirs[1].online, false)
    assert.ok(!JSON.stringify(inventory).includes('private'))
    assert.ok(!JSON.stringify(inventory).includes('approvalPolicy'))
    assert.ok(!('lastSeen' in inventory))
  })
})

test('offline Child inventory cannot advertise execution or report an unnegotiated upgrade requirement', async () => {
  await withTempWorkspace(async root => {
    const config: ChildBootstrapConfigV1 = { version: 1, mode: 'child', dataDir: root, localNodeId: 'child', mainEndpoint: 'https://example.invalid' }
    const workdirs = [{ version: 2 as const, nodeId: 'child', workdirId: 'folder', support: { operations: ['filesystem.read'] }, displayName: 'Folder', displayPath: root, online: true }]
    const support: ExecutionSupport = { operations: ['workdir.session.allocate'] }
    const offline = await childLocalNodeInventory(config, workdirs, support, 'fixture', 'offline')
    assert.equal(offline.executionProtocol, 'unknown')
    assert.equal(offline.supportsManagedSessions, false)
    assert(offline.workdirs.every(r => !r.online))
    assert(offline.support.operations.length === 0)
    const connected = await childLocalNodeInventory(config, workdirs, support, 'fixture', 'connected')
    assert.equal(connected.executionProtocol, 'compatible')
    assert.equal(connected.supportsManagedSessions, true)
    assert(connected.workdirs.every(r => r.online))
    assert(connected.support.operations.includes('workdir.session.allocate'))
  })
})
