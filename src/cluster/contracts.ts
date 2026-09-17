import type {
  JobEventV1,
  JobRequestV1,
  ValidationResult,
} from '../execution/contracts.ts'
import {
  validateJobEventV1,
  validateJobRequestV1,
} from '../execution/contracts.ts'

export type NodeId = string
export type DeviceId = string
export type DeviceCredentialId = string
export type PairingOfferId = string
export type PendingPairingId = string
export type CapabilityId = string

export interface VersionHelloV1 {
  protocolMajor: 1
  protocolMinor: number
  implementationVersion: string
  features: string[]
}

export interface PairingOfferV1 {
  version: 1
  state: 'offer'
  offerId: PairingOfferId
  createdAt: string
  expiresAt: string
}

export interface PendingPairingV1 {
  version: 1
  state: 'pending'
  pendingId: PendingPairingId
  offerId: PairingOfferId
  deviceId: DeviceId
  nodeId: NodeId
  deviceIdentityFingerprint: string
  devicePublicKey?: string
  credentialId?: DeviceCredentialId
  displayName: string
  requestedAt: string
}

export interface ApprovedNodeV1 {
  version: 1
  state: 'approved'
  deviceId: DeviceId
  nodeId: NodeId
  deviceIdentityFingerprint: string
  devicePublicKey?: string
  credentialId: DeviceCredentialId
  displayName: string
  approvedAt: string
}

export interface RevokedNodeV1 {
  version: 1
  state: 'revoked'
  deviceId: DeviceId
  nodeId: NodeId
  deviceIdentityFingerprint: string
  devicePublicKey?: string
  credentialId: DeviceCredentialId
  displayName: string
  approvedAt: string
  revokedAt: string
  reason: string
}

export type PairingNodeStateV1 =
  | PairingOfferV1
  | PendingPairingV1
  | ApprovedNodeV1
  | RevokedNodeV1

export interface RegistrySnapshotV1 {
  version: 1
  createdAt: string
  offers: PairingOfferV1[]
  consumedOfferIds: PairingOfferId[]
  pending: PendingPairingV1[]
  nodes: (ApprovedNodeV1 | RevokedNodeV1)[]
  capabilities: CapabilityDescriptorV1[]
}

export interface CapabilityDescriptorV1 {
  version: 1
  capabilityId: CapabilityId
  nodeId: NodeId
  kind: 'workdir' | 'shell' | 'browser' | 'windows-ui' | 'gpu'
  displayName: string
  /** Child-supplied display metadata only; never an execution path on Main. */
  displayPath?: string
  permissions: string[]
  online: boolean
}

export type NodeControlEnvelopeV1 =
  | {
    version: 1
    messageId: string
    type: 'hello'
    hello: VersionHelloV1
  }
  | {
    version: 1
    messageId: string
    type: 'capability-advertise'
    capability: CapabilityDescriptorV1
  }
  | {
    version: 1
    messageId: string
    type: 'capability-withdraw'
    nodeId: NodeId
    capabilityId: CapabilityId
  }
  | {
    version: 1
    messageId: string
    type: 'job-request'
    request: JobRequestV1
  }
  | {
    version: 1
    messageId: string
    type: 'job-event'
    event: JobEventV1
  }

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: string[],
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`unknown field: ${key}`)
  }
}

function result<T>(errors: string[], value: T): ValidationResult<T> {
  return errors.length === 0
    ? { success: true, value }
    : { success: false, errors }
}

function requireIdentifier(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (!isClusterIdentifier(value[key])) errors.push(`${key} must be a valid identifier`)
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    errors.push(`${key} must be a non-empty string`)
  }
}

function requireDisplayText(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  errors: string[],
): void {
  const text = value[key]
  if (typeof text !== 'string' || !text.trim() || text.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text)) {
    errors.push(`${key} must be single-line display text of at most ${maxLength} characters`)
  }
}

function requireTimestamp(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  requireString(value, key, errors)
  if (typeof value[key] === 'string' && Number.isNaN(Date.parse(value[key]))) {
    errors.push(`${key} must be an ISO timestamp`)
  }
}

function requireUniqueStringArray(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const entries = value[key]
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(entries).size !== entries.length
  ) {
    errors.push(`${key} must be an array of unique non-empty strings`)
    return
  }
}

