import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobEventV1, ExecutionRequestV2 } from '../execution/contracts.ts'
import {
  isClusterIdentifier,
  validateExecutionSupport,
  validateWorkdirAdvertisement,
  validateNodeControlEnvelopeV1,
  validatePairingNodeStateV1,
  validateRegistrySnapshotV1,
  validateVersionHelloV1,
} from './contracts.ts'

test('cluster identity and version hello contracts reject malformed wire data', () => {
  const hello = {
    protocolMajor: 1,
    protocolMinor: 0,
    implementationVersion: '0.1.0',
    features: ['workdir-execution-v2'],
  }

  assert(validateVersionHelloV1(hello).success)
  assert.equal(validateVersionHelloV1({ ...hello, protocolMajor: 2 }).success, false)
  assert.equal(validateVersionHelloV1({ ...hello, surprise: true }).success, false)
  assert.equal(validateVersionHelloV1({ ...hello, features: ['jobs-v1', 'jobs-v1'] }).success, false)
  assert(isClusterIdentifier('node:desktop-01'))
  assert.equal(isClusterIdentifier(''), false)
  assert.equal(isClusterIdentifier('node with spaces'), false)
})

test('pairing and capability contracts validate states, versions, and unknown fields', () => {
  const pending = {
    version: 1,
    state: 'pending',
    pendingId: 'pending-1',
    offerId: 'offer-1',
    deviceId: 'device-1',
    nodeId: 'node-1',
    deviceIdentityFingerprint: 'fingerprint-1',
    displayName: 'Workstation',
    requestedAt: '2026-08-26T00:00:00.000Z',
  }
  assert(validatePairingNodeStateV1(pending).success)
  for (const displayName of [' ', 'x'.repeat(257), 'Child\nforged', '\u202eChild']) {
    assert.equal(validatePairingNodeStateV1({ ...pending, displayName }).success, false)
  }
  assert.equal(validatePairingNodeStateV1({ ...pending, version: 2 }).success, false)
  assert.equal(validatePairingNodeStateV1({ ...pending, rawSecret: 'must-not-appear' }).success, false)

  const capability = { operations: ['process.execute'] }
  assert(validateExecutionSupport(capability).success)
  assert.equal(validateExecutionSupport({ ...capability, approvalPolicy: 'none' }).success, false)
  assert.equal(validateExecutionSupport({ ...capability, approvalPolicy: 'invalid' }).success, false)
  assert.equal(validateExecutionSupport({ ...capability, kind: 'root-access' }).success, false)
})

test('registry snapshot contract is strict, versioned, and validates nested state', () => {
  const snapshot = {
    version: 1,
    createdAt: '2026-08-26T00:00:00.000Z',
    offers: [{
      version: 1,
      state: 'offer',
      offerId: 'offer-1',
      createdAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T00:01:00.000Z',
    }],
    consumedOfferIds: ['offer-consumed'],
    pending: [],
    nodes: [],
    capabilities: [],
  }
  assert(validateRegistrySnapshotV1(snapshot).success)
  assert.equal(validateRegistrySnapshotV1({ ...snapshot, version: 2 }).success, false)
  assert.equal(validateRegistrySnapshotV1({ ...snapshot, storagePath: 'registry.json' }).success, false)
  assert.equal(validateRegistrySnapshotV1({
    ...snapshot,
    offers: [{ ...snapshot.offers[0], state: 'pending' }],
  }).success, false)
  assert.equal(validateRegistrySnapshotV1({
    ...snapshot,
    consumedOfferIds: ['offer-consumed', 'offer-consumed'],
  }).success, false)
})

test('workdir display metadata is optional, bounded and display-only', () => {
  const capability = { version: 2 as const, workdirId: 'workdir', nodeId: 'child', displayName: '项目', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } }
  assert(validateWorkdirAdvertisement(capability).success)
  for (const displayPath of ['/home/user/folder', 'Z:\\folder', 'opaque:path', 'a'.repeat(4096)]) {
    assert(validateWorkdirAdvertisement({ ...capability, displayPath }).success)
  }
  for (const displayPath of [null, 7, '', ' ', 'a'.repeat(4097), '/a\nb', '/a\0b', '\u202eabc']) {
    assert.equal(validateWorkdirAdvertisement({ ...capability, displayPath }).success, false)
  }
  for (const displayName of ['', ' ', 'a'.repeat(257), 'a\nb', '\u2066fake']) {
    assert.equal(validateWorkdirAdvertisement({ ...capability, displayName }).success, false)
  }
  assert.equal(validateWorkdirAdvertisement({ ...capability, kind: 'shell', displayPath: '/root' }).success, false)
  assert.equal(validateWorkdirAdvertisement({ ...capability, path: '/root' }).success, false)
})

test('node-control envelopes carry runtime-validated S2 jobs and events', () => {
  const request: ExecutionRequestV2 = {
    version: 2,
    jobId: 'job-1',
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    projectScope: '0123456789abcdef0123456789abcdef',
    operation: 'process.execute',
    args: { command: 'node --test' },
    createdAt: '2026-08-26T00:00:00.000Z',
    deadlineAt: '2026-08-26T00:01:00.000Z',
  }
  const event: JobEventV1 = {
    version: 1,
    jobId: 'job-1',
    sequence: 0,
    timestamp: '2026-08-26T00:00:01.000Z',
    type: 'accepted',
  }
  assert(validateNodeControlEnvelopeV1({
    version: 1,
    messageId: 'message-1',
    type: 'job-request',
    request,
  }).success)
  assert(validateNodeControlEnvelopeV1({
    version: 1,
    messageId: 'message-2',
    type: 'job-event',
    event,
  }).success)
  assert.equal(validateNodeControlEnvelopeV1({
    version: 1,
    messageId: 'message-3',
    type: 'job-request',
    request: { ...request, version: 1 },
  }).success, false)
})

test('intermediate registry resources and scoped descriptors normalize only at the storage boundary', async () => {
  const { validateRegistrySnapshot } = await import('./contracts.ts')
  const snapshot = {
    version: 2, createdAt: '2026-01-01T00:00:00.000Z', offers: [], consumedOfferIds: [], pending: [], nodes: [],
    resources: [{ version: 1, nodeId: 'child', resourceId: 'unchanged-id', kind: 'directory', displayName: 'Folder', online: true }],
    capabilities: [{ version: 2, nodeId: 'child', capabilityId: 'old-support-description', scope: { kind: 'resource', resourceId: 'unchanged-id' }, displayName: 'Files', operations: ['filesystem.read'], online: true }],
  }
  const bytes = JSON.stringify(snapshot)
  const result = validateRegistrySnapshot(snapshot)
  assert(result.success)
  assert.deepEqual(result.value.workdirs, [{ version: 2, nodeId: 'child', workdirId: 'unchanged-id', displayName: 'Folder', online: false, support: { operations: ['filesystem.read'] } }])
  assert.deepEqual(result.value.nodeSupport, [])
  assert.equal('capabilities' in result.value, false)
  assert.equal('resources' in result.value, false)
  assert.equal(JSON.stringify(snapshot), bytes)
  assert.equal(validateRegistrySnapshot({ ...snapshot, workdirs: [] }).success, false)
  assert.equal(validateRegistrySnapshot({ ...snapshot, resources: [{ ...snapshot.resources[0], workdirId: 'mixed' }] }).success, false)
  assert.equal(validateNodeControlEnvelopeV1({ version: 1, messageId: 'old-live', type: 'resource-advertise', resource: snapshot.resources[0] }).success, false)
})
