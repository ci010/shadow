import { validateExecutionSupport, validateWorkdirAdvertisement, type WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type {
  ApprovedNodeV1,
  ExecutionSupport,
  DeviceCredentialId,
  DeviceId,
  NodeId,
  PairingOfferV1,
  PendingPairingId,
  PendingPairingV1,
  RegistrySnapshotV2,
  RevokedNodeV1,
  VersionHelloV1,
} from './contracts.ts'
import {
  isClusterIdentifier,
  validatePairingNodeStateV1,
  validateRegistrySnapshot,
  validateVersionHelloV1,
} from './contracts.ts'

export type RegistryErrorCode =
  | 'invalid-contract'
  | 'duplicate-identifier'
  | 'offer-not-found'
  | 'offer-expired'
  | 'offer-replayed'
  | 'pending-not-found'
  | 'fingerprint-mismatch'
  | 'identity-conflict'
  | 'node-not-approved'
  | 'credential-mismatch'
  | 'node-revoked'
  | 'protocol-major-mismatch'
  | 'capability-denied'

export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

export interface PairingPresentationV1 {
  offerId: string
  pendingId: PendingPairingId
  deviceId: DeviceId
  nodeId: NodeId
  deviceIdentityFingerprint: string
  devicePublicKey?: string
  credentialId?: DeviceCredentialId
  displayName: string
}

export interface ApprovalV1 {
  pendingId: PendingPairingId
  expectedDeviceIdentityFingerprint: string
  credentialId: DeviceCredentialId
}

export interface DeviceAuthenticationV1 {
  deviceId: DeviceId
  nodeId: NodeId
  credentialId: DeviceCredentialId
}

export interface NegotiatedVersionV1 {
  protocolMajor: 1
  protocolMinor: number
  features: string[]
}

function timestamp(value: Date): string {
  return value.toISOString()
}

function nodeKey(deviceId: DeviceId, nodeId: NodeId): string {
  return `${deviceId}\u0000${nodeId}`
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  return values.find((value) => seen.size === seen.add(value).size)
}

export class InMemoryPairingNodeRegistry {
  readonly #offers = new Map<string, PairingOfferV1>()
  readonly #consumedOffers = new Set<string>()
  readonly #pending = new Map<PendingPairingId, PendingPairingV1>()
  readonly #nodes = new Map<string, ApprovedNodeV1 | RevokedNodeV1>()
  readonly #nodeSupport = new Map<NodeId, ExecutionSupport>()

  readonly #workdirs = new Map<NodeId, Map<string, WorkdirAdvertisement>>()

  #identityExists(deviceId: DeviceId, nodeId: NodeId): boolean {
    return [...this.#pending.values()].some((record) =>
      record.deviceId === deviceId || record.nodeId === nodeId
    ) || [...this.#nodes.values()].some((record) =>
      record.deviceId === deviceId || record.nodeId === nodeId
    )
  }

  createOffer(
    offerId: string,
    createdAt: Date,
    expiresAt: Date,
  ): PairingOfferV1 {
    const offer: PairingOfferV1 = {
      version: 1,
      state: 'offer',
      offerId,
      createdAt: timestamp(createdAt),
      expiresAt: timestamp(expiresAt),
    }
    const validation = validatePairingNodeStateV1(offer)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    if (this.#offers.has(offerId) || this.#consumedOffers.has(offerId)) {
      throw new RegistryError(
        'duplicate-identifier',
        'pairing offer identifier already exists',
      )
    }
    this.#offers.set(offerId, offer)
    return structuredClone(offer)
  }

  invalidateOffer(offerId: string): boolean {
    if (this.#consumedOffers.has(offerId)) return false
    const invalidated = this.#offers.delete(offerId)
    if (invalidated) this.#consumedOffers.add(offerId)
    return invalidated
  }

  presentOffer(
    presentation: PairingPresentationV1,
    now: Date,
  ): PendingPairingV1 {
    if (this.#consumedOffers.has(presentation.offerId)) {
      throw new RegistryError(
        'offer-replayed',
        'pairing offer has already been consumed',
      )
    }
    const offer = this.#offers.get(presentation.offerId)
    if (!offer) {
      throw new RegistryError('offer-not-found', 'pairing offer was not found')
    }
    if (now.getTime() >= Date.parse(offer.expiresAt)) {
      this.#offers.delete(presentation.offerId)
      this.#consumedOffers.add(presentation.offerId)
      throw new RegistryError('offer-expired', 'pairing offer has expired')
    }
    const retry = this.#pending.get(presentation.pendingId)
    if (retry && retry.deviceId === presentation.deviceId && retry.nodeId === presentation.nodeId
      && retry.credentialId === presentation.credentialId && !!retry.devicePublicKey
      && retry.devicePublicKey === presentation.devicePublicKey
      && retry.deviceIdentityFingerprint === presentation.deviceIdentityFingerprint) {
      this.#offers.delete(presentation.offerId)
      this.#consumedOffers.add(presentation.offerId)
      return structuredClone(retry)
    }
    if (this.#pending.has(presentation.pendingId)) {
      throw new RegistryError(
        'duplicate-identifier',
        'pending pairing identifier already exists',
      )
    }
    // A fresh Main-issued invitation may request reauthorization of the exact
    // revoked identity. The tombstone remains authoritative until explicit approval.
    const revoked = this.#nodes.get(nodeKey(presentation.deviceId, presentation.nodeId))
    const reauthorization = revoked?.state === 'revoked'
      && revoked.credentialId === presentation.credentialId
      && revoked.deviceIdentityFingerprint === presentation.deviceIdentityFingerprint
      && revoked.devicePublicKey === presentation.devicePublicKey
      && !!revoked.devicePublicKey
    const otherConflict = [...this.#pending.values(), ...this.#nodes.values()].some(record =>
      (record.deviceId === presentation.deviceId || record.nodeId === presentation.nodeId)
      && record !== revoked)
    if (this.#identityExists(presentation.deviceId, presentation.nodeId) && (!reauthorization || otherConflict)) {
      throw new RegistryError(
        'identity-conflict',
        'device or node identity already exists',
      )
    }

    const pending: PendingPairingV1 = {
      version: 1,
      state: 'pending',
      ...presentation,
      requestedAt: timestamp(now),
    }
    const validation = validatePairingNodeStateV1(pending)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    this.#offers.delete(presentation.offerId)
    this.#consumedOffers.add(presentation.offerId)
    this.#pending.set(pending.pendingId, pending)
    return structuredClone(pending)
  }

  approve(approval: ApprovalV1, now: Date): ApprovedNodeV1 {
    const pending = this.#pending.get(approval.pendingId)
    if (!pending) {
      throw new RegistryError(
        'pending-not-found',
        'pending pairing was not found',
      )
    }
    if (
      pending.deviceIdentityFingerprint !==
        approval.expectedDeviceIdentityFingerprint
    ) {
      throw new RegistryError(
        'fingerprint-mismatch',
        'device identity fingerprint does not match',
      )
    }
    if (
      pending.credentialId !== undefined &&
      pending.credentialId !== approval.credentialId
    ) {
      throw new RegistryError(
        'credential-mismatch',
        'credential identifier does not match the pending pairing',
      )
    }
    if (!isClusterIdentifier(approval.credentialId)) {
      throw new RegistryError(
        'invalid-contract',
        'credentialId must be a valid identifier',
      )
    }
    if (
      [...this.#nodes.values()].some((record) =>
        record.credentialId === approval.credentialId && !(record.state === 'revoked'
          && record.deviceId === pending.deviceId && record.nodeId === pending.nodeId
          && record.deviceIdentityFingerprint === pending.deviceIdentityFingerprint
          && !!record.devicePublicKey && record.devicePublicKey === pending.devicePublicKey)
      )
    ) {
      throw new RegistryError(
        'identity-conflict',
        'credential identifier already exists',
      )
    }

    const approved: ApprovedNodeV1 = {
      version: 1,
      state: 'approved',
      deviceId: pending.deviceId,
      nodeId: pending.nodeId,
      deviceIdentityFingerprint: pending.deviceIdentityFingerprint,
      ...(pending.devicePublicKey
        ? { devicePublicKey: pending.devicePublicKey }
        : {}),
      credentialId: approval.credentialId,
      displayName: pending.displayName,
      approvedAt: timestamp(now),
    }
    const validation = validatePairingNodeStateV1(approved)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    this.#pending.delete(approval.pendingId)
    this.#nodes.set(nodeKey(approved.deviceId, approved.nodeId), approved)
    return structuredClone(approved)
  }

  revoke(
    auth: DeviceAuthenticationV1,
    reason: string,
    now: Date,
  ): RevokedNodeV1 {
    const approved = this.authenticate(auth)
    const revoked: RevokedNodeV1 = {
      ...approved,
      state: 'revoked',
      revokedAt: timestamp(now),
      reason,
    }
    const validation = validatePairingNodeStateV1(revoked)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    this.#nodes.set(nodeKey(revoked.deviceId, revoked.nodeId), revoked)
    this.#nodeSupport.delete(revoked.nodeId)
    this.#workdirs.delete(revoked.nodeId)
    return structuredClone(revoked)
  }

  authenticate(auth: DeviceAuthenticationV1): ApprovedNodeV1 {
    const record = this.#nodes.get(nodeKey(auth.deviceId, auth.nodeId))
    if (!record) {
      throw new RegistryError(
        'node-not-approved',
        'device and node are not approved',
      )
    }
    if (record.state === 'revoked') {
      throw new RegistryError('node-revoked', 'device is revoked')
    }
    if (record.credentialId !== auth.credentialId) {
      throw new RegistryError(
        'credential-mismatch',
        'credential identifier does not match',
      )
    }
    return structuredClone(record)
  }

  reconnect(
    auth: DeviceAuthenticationV1,
    localHello: VersionHelloV1,
    remoteHello: unknown,
  ): NegotiatedVersionV1 {
    this.authenticate(auth)
    return negotiateVersion(localHello, remoteHello)
  }

  advertiseNodeSupport(auth: DeviceAuthenticationV1, nodeId: string, value: unknown): ExecutionSupport {
    this.authenticate(auth)
    if (nodeId !== auth.nodeId) throw new RegistryError('capability-denied', 'Support node does not match authenticated node')
    const parsed = validateExecutionSupport(value, 'node')
    if (!parsed.success) throw new RegistryError('invalid-contract', parsed.errors.join('; '))
    this.#nodeSupport.set(nodeId, parsed.value)
    return structuredClone(parsed.value)
  }

  advertiseWorkdir(auth: DeviceAuthenticationV1, value: unknown): WorkdirAdvertisement {
    this.authenticate(auth)
    const parsed = validateWorkdirAdvertisement(value)
    if (!parsed.success) throw new RegistryError('invalid-contract', parsed.errors.join('; '))
    if (parsed.value.nodeId !== auth.nodeId) throw new RegistryError('capability-denied', 'Workdir node does not match authenticated node')
    const workdirs = this.#workdirs.get(auth.nodeId) ?? new Map()
    workdirs.set(parsed.value.workdirId, structuredClone(parsed.value))
    this.#workdirs.set(auth.nodeId, workdirs)
    return structuredClone(parsed.value)
  }

  withdrawWorkdir(auth: DeviceAuthenticationV1, nodeId: string, workdirId: string): boolean {
    this.authenticate(auth)
    if (auth.nodeId !== nodeId || !isClusterIdentifier(workdirId)) throw new RegistryError('capability-denied', 'Invalid workdir withdrawal')
    return this.#workdirs.get(nodeId)?.delete(workdirId) ?? false
  }

  listWorkdirs(nodeId: NodeId): WorkdirAdvertisement[] {
    return [...(this.#workdirs.get(nodeId)?.values() ?? [])].map(value => structuredClone(value))
  }

  nodeSupport(nodeId: NodeId): ExecutionSupport {
    return structuredClone(this.#nodeSupport.get(nodeId) ?? { operations: [] })
  }

  getPending(): PendingPairingV1[] {
    return [...this.#pending.values()].map((value) => structuredClone(value))
  }

  getApprovedNodes(): ApprovedNodeV1[] {
    return [...this.#nodes.values()]
      .filter((value): value is ApprovedNodeV1 => value.state === 'approved')
      .map((value) => structuredClone(value))
  }

  listNodes(): (ApprovedNodeV1 | RevokedNodeV1)[] {
    return [...this.#nodes.values()].map((value) => structuredClone(value))
  }

  getNodeState(nodeId: NodeId): 'approved' | 'revoked' | 'missing' {
    let revoked = false
    for (const node of this.#nodes.values()) {
      if (node.nodeId !== nodeId) continue
      if (node.state === 'approved') return 'approved'
      revoked = true
    }
    return revoked ? 'revoked' : 'missing'
  }

  exportSnapshot(now: Date): RegistrySnapshotV2 {
    return {
      version: 2,
      workdirs: [...this.#workdirs.values()].flatMap(workdirs => [...workdirs.values()].map(value => structuredClone(value))),
      createdAt: timestamp(now),
      offers: [...this.#offers.values()].map((value) => structuredClone(value)),
      consumedOfferIds: [...this.#consumedOffers],
      pending: [...this.#pending.values()].map((value) =>
        structuredClone(value)
      ),
      nodes: [...this.#nodes.values()].map((value) => structuredClone(value)),
      nodeSupport: [...this.#nodeSupport].map(([nodeId, support]) => ({ nodeId, support: structuredClone(support) })),
    }
  }

  restoreSnapshot(value: unknown, now: Date): void {
    const validation = validateRegistrySnapshot(value)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    const snapshot = validation.value
    const offers = new Map<string, PairingOfferV1>()
    const consumedOffers = new Set(snapshot.consumedOfferIds)
    const pending = new Map<PendingPairingId, PendingPairingV1>()
    const nodes = new Map<string, ApprovedNodeV1 | RevokedNodeV1>()
    const nodeSupport = new Map<NodeId, ExecutionSupport>()
    const workdirs = new Map<NodeId, Map<string, WorkdirAdvertisement>>()

    const duplicateOfferId = duplicate(
      snapshot.offers.map((offer) => offer.offerId),
    )
    const duplicatePendingId = duplicate(
      snapshot.pending.map((record) => record.pendingId),
    )
    const identityNodes = snapshot.nodes.filter(record => !(record.state === 'revoked' && !!record.devicePublicKey
      && snapshot.pending.some(pending => pending.deviceId === record.deviceId && pending.nodeId === record.nodeId
        && pending.credentialId === record.credentialId && pending.devicePublicKey === record.devicePublicKey
        && pending.deviceIdentityFingerprint === record.deviceIdentityFingerprint)))
    const duplicateDeviceId = duplicate([
      ...snapshot.pending.map((record) => record.deviceId),
      ...identityNodes.map((record) => record.deviceId),
    ])
    const duplicateNodeId = duplicate([
      ...snapshot.pending.map((record) => record.nodeId),
      ...identityNodes.map((record) => record.nodeId),
    ])
    const duplicateCredentialId = duplicate(
      snapshot.nodes.map((record) => record.credentialId),
    )
    if (
      duplicateOfferId || duplicatePendingId || duplicateDeviceId ||
      duplicateNodeId ||
      duplicateCredentialId
    ) {
      throw new RegistryError(
        'invalid-contract',
        'registry snapshot contains duplicate identifiers',
      )
    }

    for (const offer of snapshot.offers) {
      if (consumedOffers.has(offer.offerId)) {
        throw new RegistryError(
          'invalid-contract',
          'active and consumed pairing offers overlap',
        )
      }
      if (now.getTime() >= Date.parse(offer.expiresAt)) {
        consumedOffers.add(offer.offerId)
      } else {
        offers.set(offer.offerId, structuredClone(offer))
      }
    }
    for (const record of snapshot.pending) {
      if (!consumedOffers.has(record.offerId)) {
        throw new RegistryError(
          'invalid-contract',
          'pending pairing offer is not consumed',
        )
      }
      pending.set(record.pendingId, structuredClone(record))
    }
    for (const record of snapshot.nodes) {
      nodes.set(
        nodeKey(record.deviceId, record.nodeId),
        structuredClone(record),
      )
    }
    const nodesById = new Map(
      snapshot.nodes.map((record) => [record.nodeId, record]),
    )
    for (const workdir of snapshot.workdirs) {
      const node = nodesById.get(workdir.nodeId)
      if (!node) throw new RegistryError('invalid-contract', 'Workdir references unknown node')
      if (node.state === 'revoked') continue
      const entries = workdirs.get(workdir.nodeId) ?? new Map()
      if (entries.has(workdir.workdirId)) throw new RegistryError('invalid-contract', 'Duplicate workdir identity')
      entries.set(workdir.workdirId, structuredClone(workdir))
      workdirs.set(workdir.nodeId, entries)
    }
    for (const entry of snapshot.nodeSupport) {
      const node = nodesById.get(entry.nodeId)
      if (!node || nodeSupport.has(entry.nodeId)) throw new RegistryError('invalid-contract', 'Invalid/duplicate node support')
      if (node.state !== 'revoked') nodeSupport.set(entry.nodeId, structuredClone(entry.support))
    }

    this.#offers.clear()
    this.#consumedOffers.clear()
    this.#pending.clear()
    this.#nodes.clear()
    this.#nodeSupport.clear()
    this.#workdirs.clear()
    for (const [key, entries] of workdirs) this.#workdirs.set(key, entries)
    for (const [key, offer] of offers) this.#offers.set(key, offer)
    for (const offerId of consumedOffers) this.#consumedOffers.add(offerId)
    for (const [key, record] of pending) this.#pending.set(key, record)
    for (const [key, record] of nodes) this.#nodes.set(key, record)
    for (const [key, support] of nodeSupport) this.#nodeSupport.set(key, support)
  }
}

export function negotiateVersion(
  localHello: VersionHelloV1,
  remoteHello: unknown,
): NegotiatedVersionV1 {
  if (
    typeof remoteHello === 'object' && remoteHello !== null &&
    'protocolMajor' in remoteHello &&
    remoteHello.protocolMajor !== localHello.protocolMajor
  ) {
    throw new RegistryError(
      'protocol-major-mismatch',
      'protocol major versions do not match',
    )
  }
  const localValidation = validateVersionHelloV1(localHello)
  const remoteValidation = validateVersionHelloV1(remoteHello)
  if (!localValidation.success || !remoteValidation.success) {
    const errors = [
      ...(localValidation.success ? [] : localValidation.errors),
      ...(remoteValidation.success ? [] : remoteValidation.errors),
    ]
    throw new RegistryError('invalid-contract', errors.join('; '))
  }
  const remoteFeatures = new Set(remoteValidation.value.features)
  return {
    protocolMajor: 1,
    protocolMinor: Math.min(
      localValidation.value.protocolMinor,
      remoteValidation.value.protocolMinor,
    ),
    features: localValidation.value.features.filter((feature) =>
      remoteFeatures.has(feature)
    ),
  }
}
