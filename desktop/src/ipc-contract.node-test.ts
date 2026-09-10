import assert from 'node:assert/strict'
import test from 'node:test'
import {
  handleInitializeMain,
  parseLaunchMainOptions,
  parseNoArguments,
  parseSelectionId,
  handleEnsureRuntime,
} from './ipc-contract.js'

test('bootstrap command IPC accepts only the public command inputs', () => {
  assert.equal(parseNoArguments([]), undefined)
  for (const values of [[undefined], [null], [{ dataDir: 'C:\\secret' }]]) {
    assert.throws(() => parseNoArguments(values), /accepts no arguments/)
  }
  assert.equal(parseSelectionId('opaque-id'), 'opaque-id')
  assert.deepEqual(parseLaunchMainOptions({ localExecutor: true, port: 43123 }), {
    localExecutor: true,
    port: 43123,
  })
  for (const value of [null, '', { selectionId: 'id', path: 'C:\\secret' }]) {
    assert.throws(() => parseSelectionId(value), /selection ID is invalid/)
  }
  for (const value of [
    null,
    { localExecutor: true, port: 0 },
    { localExecutor: true, port: 65536 },
    { localExecutor: 'yes', port: 43123 },
    { localExecutor: true, port: 43123, token: 'secret' },
    { localExecutor: true, port: 43123, configPath: 'C:\\secret' },
  ]) {
    assert.throws(() => parseLaunchMainOptions(value), /launch options are invalid/)
  }
})

test('initialize-main IPC handler accepts no arguments and returns only its command result', async () => {
  let calls = 0
  const result = {
    ok: true as const,
    state: { version: 1 as const, revision: 3, mode: 'main' as const, step: 'configure-provider' as const },
  }
  const coordinator = { initializeMain: async () => { calls += 1; return result } }

  assert.deepEqual(await handleInitializeMain(coordinator, []), result)
  assert.throws(() => handleInitializeMain(coordinator, [{ dataDir: 'C:\\secret' }]), /accepts no arguments/)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('ensureRuntime accepts no renderer arguments and returns the frozen result', async () => {
  const expected = { ok: false, code: 'profile-missing' } as const
  assert.deepEqual(await handleEnsureRuntime({ ensureRuntime: async () => expected }, []), expected)
  assert.throws(
    () => handleEnsureRuntime({ ensureRuntime: async () => expected }, ['unexpected']),
    /accepts no arguments/,
  )
})