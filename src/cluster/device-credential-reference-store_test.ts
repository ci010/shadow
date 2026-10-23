import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { AtomicDeviceCredentialReferenceStore } from './device-credential-reference-store.ts'

const reference = {
  version: 1,
  kind: 'protected-device-credential',
  providerId: 'windows-dpapi-current-user',
  keyId: 'device-key-1',
  deviceId: 'device-1',
  nodeId: 'node-1',
  credentialId: 'credential-1',
  deviceIdentityFingerprint: 'sha256:fingerprint',
} as const

test('device credential reference store atomically round-trips non-secret metadata', async () => {
  const directory = await createTempWorkspace()
  try {
    const filePath = `${directory}/credentials/device-credential.v1.json`
    const store = new AtomicDeviceCredentialReferenceStore(filePath)
    assertEquals(await store.load(), null)
    await store.save(reference)
    assertEquals(await store.load(), reference)
    assertEquals(
      await readdir(`${directory}/credentials`),
      ['device-credential.v1.json'],
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('device credential reference store rejects secret fields', async () => {
  const directory = await createTempWorkspace()
  try {
    const store = new AtomicDeviceCredentialReferenceStore(
      `${directory}/device-credential.v1.json`,
    )
    await assertRejects(
      () => store.save({ ...reference, privateKey: 'forbidden' } as never),
      { name: 'TypeError', message: /unknown field/ },
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})