import type { DeviceCredentialProof } from './device-credentials.ts'
import type {
  DeviceAuthenticationV1,
  InMemoryPairingNodeRegistry,
} from './registry.ts'

export interface DeviceChallengeV1 {
  readonly version: 1
  readonly challengeId: string
  readonly deviceId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly audience: string
  readonly nonce: string
  readonly expiresAt: string
}

export interface DeviceChallengeProofV1 {
  readonly version: 1
  readonly challengeId: string
  readonly deviceId: string
  readonly nodeId: string
  readonly credentialId: string
  readonly signature: string
}

export interface DeviceChallengeAuthorityOptions {
  readonly ttlMs?: number
  readonly challengeIdFactory?: () => string
  readonly randomBytes?: (length: number) => Uint8Array
}

interface RegisteredCredential {
  readonly authentication: DeviceAuthenticationV1
  readonly publicKey: CryptoKey
}

interface ActiveChallenge {
  readonly challenge: DeviceChallengeV1
}

const DEFAULT_CHALLENGE_TTL_MS = 60_000
const CHALLENGE_DOMAIN = 'shadow-node-websocket-v1'
const CHALLENGE_PROTOCOL_PREFIX = 'shadow-node-v1.'

export class DeviceChallengeAuthority {
  readonly #credentials = new Map<string, RegisteredCredential>()
  readonly #challenges = new Map<string, ActiveChallenge>()
  readonly #ttlMs: number
  readonly #challengeIdFactory: () => string
  readonly #randomBytes: (length: number) => Uint8Array

  constructor(
    readonly registry: InMemoryPairingNodeRegistry,
    options: DeviceChallengeAuthorityOptions = {},
  ) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new TypeError(
        'Device challenge TTL must be a positive safe integer',
      )
    }
    this.#challengeIdFactory = options.challengeIdFactory ??
      (() => crypto.randomUUID())
    this.#randomBytes = options.randomBytes ?? secureRandomBytes
  }

  async registerCredential(
    authentication: DeviceAuthenticationV1,
    publicKeyBase64Url?: string,
  ): Promise<void> {
    const approved = this.registry.authenticate(authentication)
    const persistedPublicKey = publicKeyBase64Url ?? approved.devicePublicKey
    if (!persistedPublicKey) {
      throw new TypeError('Approved device has no persisted Ed25519 public key')
    }
    const publicKeyBytes = decodeBase64Url(persistedPublicKey)
    if (publicKeyBytes.length !== 32) {
      throw new TypeError('Ed25519 public key must contain 32 bytes')
    }
    const fingerprint = await devicePublicKeyFingerprint(publicKeyBytes)
    if (fingerprint !== approved.deviceIdentityFingerprint) {
      throw new TypeError(
        'Device public key fingerprint does not match the approved identity',
      )
    }
    const publicKey = await crypto.subtle.importKey(
      'raw',
      ownedArrayBuffer(publicKeyBytes),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    this.#credentials.set(authentication.credentialId, {
      authentication: structuredClone(authentication),
      publicKey,
    })
  }

  async restoreRegisteredCredentials(): Promise<number> {
    let restored = 0
    for (const approved of this.registry.getApprovedNodes()) {
      if (!approved.devicePublicKey) continue
      await this.registerCredential({
        deviceId: approved.deviceId,
        nodeId: approved.nodeId,
        credentialId: approved.credentialId,
      })
      restored++
    }
    return restored
  }

  issue(
    authentication: DeviceAuthenticationV1,
    audience: string,
    now = new Date(),
  ): DeviceChallengeV1 {
    this.registry.authenticate(authentication)
    for (const [id, active] of this.#challenges) {
      if (Date.parse(active.challenge.expiresAt) <= now.getTime()) this.#challenges.delete(id)
    }
    if (this.#challenges.size >= 4096) throw new TypeError('Device challenge capacity reached')
    const registered = this.#credentials.get(authentication.credentialId)
    if (
      !registered ||
      !sameAuthentication(registered.authentication, authentication)
    ) {
      throw new TypeError('Device credential public key is not registered')
    }
    const normalizedAudience = normalizeAudience(audience)
    const nonceBytes = this.#randomBytes(32)
    if (nonceBytes.length !== 32) {
      throw new TypeError(
        'Device challenge random source returned invalid bytes',
      )
    }
    const challenge: DeviceChallengeV1 = {
      version: 1,
      challengeId: this.#challengeIdFactory(),
      ...structuredClone(authentication),
      audience: normalizedAudience,
      nonce: encodeBase64Url(nonceBytes),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    }
    this.#challenges.set(challenge.challengeId, { challenge })
    return structuredClone(challenge)
  }

  async verify(
    value: unknown,
    audience: string,
    now = new Date(),
  ): Promise<DeviceAuthenticationV1 | null> {
    const proof = parseDeviceChallengeProof(value)
    if (proof === null) return null
    const active = this.#challenges.get(proof.challengeId)
    if (!active) return null
    this.#challenges.delete(proof.challengeId)

    const challenge = active.challenge
    if (
      now.getTime() >= Date.parse(challenge.expiresAt) ||
      normalizeAudience(audience) !== challenge.audience
    ) return null
    const authentication = authenticationFromProof(proof)
    if (!sameAuthentication(authentication, challenge)) return null
    const registered = this.#credentials.get(authentication.credentialId)
    if (
      !registered ||
      !sameAuthentication(registered.authentication, authentication)
    ) return null
    try {
      this.registry.authenticate(authentication)
      const signature = decodeBase64Url(proof.signature)
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        registered.publicKey,
        ownedArrayBuffer(signature),
        ownedArrayBuffer(deviceChallengeSigningInput(challenge)),
      )
      return valid ? structuredClone(authentication) : null
    } catch {
      return null
    }
  }

  verifyWebSocketRequest(
    request: Request,
    now = new Date(),
  ): Promise<
    { authentication: DeviceAuthenticationV1; protocol: string } | null
  > {
    const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',')
      .map((value) => value.trim()).filter(Boolean) ?? []
    const protocol = protocols.find((value) =>
      value.startsWith(CHALLENGE_PROTOCOL_PREFIX)
    )
    if (!protocol) return Promise.resolve(null)
    const proof = decodeDeviceChallengeProtocol(protocol)
    if (proof === null) return Promise.resolve(null)
    return this.verify(proof, nodeWebSocketAudience(request.url), now).then((
      authentication,
    ) => authentication ? { authentication, protocol } : null)
  }
}

