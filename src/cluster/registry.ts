import type {
  ApprovedNodeV1,
  CapabilityDescriptorV1,
  DeviceCredentialId,
  DeviceId,
  NodeId,
  PairingOfferV1,
  PendingPairingId,
  PendingPairingV1,
  RegistrySnapshotV1,
  RevokedNodeV1,
  VersionHelloV1,
} from './contracts.ts'
import {
  isClusterIdentifier,
  validateCapabilityDescriptorV1,
  validatePairingNodeStateV1,
  validateRegistrySnapshotV1,
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
  readonly #capabilities = new Map<
    NodeId,
    Map<string, CapabilityDescriptorV1>
  >()

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
    if (this.#pending.has(presentation.pendingId)) {
      throw new RegistryError(
        'duplicate-identifier',
        'pending pairing identifier already exists',
      )
    }
    if (this.#identityExists(presentation.deviceId, presentation.nodeId)) {
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
        record.credentialId === approval.credentialId
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
    this.#capabilities.delete(revoked.nodeId)
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

  advertiseCapability(
    auth: DeviceAuthenticationV1,
    value: unknown,
  ): CapabilityDescriptorV1 {
    this.authenticate(auth)
    const validation = validateCapabilityDescriptorV1(value)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    if (validation.value.nodeId !== auth.nodeId) {
      throw new RegistryError(
        'capability-denied',
        'capability nodeId does not match authenticated node',
      )
    }
    const nodeCapabilities = this.#capabilities.get(auth.nodeId) ?? new Map()
    nodeCapabilities.set(
      validation.value.capabilityId,
      structuredClone(validation.value),
    )
    this.#capabilities.set(auth.nodeId, nodeCapabilities)
    return structuredClone(validation.value)
  }

  withdrawCapability(
    auth: DeviceAuthenticationV1,
    nodeId: NodeId,
    capabilityId: string,
  ): boolean {
    this.authenticate(auth)
    if (nodeId !== auth.nodeId) {
      throw new RegistryError(
        'capability-denied',
        'capability nodeId does not match authenticated node',
      )
    }
    if (!isClusterIdentifier(capabilityId)) {
      throw new RegistryError(
        'invalid-contract',
        'capabilityId must be a valid identifier',
      )
    }
    const nodeCapabilities = this.#capabilities.get(nodeId)
    const withdrawn = nodeCapabilities?.delete(capabilityId) ?? false
    if (nodeCapabilities?.size === 0) this.#capabilities.delete(nodeId)
    return withdrawn
  }

  listCapabilities(nodeId: NodeId): CapabilityDescriptorV1[] {
    return [...(this.#capabilities.get(nodeId)?.values() ?? [])].map((value) =>
      structuredClone(value)
    )
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

  exportSnapshot(now: Date): RegistrySnapshotV1 {
    return {
      version: 1,
      createdAt: timestamp(now),
      offers: [...this.#offers.values()].map((value) => structuredClone(value)),
      consumedOfferIds: [...this.#consumedOffers],
      pending: [...this.#pending.values()].map((value) =>
        structuredClone(value)
      ),
      nodes: [...this.#nodes.values()].map((value) => structuredClone(value)),
      capabilities: [...this.#capabilities.values()].flatMap((
        nodeCapabilities,
      ) =>
        [...nodeCapabilities.values()].map((value) => structuredClone(value))
      ),
    }
  }

  restoreSnapshot(value: unknown, now: Date): void {
    const validation = validateRegistrySnapshotV1(value)
    if (!validation.success) {
      throw new RegistryError('invalid-contract', validation.errors.join('; '))
    }
    const snapshot = validation.value
    const offers = new Map<string, PairingOfferV1>()
    const consumedOffers = new Set(snapshot.consumedOfferIds)
    const pending = new Map<PendingPairingId, PendingPairingV1>()
    const nodes = new Map<string, ApprovedNodeV1 | RevokedNodeV1>()
    const capabilities = new Map<NodeId, Map<string, CapabilityDescriptorV1>>()

    const duplicateOfferId = duplicate(
      snapshot.offers.map((offer) => offer.offerId),
    )
    const duplicatePendingId = duplicate(
      snapshot.pending.map((record) => record.pendingId),
    )
    const duplicateDeviceId = duplicate([
      ...snapshot.pending.map((record) => record.deviceId),
      ...snapshot.nodes.map((record) => record.deviceId),
    ])
    const duplicateNodeId = duplicate([
      ...snapshot.pending.map((record) => record.nodeId),
      ...snapshot.nodes.map((record) => record.nodeId),
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
    for (const capability of snapshot.capabilities) {
      const node = nodesById.get(capability.nodeId)
      if (!node) {
        throw new RegistryError(
          'invalid-contract',
          'capability references an unknown node',
        )
      }
      if (node.state === 'revoked') continue
      const nodeCapabilities = capabilities.get(capability.nodeId) ?? new Map()
      if (nodeCapabilities.has(capability.capabilityId)) {
        throw new RegistryError(
          'invalid-contract',
          'registry snapshot contains duplicate capabilities',
        )
      }
      nodeCapabilities.set(capability.capabilityId, structuredClone(capability))
      capabilities.set(capability.nodeId, nodeCapabilities)
    }

    this.#offers.clear()
    this.#consumedOffers.clear()
    this.#pending.clear()
    this.#nodes.clear()
    this.#capabilities.clear()
    for (const [key, offer] of offers) this.#offers.set(key, offer)
    for (const offerId of consumedOffers) this.#consumedOffers.add(offerId)
    for (const [key, record] of pending) this.#pending.set(key, record)
    for (const [key, record] of nodes) this.#nodes.set(key, record)
    for (const [key, nodeCapabilities] of capabilities) {
      this.#capabilities.set(key, nodeCapabilities)
    }
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
