import { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionSupport, VersionHelloV1 } from './contracts.ts'
import {
  InMemoryPairingNodeRegistry,
  RegistryError,
  type RegistryErrorCode,
} from './registry.ts'

const baseTime = new Date('2026-08-26T00:00:00.000Z')
const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const hello: VersionHelloV1 = {
  protocolMajor: 1,
  protocolMinor: 2,
  implementationVersion: '0.1.0',
  features: ['workdir-execution-v2'],
}
const capability: ExecutionSupport = { operations: ['process.execute'] }

function expectCode(code: RegistryErrorCode, action: () => unknown): void {
  assertThrows(
    action,
    (error) => error instanceof RegistryError && error.code === code,
  )
}

function present(registry: InMemoryPairingNodeRegistry): void {
  registry.createOffer(
    'offer-1',
    baseTime,
    new Date(baseTime.getTime() + 60_000),
  )
  registry.presentOffer({
    offerId: 'offer-1',
    pendingId: 'pending-1',
    deviceId: 'device-1',
    nodeId: 'node-1',
    deviceIdentityFingerprint: 'fingerprint-1',
    displayName: 'Workstation',
  }, new Date(baseTime.getTime() + 1_000))
}

function approve(registry: InMemoryPairingNodeRegistry): void {
  present(registry)
  registry.approve({
    pendingId: 'pending-1',
    expectedDeviceIdentityFingerprint: 'fingerprint-1',
    credentialId: 'credential-1',
  }, new Date(baseTime.getTime() + 2_000))
}

test('pairing offers expire once and reject replay after presentation', () => {
  const expired = new InMemoryPairingNodeRegistry()
  expired.createOffer(
    'expired-offer',
    baseTime,
    new Date(baseTime.getTime() + 1_000),
  )
  const expiredPresentation = {
    offerId: 'expired-offer',
    pendingId: 'expired-pending',
    deviceId: 'device-expired',
    nodeId: 'node-expired',
    deviceIdentityFingerprint: 'fingerprint-expired',
    displayName: 'Expired workstation',
  }
  expectCode('offer-expired', () =>
    expired.presentOffer(
      expiredPresentation,
      new Date(baseTime.getTime() + 1_000),
    ))
  expectCode('offer-replayed', () =>
    expired.presentOffer(
      expiredPresentation,
      new Date(baseTime.getTime() + 2_000),
    ))

  const consumed = new InMemoryPairingNodeRegistry()
  present(consumed)
  expectCode('offer-replayed', () =>
    consumed.presentOffer({
      offerId: 'offer-1',
      pendingId: 'pending-2',
      deviceId: 'device-2',
      nodeId: 'node-2',
      deviceIdentityFingerprint: 'fingerprint-2',
      displayName: 'Other workstation',
    }, new Date(baseTime.getTime() + 2_000)))
})

test('pending pairing denies capabilities and fingerprint mismatch cannot approve', () => {
  const registry = new InMemoryPairingNodeRegistry()
  present(registry)
  assertEquals(registry.getPending().length, 1)
  expectCode(
    'node-not-approved',
    () => registry.advertiseNodeSupport(auth, auth.nodeId, capability),
  )
  expectCode('fingerprint-mismatch', () =>
    registry.approve({
      pendingId: 'pending-1',
      expectedDeviceIdentityFingerprint: 'different-fingerprint',
      credentialId: 'credential-1',
    }, new Date(baseTime.getTime() + 2_000)))
  assertEquals(registry.getPending().length, 1)

  registry.createOffer(
    'offer-2',
    baseTime,
    new Date(baseTime.getTime() + 60_000),
  )
  expectCode('identity-conflict', () =>
    registry.presentOffer({
      offerId: 'offer-2',
      pendingId: 'pending-2',
      deviceId: 'device-2',
      nodeId: 'node-1',
      deviceIdentityFingerprint: 'fingerprint-2',
      displayName: 'Conflicting workstation',
    }, new Date(baseTime.getTime() + 2_000)))
})

test('approval establishes device trust and reconnect preserves all identity bindings', () => {
  const registry = new InMemoryPairingNodeRegistry()
  approve(registry)
  assertEquals(registry.authenticate(auth).nodeId, auth.nodeId)
  expectCode('credential-mismatch', () =>
    registry.authenticate({
      ...auth,
      credentialId: 'credential-other',
    }))
  expectCode(
    'node-not-approved',
    () => registry.authenticate({ ...auth, nodeId: 'node-other' }),
  )

  assertEquals(
    registry.reconnect(auth, hello, {
      ...hello,
      protocolMinor: 1,
      features: ['workdir-execution-v2'],
    }),
    { protocolMajor: 1, protocolMinor: 1, features: ['workdir-execution-v2'] },
  )
  expectCode('protocol-major-mismatch', () =>
    registry.reconnect(auth, hello, {
      ...hello,
      protocolMajor: 2,
    }))
})

