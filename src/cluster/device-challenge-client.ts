import {
  createDeviceChallengeProof,
  type DeviceChallengeV1,
  encodeDeviceChallengeProtocol,
} from './device-challenge.ts'
import type { DeviceCredentialProof } from './device-credentials.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'

export type ChallengeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class DeviceApprovalUnavailableError extends Error {}

export async function requestDeviceChallengeProtocol(
  endpoint: string,
  authentication: DeviceAuthenticationV1,
  proof: DeviceCredentialProof,
  fetchChallenge: ChallengeFetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Main endpoint must use http or https')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath}/cluster/v1/challenges`
  url.search = ''
  url.hash = ''
  const response = await fetchChallenge(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, ...authentication }),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) {
      const body = await response.json().catch(() => null)
      if (body?.error === 'credential_not_available') throw new DeviceApprovalUnavailableError('Main approval is unavailable for this credential')
    }
    throw new Error(
      `Main challenge request failed with status ${response.status}`,
    )
  }
  const challenge = parseChallenge(await response.json())
  if (
    challenge.deviceId !== authentication.deviceId ||
    challenge.nodeId !== authentication.nodeId ||
    challenge.credentialId !== authentication.credentialId
  ) {
    throw new Error(
      'Main challenge identity does not match the Child credential',
    )
  }
  return encodeDeviceChallengeProtocol(
    await createDeviceChallengeProof(challenge, proof),
  )
}

function parseChallenge(value: unknown): DeviceChallengeV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Main challenge response is invalid')
  }
  const candidate = value as Record<string, unknown>
  const fields = [
    'version',
    'challengeId',
    'deviceId',
    'nodeId',
    'credentialId',
    'audience',
    'nonce',
    'expiresAt',
  ]
  if (
    candidate.version !== 1 ||
    Object.keys(candidate).length !== fields.length ||
    fields.slice(1).some((field) =>
      typeof candidate[field] !== 'string' || candidate[field] === ''
    )
  ) throw new TypeError('Main challenge response is invalid')
  return candidate as unknown as DeviceChallengeV1
}