export function isClusterIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function validateVersionHelloV1(value: unknown): ValidationResult<VersionHelloV1> {
  if (!isRecord(value)) return { success: false, errors: ['hello must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(
    value,
    ['protocolMajor', 'protocolMinor', 'implementationVersion', 'features'],
    errors,
  )
  if (value.protocolMajor !== 1) errors.push('protocolMajor must be 1')
  if (!Number.isSafeInteger(value.protocolMinor) || Number(value.protocolMinor) < 0) {
    errors.push('protocolMinor must be a non-negative safe integer')
  }
  if (typeof value.implementationVersion !== 'string' || value.implementationVersion.length === 0) {
    errors.push('implementationVersion must be a non-empty string')
  }
  if (
    !Array.isArray(value.features) ||
    value.features.some((feature) => typeof feature !== 'string' || feature.length === 0) ||
    new Set(value.features).size !== value.features.length
  ) {
    errors.push('features must be an array of unique non-empty strings')
  }
  return result(errors, value as unknown as VersionHelloV1)
}

export function validatePairingNodeStateV1(
  value: unknown,
): ValidationResult<PairingNodeStateV1> {
  if (!isRecord(value)) return { success: false, errors: ['pairing state must be an object'] }
  const errors: string[] = []
  if (value.version !== 1) errors.push('version must be 1')

  if (value.state === 'offer') {
    hasOnlyKeys(value, ['version', 'state', 'offerId', 'createdAt', 'expiresAt'], errors)
    requireIdentifier(value, 'offerId', errors)
    requireTimestamp(value, 'createdAt', errors)
    requireTimestamp(value, 'expiresAt', errors)
    if (
      typeof value.createdAt === 'string' && typeof value.expiresAt === 'string' &&
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    ) errors.push('expiresAt must be after createdAt')
  } else if (value.state === 'pending') {
    hasOnlyKeys(value, [
      'version',
      'state',
      'pendingId',
      'offerId',
      'deviceId',
      'nodeId',
      'deviceIdentityFingerprint',
      'devicePublicKey',
      'credentialId',
      'displayName',
      'requestedAt',
    ], errors)
    for (const key of ['pendingId', 'offerId', 'deviceId', 'nodeId']) {
      requireIdentifier(value, key, errors)
    }
    requireString(value, 'deviceIdentityFingerprint', errors)
    requireOptionalEd25519PublicKey(value, errors)
    if (value.credentialId !== undefined) {
      requireIdentifier(value, 'credentialId', errors)
    }
    requireDisplayText(value, 'displayName', 256, errors)
    requireTimestamp(value, 'requestedAt', errors)
  } else if (value.state === 'approved' || value.state === 'revoked') {
    hasOnlyKeys(value, [
      'version',
      'state',
      'deviceId',
      'nodeId',
      'deviceIdentityFingerprint',
      'devicePublicKey',
      'credentialId',
      'displayName',
      'approvedAt',
      ...(value.state === 'revoked' ? ['revokedAt', 'reason'] : []),
    ], errors)
    for (const key of ['deviceId', 'nodeId', 'credentialId']) {
      requireIdentifier(value, key, errors)
    }
    requireString(value, 'deviceIdentityFingerprint', errors)
    requireOptionalEd25519PublicKey(value, errors)
    requireDisplayText(value, 'displayName', 256, errors)
    requireTimestamp(value, 'approvedAt', errors)
    if (value.state === 'revoked') {
      requireTimestamp(value, 'revokedAt', errors)
      requireString(value, 'reason', errors)
    }
  } else {
    errors.push('state is unsupported')
  }

  return result(errors, value as unknown as PairingNodeStateV1)
}

function requireOptionalEd25519PublicKey(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (
    value.devicePublicKey !== undefined &&
    (
      typeof value.devicePublicKey !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.devicePublicKey)
    )
  ) {
    errors.push('devicePublicKey must be an unpadded 32-byte base64url Ed25519 key')
  }
}

export function validateCapabilityDescriptorV1(
  value: unknown,
): ValidationResult<CapabilityDescriptorV1> {
  if (!isRecord(value)) return { success: false, errors: ['capability must be an object'] }
  const errors: string[] = []
  hasOnlyKeys(value, [
    'version',
    'capabilityId',
    'nodeId',
    'kind',
    'displayName',
    'displayPath',
    'permissions',
    'online',
  ], errors)
  if (value.version !== 1) errors.push('version must be 1')
  requireIdentifier(value, 'capabilityId', errors)
  requireIdentifier(value, 'nodeId', errors)
  if (!['workdir', 'shell', 'browser', 'windows-ui', 'gpu'].includes(String(value.kind))) {
    errors.push('kind is unsupported')
  }
  requireDisplayText(value, 'displayName', 256, errors)
  if (value.displayPath !== undefined) {
    if (value.kind !== 'workdir') errors.push('displayPath is only supported for workdir capabilities')
    requireDisplayText(value, 'displayPath', 4096, errors)
  }
  requireUniqueStringArray(value, 'permissions', errors)
  if (typeof value.online !== 'boolean') errors.push('online must be boolean')
  return result(errors, value as unknown as CapabilityDescriptorV1)
}