test('approved node advertises only its capabilities and revocation blocks reconnect', () => {
  const registry = new InMemoryPairingNodeRegistry()
  approve(registry)
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)
  assertEquals(registry.nodeSupport('node-1'), capability)
  expectCode('capability-denied', () => registry.advertiseNodeSupport(auth, 'node-other', capability))
  registry.advertiseNodeSupport(auth, auth.nodeId, { operations: [] })
  assertEquals(registry.nodeSupport(auth.nodeId), { operations: [] })
  registry.advertiseNodeSupport(auth, auth.nodeId, capability)

  const revoked = registry.revoke(
    auth,
    'operator revoked device',
    new Date(baseTime.getTime() + 3_000),
  )
  assertEquals(revoked.state, 'revoked')
  assertEquals(registry.nodeSupport('node-1'), { operations: [] })
  expectCode('node-revoked', () => registry.reconnect(auth, hello, hello))
})

test('registry snapshot restores pairing, authorization, replay, and capability state', () => {
  const source = new InMemoryPairingNodeRegistry()
  approve(source)
  source.advertiseNodeSupport(auth, auth.nodeId, capability)

  source.createOffer(
    'active-offer',
    baseTime,
    new Date(baseTime.getTime() + 120_000),
  )
  source.createOffer(
    'expired-on-restore',
    baseTime,
    new Date(baseTime.getTime() + 5_000),
  )
  source.createOffer(
    'pending-offer',
    baseTime,
    new Date(baseTime.getTime() + 120_000),
  )
  source.presentOffer({
    offerId: 'pending-offer',
    pendingId: 'pending-2',
    deviceId: 'device-2',
    nodeId: 'node-2',
    deviceIdentityFingerprint: 'fingerprint-2',
    displayName: 'Pending workstation',
  }, new Date(baseTime.getTime() + 3_000))

  source.createOffer(
    'revoked-offer',
    baseTime,
    new Date(baseTime.getTime() + 120_000),
  )
  source.presentOffer({
    offerId: 'revoked-offer',
    pendingId: 'pending-3',
    deviceId: 'device-3',
    nodeId: 'node-3',
    deviceIdentityFingerprint: 'fingerprint-3',
    displayName: 'Revoked workstation',
  }, new Date(baseTime.getTime() + 3_000))
  source.approve({
    pendingId: 'pending-3',
    expectedDeviceIdentityFingerprint: 'fingerprint-3',
    credentialId: 'credential-3',
  }, new Date(baseTime.getTime() + 4_000))
  source.revoke(
    { deviceId: 'device-3', nodeId: 'node-3', credentialId: 'credential-3' },
    'retired',
    new Date(baseTime.getTime() + 5_000),
  )

  const snapshot = source.exportSnapshot(new Date(baseTime.getTime() + 4_000))
  snapshot.nodeSupport.push({ nodeId: 'node-3', support: capability })
  const restored = new InMemoryPairingNodeRegistry()
  restored.restoreSnapshot(snapshot, new Date(baseTime.getTime() + 10_000))

  assertEquals(restored.getPending(), [{
    version: 1,
    state: 'pending',
    offerId: 'pending-offer',
    pendingId: 'pending-2',
    deviceId: 'device-2',
    nodeId: 'node-2',
    deviceIdentityFingerprint: 'fingerprint-2',
    displayName: 'Pending workstation',
    requestedAt: '2026-08-26T00:00:03.000Z',
  }])
  restored.authenticate(auth)
  assertEquals(restored.nodeSupport('node-1'), capability)
  assertEquals(restored.nodeSupport('node-3'), { operations: [] })
  expectCode('node-revoked', () =>
    restored.authenticate({
      deviceId: 'device-3',
      nodeId: 'node-3',
      credentialId: 'credential-3',
    }))
  expectCode('offer-replayed', () =>
    restored.presentOffer({
      offerId: 'offer-1',
      pendingId: 'pending-replay',
      deviceId: 'device-replay',
      nodeId: 'node-replay',
      deviceIdentityFingerprint: 'fingerprint-replay',
      displayName: 'Replay',
    }, new Date(baseTime.getTime() + 10_000)))
  expectCode('offer-replayed', () =>
    restored.presentOffer({
      offerId: 'expired-on-restore',
      pendingId: 'pending-expired',
      deviceId: 'device-expired',
      nodeId: 'node-expired',
      deviceIdentityFingerprint: 'fingerprint-expired',
      displayName: 'Expired',
    }, new Date(baseTime.getTime() + 10_000)))
  restored.presentOffer({
    offerId: 'active-offer',
    pendingId: 'pending-active',
    deviceId: 'device-active',
    nodeId: 'node-active',
    deviceIdentityFingerprint: 'fingerprint-active',
    displayName: 'Active',
  }, new Date(baseTime.getTime() + 10_000))
})

