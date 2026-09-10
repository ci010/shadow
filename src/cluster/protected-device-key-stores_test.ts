import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import {
  createPlatformDeviceKeyStore,
  LinuxSecretServiceDeviceKeyStore,
  type ProtectedKeyCommandRunner,
  ProtectedKeyStoreError,
  WindowsDpapiDeviceKeyStore,
} from './protected-device-key-stores.ts'

class FakeRunner implements ProtectedKeyCommandRunner {
  readonly calls: Array<{
    command: string
    args: readonly string[]
    input: Uint8Array
  }> = []

  constructor(readonly result: { success: boolean; stdout: Uint8Array }) {}

  run(
    command: string,
    args: readonly string[],
    input: Uint8Array,
  ): Promise<{ success: boolean; stdout: Uint8Array }> {
    this.calls.push({ command, args, input: input.slice() })
    return Promise.resolve({
      success: this.result.success,
      stdout: this.result.stdout.slice(),
    })
  }
}

test('Linux Secret Service passes key material only through stdin', async () => {
  const runner = new FakeRunner({ success: true, stdout: new Uint8Array() })
  const store = new LinuxSecretServiceDeviceKeyStore('shadow-test', runner)
  const secret = new TextEncoder().encode('{"private":"secret"}')

  await store.save('device-key-1', secret, new AbortController().signal)

  assertEquals(runner.calls.length, 1)
  assertEquals(runner.calls[0]?.command, 'secret-tool')
  assertEquals(runner.calls[0]?.args.some((value) => value.includes('secret')), false)
  assertEquals(runner.calls[0]?.input, secret)
})

test('platform key store selection never falls back to plaintext', () => {
  assertEquals(
    createPlatformDeviceKeyStore('C:\\state', 'windows').providerId,
    'windows-dpapi-current-user',
  )
  assertEquals(
    createPlatformDeviceKeyStore('/state', 'linux', {}).providerId,
    'linux-secret-service',
  )
  assertEquals(
    createPlatformDeviceKeyStore('/state', 'linux', {
      WSL_INTEROP: '/run/WSL/1_interop',
    }).providerId,
    'wsl-windows-dpapi-current-user',
  )
  let error: unknown
  try {
    createPlatformDeviceKeyStore('/state', 'darwin')
  } catch (cause) {
    error = cause
  }
  assertEquals(error instanceof ProtectedKeyStoreError, true)
})

if (process.platform === 'win32') {
  test('Windows DPAPI store round-trips without plaintext on disk', async () => {
    const directory = await createTempWorkspace()
    try {
      const store = new WindowsDpapiDeviceKeyStore(directory)
      const secret = new TextEncoder().encode('private-key-material')
      const signal = new AbortController().signal
      await store.save('device-key-1', secret, signal)

      const protectedValue = await readFile(
        `${directory}\\device-key-1.dpapi`,
      )
      assertEquals(
        new TextDecoder().decode(protectedValue).includes('private-key-material'),
        false,
      )
      assertEquals(await store.load('device-key-1', signal), secret)
    } finally {
      await rm(directory, { recursive: true })
    }
  })
}

test('failed Windows protection is reported without command output', async () => {
  const runner = new FakeRunner({
    success: false,
    stdout: new TextEncoder().encode('sensitive command output'),
  })
  const store = new WindowsDpapiDeviceKeyStore('C:\\state', runner)

  await assertRejects(
    () =>
      store.save(
        'device-key-1',
        new Uint8Array([1]),
        new AbortController().signal,
      ),
    (error) => error instanceof ProtectedKeyStoreError &&
      error.message.includes('could not protect'),
  )
})