export function validateRegistrySnapshotV1(
  input: unknown,
): ValidationResult<RegistrySnapshotV1> {
  if (!isRecord(input)) return { success: false, errors: ['registry snapshot must be an object'] }
  const value = { ...input }
  if (Array.isArray(value.nodes)) {
    value.nodes = value.nodes.map((entry) => {
      if (!isRecord(entry) || (entry.state !== 'approved' && entry.state !== 'revoked')) return entry
      const node = { ...entry }
      delete node.uiScopes
      delete node.nodePrivileges
      return node
    })
  }
  // Retire saved policy metadata without changing device identity or operation bindings.
  if (Array.isArray(value.capabilities)) {
    value.capabilities = value.capabilities.map((entry) => {
      if (!isRecord(entry) || !Object.hasOwn(entry, 'approvalPolicy')) return entry
      const { approvalPolicy, ...capability } = entry
      return typeof approvalPolicy === 'string' &&
          ['none', 'always', 'session', 'grant'].includes(approvalPolicy)
        ? capability
        : entry
    })
  }
  const errors: string[] = []
  hasOnlyKeys(value, [
    'version',
    'createdAt',
    'offers',
    'consumedOfferIds',
    'pending',
    'nodes',
    'capabilities',
  ], errors)
  if (value.version !== 1) errors.push('version must be 1')
  requireTimestamp(value, 'createdAt', errors)

  const validateArray = (
    key: string,
    validate: (entry: unknown) => ValidationResult<unknown>,
  ): void => {
    const entries = value[key]
    if (!Array.isArray(entries)) {
      errors.push(`${key} must be an array`)
      return
    }
    entries.forEach((entry, index) => {
      const validation = validate(entry)
      if (!validation.success) {
        errors.push(...validation.errors.map((error) => `${key}[${index}].${error}`))
      }
    })
  }

  validateArray('offers', (entry) => {
    const validation = validatePairingNodeStateV1(entry)
    return validation.success && validation.value.state !== 'offer'
      ? { success: false, errors: ['state must be offer'] }
      : validation
  })
  requireUniqueStringArray(value, 'consumedOfferIds', errors)
  if (
    Array.isArray(value.consumedOfferIds) &&
    value.consumedOfferIds.some((offerId) => !isClusterIdentifier(offerId))
  ) errors.push('consumedOfferIds contains an invalid identifier')
  validateArray('pending', (entry) => {
    const validation = validatePairingNodeStateV1(entry)
    return validation.success && validation.value.state !== 'pending'
      ? { success: false, errors: ['state must be pending'] }
      : validation
  })
  validateArray('nodes', (entry) => {
    const validation = validatePairingNodeStateV1(entry)
    return validation.success &&
        validation.value.state !== 'approved' && validation.value.state !== 'revoked'
      ? { success: false, errors: ['state must be approved or revoked'] }
      : validation
  })
  validateArray('capabilities', validateCapabilityDescriptorV1)
  return result(errors, value as unknown as RegistrySnapshotV1)
}

export function validateNodeControlEnvelopeV1(
  value: unknown,
): ValidationResult<NodeControlEnvelopeV1> {
  if (!isRecord(value)) return { success: false, errors: ['envelope must be an object'] }
  const errors: string[] = []
  if (value.version !== 1) errors.push('version must be 1')
  requireIdentifier(value, 'messageId', errors)

  if (value.type === 'hello') {
    hasOnlyKeys(value, ['version', 'messageId', 'type', 'hello'], errors)
    const nested = validateVersionHelloV1(value.hello)
    if (!nested.success) errors.push(...nested.errors.map((error) => `hello.${error}`))
  } else if (value.type === 'capability-advertise') {
    hasOnlyKeys(value, ['version', 'messageId', 'type', 'capability'], errors)
    const nested = validateCapabilityDescriptorV1(value.capability)
    if (!nested.success) errors.push(...nested.errors.map((error) => `capability.${error}`))
  } else if (value.type === 'capability-withdraw') {
    hasOnlyKeys(value, ['version', 'messageId', 'type', 'nodeId', 'capabilityId'], errors)
    requireIdentifier(value, 'nodeId', errors)
    requireIdentifier(value, 'capabilityId', errors)
  } else if (value.type === 'job-request') {
    hasOnlyKeys(value, ['version', 'messageId', 'type', 'request'], errors)
    const nested = validateJobRequestV1(value.request)
    if (!nested.success) errors.push(...nested.errors.map((error) => `request.${error}`))
  } else if (value.type === 'job-event') {
    hasOnlyKeys(value, ['version', 'messageId', 'type', 'event'], errors)
    const nested = validateJobEventV1(value.event)
    if (!nested.success) errors.push(...nested.errors.map((error) => `event.${error}`))
  } else {
    errors.push('type is unsupported')
  }

  return result(errors, value as unknown as NodeControlEnvelopeV1)
}