test('legacy registry policies are retired without changing pairing or capability ownership', () => {
  const source = new InMemoryPairingNodeRegistry()
  approve(source)
  source.advertiseNodeSupport(auth, auth.nodeId, capability)
  const snapshot = source.exportSnapshot(baseTime)

  for (const approvalPolicy of ['none', 'always', 'session', 'grant']) {
    const { workdirs, nodeSupport, ...base } = snapshot
    const legacy = {
      ...base, version: 1,
      capabilities: snapshot.nodeSupport.map(entry => ({ version: 1, nodeId: entry.nodeId, capabilityId: 'legacy-shell', kind: 'shell', displayName: 'Shell', permissions: entry.support.operations, online: true, approvalPolicy })),
    }
    const restored = new InMemoryPairingNodeRegistry()
    restored.restoreSnapshot(legacy, baseTime)
    restored.authenticate(auth)
    assertEquals(restored.exportSnapshot(baseTime), snapshot)
    assertEquals(legacy.capabilities[0].approvalPolicy, approvalPolicy)
    expectCode('invalid-contract', () => restored.restoreSnapshot({
      ...legacy, capabilities: [{ ...legacy.capabilities[0], nodeId: 'unknown-node' }],
    }, baseTime))
    expectCode('invalid-contract', () => restored.restoreSnapshot({
      ...legacy, capabilities: [{ ...legacy.capabilities[0], approvalPolicy: 'invalid' }],
    }, baseTime))
    assertEquals(restored.exportSnapshot(baseTime), snapshot)
  }
})

test('registry snapshot restore rejects invalid state atomically', () => {
  const registry = new InMemoryPairingNodeRegistry()
  approve(registry)
  const snapshot = registry.exportSnapshot(baseTime)

  expectCode(
    'invalid-contract',
    () => registry.restoreSnapshot({ ...snapshot, version: 99 }, baseTime),
  )
  registry.authenticate(auth)

  expectCode('invalid-contract', () =>
    registry.restoreSnapshot({
      ...snapshot,
      capabilities: [{ ...capability, nodeId: 'unknown-node' }],
    }, baseTime))
  registry.authenticate(auth)
})

test('revoked exact key-bound identity requires a fresh offer and explicit reapproval; conflicting identity is denied', () => {
  const registry = new InMemoryPairingNodeRegistry()
  const presentation = { ...auth, offerId: 'first', pendingId: 'pending-first', deviceIdentityFingerprint: 'fingerprint-1', devicePublicKey: 'A'.repeat(43), displayName: 'Child' }
  registry.createOffer('first', baseTime, new Date(baseTime.getTime() + 60000))
  registry.presentOffer(presentation, baseTime)
  registry.approve({ pendingId: presentation.pendingId, expectedDeviceIdentityFingerprint: 'fingerprint-1', credentialId: auth.credentialId }, baseTime)
  registry.revoke(auth, 'operator revoked', baseTime)
  registry.createOffer('fresh', baseTime, new Date(baseTime.getTime() + 60000))
  expectCode('identity-conflict', () => registry.presentOffer({ ...presentation, offerId: 'fresh', pendingId: 'pending-new', devicePublicKey: 'B'.repeat(43) }, baseTime))
  registry.presentOffer({ ...presentation, offerId: 'fresh', pendingId: 'pending-new' }, baseTime)
  expectCode('node-revoked', () => registry.authenticate(auth))
  const restored = new InMemoryPairingNodeRegistry()
  restored.restoreSnapshot(registry.exportSnapshot(baseTime), baseTime)
  expectCode('node-revoked', () => restored.authenticate(auth))
  restored.approve({ pendingId: 'pending-new', expectedDeviceIdentityFingerprint: 'fingerprint-1', credentialId: auth.credentialId }, baseTime)
  assertEquals(restored.authenticate(auth).nodeId, auth.nodeId)
})