export async function createDeviceChallengeProof(
  challenge: DeviceChallengeV1,
  proof: DeviceCredentialProof,
): Promise<DeviceChallengeProofV1> {
  const signature = await proof.sign(deviceChallengeSigningInput(challenge))
  return {
    version: 1,
    challengeId: challenge.challengeId,
    deviceId: challenge.deviceId,
    nodeId: challenge.nodeId,
    credentialId: challenge.credentialId,
    signature: encodeBase64Url(signature),
  }
}

export function deviceChallengeSigningInput(
  challenge: DeviceChallengeV1,
): Uint8Array {
  return new TextEncoder().encode([
    CHALLENGE_DOMAIN,
    challenge.challengeId,
    challenge.deviceId,
    challenge.nodeId,
    challenge.credentialId,
    challenge.audience,
    challenge.nonce,
    challenge.expiresAt,
  ].join('\n'))
}

export function encodeDeviceChallengeProtocol(
  proof: DeviceChallengeProofV1,
): string {
  const encoded = new TextEncoder().encode(JSON.stringify(proof))
  return `${CHALLENGE_PROTOCOL_PREFIX}${encodeBase64Url(encoded)}`
}

export function decodeDeviceChallengeProtocol(
  protocol: string,
): DeviceChallengeProofV1 | null {
  if (!protocol.startsWith(CHALLENGE_PROTOCOL_PREFIX)) return null
  try {
    const encoded = protocol.slice(CHALLENGE_PROTOCOL_PREFIX.length)
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        decodeBase64Url(encoded),
      ),
    )
    return parseDeviceChallengeProof(value)
  } catch {
    return null
  }
}

export function nodeWebSocketAudience(requestUrl: string): string {
  const url = new URL(requestUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Node WebSocket URL must use http, https, ws, or wss')
  }
  url.pathname = '/cluster/v1/node'
  url.search = ''
  url.hash = ''
  return normalizeAudience(url.toString())
}

export async function devicePublicKeyFingerprint(
  publicKey: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    ownedArrayBuffer(publicKey),
  )
  return `sha256:${encodeBase64Url(new Uint8Array(digest))}`
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  )
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('Invalid base64url value')
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function parseDeviceChallengeProof(
  value: unknown,
): DeviceChallengeProofV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const fields = [
    'version',
    'challengeId',
    'deviceId',
    'nodeId',
    'credentialId',
    'signature',
  ]
  if (
    Object.keys(candidate).length !== fields.length ||
    fields.some((field) => !(field in candidate))
  ) {
    return null
  }
  if (candidate.version !== 1) return null
  for (const field of fields.slice(1)) {
    if (typeof candidate[field] !== 'string' || candidate[field].length === 0) {
      return null
    }
  }
  return candidate as unknown as DeviceChallengeProofV1
}

function authenticationFromProof(
  proof: DeviceChallengeProofV1,
): DeviceAuthenticationV1 {
  return {
    deviceId: proof.deviceId,
    nodeId: proof.nodeId,
    credentialId: proof.credentialId,
  }
}

function sameAuthentication(
  left: Pick<DeviceAuthenticationV1, 'deviceId' | 'nodeId' | 'credentialId'>,
  right: Pick<DeviceAuthenticationV1, 'deviceId' | 'nodeId' | 'credentialId'>,
): boolean {
  return left.deviceId === right.deviceId && left.nodeId === right.nodeId &&
    left.credentialId === right.credentialId
}

function normalizeAudience(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Device challenge audience must use ws or wss')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      'Device challenge audience must not contain credentials, query, or fragment',
    )
  }
  return url.toString()
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
