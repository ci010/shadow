import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { validatePairingNodeStateV1, validateRegistrySnapshotV1 } from './contracts.ts'
import { nodeAdministrationApiPlugin } from './node-administration-api.ts'
import { AtomicFileRegistrySnapshotAdapter, RegistrySnapshotCoordinator } from './persistence.ts'
import { InMemoryPairingNodeRegistry, RegistryError } from './registry.ts'

const now = new Date('2026-09-16T00:00:00.000Z')

function present(registry: InMemoryPairingNodeRegistry, id: string) {
  const authentication = { deviceId: `device-${id}`, nodeId: `node-${id}`, credentialId: `credential-${id}` }
  registry.createOffer(`offer-${id}`, now, new Date(now.getTime() + 60_000))
  registry.presentOffer({
    ...authentication,
    offerId: `offer-${id}`,
    pendingId: `pending-${id}`,
    deviceIdentityFingerprint: `fingerprint-${id}`,
    devicePublicKey: Buffer.alloc(32, 1).toString('base64url'),
    displayName: id,
  }, now)
  return authentication
}

function approve(registry: InMemoryPairingNodeRegistry, id: string) {
  const authentication = present(registry, id)
  registry.approve({
    pendingId: `pending-${id}`,
    expectedDeviceIdentityFingerprint: `fingerprint-${id}`,
    credentialId: authentication.credentialId,
  }, now)
  return authentication
}

test('old authorization metadata is discarded on snapshot restore and stays absent after a file restart', async () => {
  await withTempWorkspace(async root => {
    const source = new InMemoryPairingNodeRegistry()
    const active = approve(source, 'active')
    const revoked = approve(source, 'revoked')
    source.revoke(revoked, 'retired device', now)
    present(source, 'pending')
    const capability = {
      version: 1 as const, capabilityId: 'shell', nodeId: active.nodeId,
      kind: 'shell' as const, displayName: 'Shell', permissions: ['process.execute'], online: true,
    }
    source.advertiseCapability(active, capability)
    const canonical = source.exportSnapshot(now)
    const legacy = {
      ...canonical,
      nodes: canonical.nodes.map(node => ({ ...node, uiScopes: [], nodePrivileges: [] })),
    }
    const path = join(root, 'registry.v1.json')
    await writeFile(path, JSON.stringify(legacy))
    const adapter = new AtomicFileRegistrySnapshotAdapter(path)
    const restored = new InMemoryPairingNodeRegistry()
    const coordinator = new RegistrySnapshotCoordinator(restored, adapter)
    assert.equal(await coordinator.restore(now), true)
    assert.deepEqual(restored.exportSnapshot(now), canonical)
    assert.deepEqual(legacy.nodes[0].nodePrivileges, [])
    assert.deepEqual(restored.authenticate(active), canonical.nodes[0])
    restored.advertiseCapability(active, capability)
    assert.throws(() => restored.authenticate(revoked),
      (error: unknown) => error instanceof RegistryError && error.code === 'node-revoked')
    assert.throws(() => restored.advertiseCapability(active, { ...capability, nodeId: revoked.nodeId }),
      (error: unknown) => error instanceof RegistryError && error.code === 'capability-denied')
    await coordinator.save(now)
    await coordinator.flush()
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), canonical)
    const restarted = new InMemoryPairingNodeRegistry()
    await new RegistrySnapshotCoordinator(restarted, new AtomicFileRegistrySnapshotAdapter(path)).restore(now)
    assert.deepEqual(restarted.exportSnapshot(now), canonical)
  })
})

test('snapshot compatibility does not admit old authorization on the wire or hide malformed identity', () => {
  const source = new InMemoryPairingNodeRegistry()
  approve(source, 'active')
  const canonical = source.exportSnapshot(now)
  const node = canonical.nodes[0]
  for (const metadata of [
    { uiScopes: ['chat:read'], nodePrivileges: ['jobs:execute'] },
    { uiScopes: null, nodePrivileges: 'retired' },
  ]) {
    const legacyNode = { ...node, ...metadata }
    assert.equal(validatePairingNodeStateV1(legacyNode).success, false)
    const normalized = validateRegistrySnapshotV1({ ...canonical, nodes: [legacyNode] })
    assert.equal(normalized.success, true)
    if (normalized.success) assert.deepEqual(normalized.value, canonical)
    for (const invalid of [
      { ...legacyNode, nodeId: '' },
      { ...legacyNode, credentialId: '../foreign' },
      { ...legacyNode, unexpected: true },
    ]) {
      assert.equal(validateRegistrySnapshotV1({ ...canonical, nodes: [invalid] }).success, false)
    }
  }
  assert.equal(validateRegistrySnapshotV1({ ...canonical, version: 2 }).success, false)
})

test('device approval needs owner authentication and identity confirmation, not permission lists', async () => {
  const registry = new InMemoryPairingNodeRegistry()
  const authentication = present(registry, 'active')
  let authorized = false
  let approvals = 0
  const app = new Hono()
  nodeAdministrationApiPlugin({
    registry,
    authorize: () => authorized,
    revoke: async () => { throw new Error('Unexpected revocation') },
    approve: async (approval, time) => {
      approvals++
      registry.approve(approval, time)
      return authentication
    },
    now: () => now,
  })(app)
  const body = { version: 1, expectedDeviceIdentityFingerprint: 'fingerprint-active' }
  const request = (value: unknown) => app.request('/nodes/v1/pending/pending-active/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  })
  assert.equal((await request(body)).status, 401)
  authorized = true
  for (const retired of [{ uiScopes: [] }, { nodePrivileges: ['jobs:execute'] }]) {
    assert.equal((await request({ ...body, ...retired })).status, 400)
  }
  assert.equal(approvals, 0)
  assert.equal((await request({ ...body, expectedDeviceIdentityFingerprint: 'wrong' })).status, 400)
  assert.equal(registry.getPending().length, 1)
  const response = await request(body)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { version: 1, ...authentication })
  const approved = registry.authenticate(authentication)
  assert.equal('uiScopes' in approved, false)
  assert.equal('nodePrivileges' in approved, false)
})
