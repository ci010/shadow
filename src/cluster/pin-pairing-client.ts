import type { DeviceCredentialReferenceStore } from './device-credential-reference-store.ts'
import {
  type DeviceCredentialReferenceV1,
  ProtectedEd25519DeviceCredentialProvider,
} from './device-credentials.ts'

export type PairingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface PinPairingClientOptions {
  readonly existingReference?: DeviceCredentialReferenceV1
  readonly endpoint: string
  readonly offerId: string
  readonly pin: string
  readonly localNodeId: string
  readonly displayName: string
  readonly credentialProvider: ProtectedEd25519DeviceCredentialProvider
  readonly referenceStore: DeviceCredentialReferenceStore
  readonly fetchPairing?: PairingFetch
  readonly idFactory?: () => string
  readonly allowInsecureHttp?: boolean
  readonly signal?: AbortSignal
}

export interface PinPairingClientResult {
  readonly pendingId: string
  readonly requestedAt: string
  readonly reference: DeviceCredentialReferenceV1
}

export async function presentPinPairing(
  options: PinPairingClientOptions,
): Promise<PinPairingClientResult> {
  const url = pairingUrl(options.endpoint, options.allowInsecureHttp ?? false)
  const signal = options.signal ?? new AbortController().signal
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const deviceId = options.existingReference?.deviceId ?? idFactory()
  const pendingId = idFactory()
  const credentialId = options.existingReference?.credentialId ?? idFactory()
  const keyId = options.existingReference?.keyId ?? `device-key-${deviceId}`
  if (options.existingReference) {
    await options.credentialProvider.resolve(options.existingReference, { endpoint: options.endpoint, localNodeId: options.localNodeId, signal })
    if (options.existingReference.nodeId !== options.localNodeId) throw new TypeError('Saved credential does not match this node')
  }
  const identity = await options.credentialProvider.loadOrCreateKey(keyId, signal)
  signal.throwIfAborted()

  const response = await (options.fetchPairing ?? fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      offerId: options.offerId,
      pin: options.pin,
      pendingId,
      deviceId,
      nodeId: options.localNodeId,
      deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
      devicePublicKey: identity.devicePublicKey,
      credentialId,
      displayName: options.displayName,
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`Main pairing request failed with status ${response.status}`)
  }
  const pending = parsePending(await response.json(), pendingId)
  const reference: DeviceCredentialReferenceV1 = {
    version: 1,
    kind: 'protected-device-credential',
    providerId: identity.providerId,
    keyId: identity.keyId,
    deviceId,
    nodeId: options.localNodeId,
    credentialId,
    deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
  }
  await options.referenceStore.save(reference)
  return { ...pending, reference: structuredClone(reference) }
}

function pairingUrl(endpoint: string, allowInsecureHttp: boolean): URL {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Main endpoint must use http or https')
  }
  if (
    url.protocol === 'http:' && !allowInsecureHttp &&
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  ) {
    throw new TypeError('Non-loopback PIN pairing requires https')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath}/pair/v1/present`
  url.search = ''
  url.hash = ''
  return url
}

function parsePending(
  value: unknown,
  expectedPendingId: string,
): { pendingId: string; requestedAt: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Main pairing response is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 4 ||
    candidate.version !== 1 || candidate.state !== 'pending' ||
    candidate.pendingId !== expectedPendingId ||
    typeof candidate.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.requestedAt))
  ) {
    throw new TypeError('Main pairing response is invalid')
  }
  return {
    pendingId: candidate.pendingId,
    requestedAt: candidate.requestedAt,
  }
}