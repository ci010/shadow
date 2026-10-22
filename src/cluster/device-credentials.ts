import type { ValidationResult } from '../execution/contracts.ts'
import type { DeviceCredentialId, DeviceId, NodeId } from './contracts.ts'
import { isClusterIdentifier } from './contracts.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'

export interface DeviceCredentialReferenceV1 {
  readonly version: 1
  readonly kind: 'protected-device-credential'
  readonly providerId: string
  readonly keyId: string
  readonly deviceId: DeviceId
  readonly nodeId: NodeId
  readonly credentialId: DeviceCredentialId
  readonly deviceIdentityFingerprint: string
}

export interface DeviceCredentialConnectContext {
  readonly endpoint: string
  readonly localNodeId: NodeId
  readonly signal: AbortSignal
}

export type DeviceCredentialSigner = (
  input: Uint8Array,
) => Uint8Array | Promise<Uint8Array>

export class DeviceCredentialProof {
  readonly #signer: DeviceCredentialSigner

  constructor(signer: DeviceCredentialSigner) {
    this.#signer = signer
    Object.freeze(this)
  }

  async sign(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.#signer(new Uint8Array(input)))
  }

  toJSON(): never {
    throw new TypeError('Device credential proof material cannot be serialized')
  }

  toString(): string {
    return '[DeviceCredentialProof redacted]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }
}

export interface ResolvedDeviceCredential {
  readonly authentication: DeviceAuthenticationV1
  readonly deviceIdentityFingerprint: string
  readonly proof: DeviceCredentialProof
}

export interface DeviceCredentialProvider {
  resolve(
    reference: DeviceCredentialReferenceV1,
    context: DeviceCredentialConnectContext,
  ): Promise<ResolvedDeviceCredential>
}

export interface ProtectedDeviceKeyStore {
  readonly providerId: string
  load(keyId: string, signal: AbortSignal): Promise<Uint8Array | null>
  save(keyId: string, value: Uint8Array, signal: AbortSignal): Promise<void>
}

export interface DevicePublicIdentity {
  readonly providerId: string
  readonly keyId: string
  readonly devicePublicKey: string
  readonly deviceIdentityFingerprint: string
}

interface StoredEd25519KeyV1 {
  readonly version: 1
  readonly algorithm: 'Ed25519'
  readonly privateKey: JsonWebKey
}

export class DeviceCredentialCorrelationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceCredentialCorrelationError'
  }
}

export class ProtectedEd25519DeviceCredentialProvider
  implements DeviceCredentialProvider {
  constructor(readonly store: ProtectedDeviceKeyStore) {}

  async loadOrCreateKey(
    keyId: string,
    signal: AbortSignal,
  ): Promise<DevicePublicIdentity> {
    if (!isClusterIdentifier(keyId)) {
      throw new TypeError('keyId must be a valid identifier')
    }
    signal.throwIfAborted()
    let stored = await this.store.load(keyId, signal)
    if (stored === null) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      ) as CryptoKeyPair
      const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
      stored = new TextEncoder().encode(JSON.stringify({
        version: 1,
        algorithm: 'Ed25519',
        privateKey,
      } satisfies StoredEd25519KeyV1))
      await this.store.save(keyId, stored, signal)
    }
    signal.throwIfAborted()
    const material = parseStoredEd25519Key(stored)
    return await publicIdentity(this.store.providerId, keyId, material)
  }

  async resolve(
    reference: DeviceCredentialReferenceV1,
    context: DeviceCredentialConnectContext,
  ): Promise<ResolvedDeviceCredential> {
    if (reference.providerId !== this.store.providerId) {
      throw new DeviceCredentialCorrelationError(
        'Credential reference providerId does not match the key store',
      )
    }
    context.signal.throwIfAborted()
    const stored = await this.store.load(reference.keyId, context.signal)
    if (stored === null) {
      throw new DeviceCredentialCorrelationError(
        'Protected device credential was not found',
      )
    }
    const material = parseStoredEd25519Key(stored)
    const identity = await publicIdentity(
      this.store.providerId,
      reference.keyId,
      material,
    )
    if (
      identity.deviceIdentityFingerprint !==
        reference.deviceIdentityFingerprint
    ) {
      throw new DeviceCredentialCorrelationError(
        'Protected device credential fingerprint does not match its reference',
      )
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      material.privateKey,
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    context.signal.throwIfAborted()
    return {
      authentication: {
        deviceId: reference.deviceId,
        nodeId: reference.nodeId,
        credentialId: reference.credentialId,
      },
      deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
      proof: new DeviceCredentialProof(async (input) =>
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            privateKey,
            ownedArrayBuffer(input),
          ),
        )
      ),
    }
  }
}

