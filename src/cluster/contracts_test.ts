import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobEventV1, JobRequestV1 } from '../execution/contracts.ts'
import {
  isClusterIdentifier,
  validateCapabilityDescriptorV1,
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
    features: ['jobs-v1'],
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
  assert.equal(validatePairingNodeStateV1({ ...pending, version: 2 }).success, false)
  assert.equal(validatePairingNodeStateV1({ ...pending, rawSecret: 'must-not-appear' }).success, false)

  const capability = {
    version: 1,
    capabilityId: 'capability-1',
    nodeId: 'node-1',
    kind: 'shell',
    displayName: 'Project shell',
    permissions: ['process.execute'],
    approvalPolicy: 'session',
    online: true,
  }
  assert(validateCapabilityDescriptorV1(capability).success)
  assert.equal(validateCapabilityDescriptorV1({ ...capability, kind: 'root-access' }).success, false)
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

test('node-control envelopes carry runtime-validated S2 jobs and events', () => {
  const request: JobRequestV1 = {
    version: 1,
    jobId: 'job-1',
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'node-1',
    capabilityId: 'capability-1',
    operation: 'process.execute',
    args: { command: 'node --test' },
    createdAt: '2026-08-26T00:00:00.000Z',
    deadlineAt: '2026-08-26T00:01:00.000Z',
    approval: 'none',
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
    request: { ...request, version: 2 },
  }).success, false)
})