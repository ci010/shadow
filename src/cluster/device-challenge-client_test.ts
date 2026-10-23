import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeDeviceChallengeProtocol,
  type DeviceChallengeV1,
} from './device-challenge.ts'
import { requestDeviceChallengeProtocol } from './device-challenge-client.ts'
import { DeviceCredentialProof } from './device-credentials.ts'

const auth = {
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
}
const challenge: DeviceChallengeV1 = {
  version: 1,
  challengeId: 'challenge-1',
  ...auth,
  audience: 'ws://main.test/cluster/v1/node',
  nonce: 'bm9uY2U',
  expiresAt: '2026-08-26T00:01:00.000Z',
}

test('Child challenge client requests its identity and returns a signed WebSocket protocol', async () => {
  let request: Request | undefined
  const protocol = await requestDeviceChallengeProtocol(
    'https://main.test/base?ignored=yes',
    auth,
    new DeviceCredentialProof((input) => input),
    async (input, init) => {
      request = new Request(input, init)
      return Response.json(challenge)
    },
  )

  assertEquals(request?.url, 'https://main.test/base/cluster/v1/challenges')
  assertEquals(await request?.json(), { version: 1, ...auth })
  const proof = decodeDeviceChallengeProtocol(protocol)
  assertEquals(proof?.challengeId, challenge.challengeId)
  assertEquals(proof?.credentialId, auth.credentialId)
})

test('Child challenge client rejects response identity mismatch', async () => {
  await assertRejects(
    () =>
      requestDeviceChallengeProtocol(
        'https://main.test',
        auth,
        new DeviceCredentialProof((input) => input),
        () =>
          Promise.resolve(
            Response.json({ ...challenge, nodeId: 'node-other' }),
          ),
      ),
    (error) => error instanceof Error && error.message.includes('does not match'),
  )
})