const REFERENCE_KEYS = new Set([
  'version',
  'kind',
  'providerId',
  'keyId',
  'deviceId',
  'nodeId',
  'credentialId',
  'deviceIdentityFingerprint',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateDeviceCredentialReferenceV1(
  value: unknown,
): ValidationResult<DeviceCredentialReferenceV1> {
  if (!isRecord(value)) {
    return {
      success: false,
      errors: ['device credential reference must be an object'],
    }
  }

  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!REFERENCE_KEYS.has(key)) errors.push(`unknown field: ${key}`)
  }
  if (value.version !== 1) errors.push('version must be 1')
  if (value.kind !== 'protected-device-credential') {
    errors.push('kind must be protected-device-credential')
  }
  for (
    const key of ['providerId', 'keyId', 'deviceId', 'nodeId', 'credentialId']
  ) {
    if (!isClusterIdentifier(value[key])) {
      errors.push(`${key} must be a valid identifier`)
    }
  }
  if (
    typeof value.deviceIdentityFingerprint !== 'string' ||
    value.deviceIdentityFingerprint.length === 0
  ) {
    errors.push('deviceIdentityFingerprint must be a non-empty string')
  }

  return errors.length === 0
    ? { success: true, value: value as unknown as DeviceCredentialReferenceV1 }
    : { success: false, errors }
}

export function assertDeviceCredentialCorrelation(
  reference: DeviceCredentialReferenceV1,
  resolved: ResolvedDeviceCredential,
  localNodeId: NodeId,
): void {
  const expected = {
    deviceId: reference.deviceId,
    nodeId: reference.nodeId,
    credentialId: reference.credentialId,
  }
  if (reference.nodeId !== localNodeId) {
    throw new DeviceCredentialCorrelationError(
      'Credential reference nodeId does not match the local nodeId',
    )
  }
  for (const key of ['deviceId', 'nodeId', 'credentialId'] as const) {
    if (resolved.authentication[key] !== expected[key]) {
      throw new DeviceCredentialCorrelationError(
        `Resolved credential ${key} does not match its reference`,
      )
    }
  }
  if (
    resolved.deviceIdentityFingerprint !==
      reference.deviceIdentityFingerprint
  ) {
    throw new DeviceCredentialCorrelationError(
      'Resolved credential fingerprint does not match its reference',
    )
  }
}

export async function resolveDeviceCredentialForConnect(
  provider: DeviceCredentialProvider,
  referenceValue: unknown,
  context: DeviceCredentialConnectContext,
): Promise<ResolvedDeviceCredential> {
  const validation = validateDeviceCredentialReferenceV1(referenceValue)
  if (!validation.success) {
    throw new TypeError(validation.errors.join('; '))
  }
  if (validation.value.nodeId !== context.localNodeId) {
    throw new DeviceCredentialCorrelationError(
      'Credential reference nodeId does not match the local nodeId',
    )
  }
  context.signal.throwIfAborted()
  const resolved = await provider.resolve(validation.value, context)
  context.signal.throwIfAborted()
  assertDeviceCredentialCorrelation(
    validation.value,
    resolved,
    context.localNodeId,
  )
  return resolved
}

export class DeterministicFakeDeviceCredentialProvider
  implements DeviceCredentialProvider {
  readonly resolutions: Array<{
    reference: DeviceCredentialReferenceV1
    context: Omit<DeviceCredentialConnectContext, 'signal'>
  }> = []

  readonly #authentication: DeviceAuthenticationV1
  readonly #deviceIdentityFingerprint: string
  readonly #signer: DeviceCredentialSigner

  constructor(
    resolved: Omit<ResolvedDeviceCredential, 'proof'>,
    signer: DeviceCredentialSigner,
  ) {
    this.#authentication = structuredClone(resolved.authentication)
    this.#deviceIdentityFingerprint = resolved.deviceIdentityFingerprint
    this.#signer = signer
  }

  resolve(
    reference: DeviceCredentialReferenceV1,
    context: DeviceCredentialConnectContext,
  ): Promise<ResolvedDeviceCredential> {
    this.resolutions.push({
      reference: structuredClone(reference),
      context: { endpoint: context.endpoint, localNodeId: context.localNodeId },
    })
    return Promise.resolve({
      authentication: structuredClone(this.#authentication),
      deviceIdentityFingerprint: this.#deviceIdentityFingerprint,
      proof: new DeviceCredentialProof(this.#signer),
    })
  }
}

function parseStoredEd25519Key(value: Uint8Array): StoredEd25519KeyV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
  } catch {
    throw new TypeError('Protected Ed25519 key material is invalid')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Protected Ed25519 key material is invalid')
  }
  const candidate = parsed as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.version !== 1 ||
    candidate.algorithm !== 'Ed25519' ||
    typeof candidate.privateKey !== 'object' ||
    candidate.privateKey === null ||
    Array.isArray(candidate.privateKey)
  ) {
    throw new TypeError('Protected Ed25519 key material is invalid')
  }
  const privateKey = candidate.privateKey as JsonWebKey
  if (
    privateKey.kty !== 'OKP' || privateKey.crv !== 'Ed25519' ||
    typeof privateKey.d !== 'string' || typeof privateKey.x !== 'string'
  ) {
    throw new TypeError('Protected Ed25519 key material is invalid')
  }
  return { version: 1, algorithm: 'Ed25519', privateKey }
}

async function publicIdentity(
  providerId: string,
  keyId: string,
  material: StoredEd25519KeyV1,
): Promise<DevicePublicIdentity> {
  const publicKey = decodeBase64Url(material.privateKey.x as string)
  if (publicKey.length !== 32) {
    throw new TypeError('Protected Ed25519 public key is invalid')
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', ownedArrayBuffer(publicKey)),
  )
  return {
    providerId,
    keyId,
    devicePublicKey: encodeBase64Url(publicKey),
    deviceIdentityFingerprint: `sha256:${encodeBase64Url(digest)}`,
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('Protected Ed25519 public key is invalid')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
