import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareDevelopment } from './dev.ts'

function fixture(ready: boolean) {
  const calls: string[] = []
  return { calls, operations: {
    async dependenciesReady() { calls.push('check'); return ready },
    async install() { calls.push('install'); ready = true },
    async prepareNative() { calls.push('prepare-native') },
    async verifyNative() { calls.push('verify-native') },
  } }
}

test('cold dev installs workspace dependencies before verifying native assets', async () => {
  const f = fixture(false)
  await prepareDevelopment(f.operations)
  assert.deepEqual(f.calls, ['check', 'install', 'check', 'verify-native'])
})

test('warm dev still prepares native assets without running pnpm install', async () => {
  const f = fixture(true)
  await prepareDevelopment(f.operations)
  assert.deepEqual(f.calls, ['check', 'prepare-native', 'verify-native'])
})

test('dev stops before launch when native preparation did not produce valid assets', async () => {
  const f = fixture(true)
  f.operations.verifyNative = async () => { throw new Error('missing native release') }
  await assert.rejects(prepareDevelopment(f.operations), /missing native release/)
})
