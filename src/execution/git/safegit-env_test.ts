import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from '../../testing/workspace.ts'
import { localExecSafegitEnv, requestedSafegitBinary } from './safegit.ts'

test('local exec uses the shared resolver and only advertises an existing supported bundle', async () => {
  const workspace = await createTempWorkspace()
  try {
    const binary = join(workspace, 'synthetic-safegit')
    const input = { OTHER: 'dotenv' }
    const host = { OTHER: 'host' }
    const resolve = () => binary
    const target = () => 'synthetic'
    assert.deepEqual(await localExecSafegitEnv(input, host, resolve, target), input)
    await mkdir(binary)
    assert.deepEqual(await localExecSafegitEnv(input, host, resolve, target), input)
    await rm(binary, { recursive: true })
    await writeFile(binary, 'synthetic fixture, never executed')
    assert.deepEqual(await localExecSafegitEnv(input, host, resolve, target), { ...input, SHADOW_SAFEGIT_PATH: binary })
    assert.deepEqual(await localExecSafegitEnv(input, host, resolve, () => undefined), input)
    assert.deepEqual(await localExecSafegitEnv(input, host, () => { throw new Error('unavailable') }, target), input)
    assert.deepEqual(input, { OTHER: 'dotenv' })
    assert.deepEqual(host, { OTHER: 'host' })
    assert.equal(requestedSafegitBinary(import.meta.url, binary), binary)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('explicit host override wins over dotenv; dotenv and empty explicit values are preserved without probing', async () => {
  const probe = () => assert.fail('explicit configuration must not probe the bundle')
  assert.deepEqual(await localExecSafegitEnv({ SHADOW_SAFEGIT_PATH: 'dotenv', OTHER: 'dotenv' },
    { SHADOW_SAFEGIT_PATH: 'host', OTHER: 'host' }, probe, probe),
  { SHADOW_SAFEGIT_PATH: 'host', OTHER: 'dotenv' })
  assert.deepEqual(await localExecSafegitEnv({ SHADOW_SAFEGIT_PATH: 'dotenv' }, {}, probe, probe),
    { SHADOW_SAFEGIT_PATH: 'dotenv' })
  assert.deepEqual(await localExecSafegitEnv({}, { SHADOW_SAFEGIT_PATH: '' }, probe, probe),
    { SHADOW_SAFEGIT_PATH: '' })
})
