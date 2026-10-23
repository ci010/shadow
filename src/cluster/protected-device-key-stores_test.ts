import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createTempWorkspace } from '../testing/workspace.ts'
import {
  createPlatformDeviceKeyStore,
  LinuxSecretServiceDeviceKeyStore,
  MacOsKeychainDeviceKeyStore,
  NodeProtectedKeyCommandRunner,
  type ProtectedKeyCommandRunner,
  ProtectedKeyStoreError,
  WindowsDpapiDeviceKeyStore,
} from './protected-device-key-stores.ts'
import { ProtectedEd25519DeviceCredentialProvider } from './device-credentials.ts'

interface FakeResult {
  success: boolean
  stdout: Uint8Array
  exitCode?: number | null
}

class FakeRunner implements ProtectedKeyCommandRunner {
  readonly calls: Array<{
    command: string
    args: readonly string[]
    input: Uint8Array
  }> = []

  constructor(readonly result: FakeResult | FakeResult[]) {}

  run(
    command: string,
    args: readonly string[],
    input: Uint8Array,
  ): Promise<FakeResult> {
    this.calls.push({ command, args, input: new Uint8Array(input) })
    const result = Array.isArray(this.result) ? this.result.shift() : this.result
    if (!result) throw new Error('Unexpected provider command')
    return Promise.resolve({
      ...result,
      stdout: new Uint8Array(result.stdout),
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
  assertEquals(
    createPlatformDeviceKeyStore('/state', 'darwin').providerId,
    'macos-keychain',
  )
  let error: unknown
  try {
    createPlatformDeviceKeyStore('/state', 'freebsd')
  } catch (cause) {
    error = cause
  }
  assertEquals(error instanceof ProtectedKeyStoreError, true)
})

test('macOS Keychain writes binary material only through stdin and verifies persistence', async () => {
  const value = new Uint8Array([0, 255, 13, 10, 128, 34, 92])
  const encoded = Buffer.from(value).toString('base64')
  const runner = new FakeRunner([
    { success: true, stdout: new Uint8Array(), exitCode: 0 },
    { success: true, stdout: Buffer.from(`${encoded}\n`), exitCode: 0 },
  ])
  const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
  const keyId = 'x"\n delete-generic-password -s victim; $(echo injection)'
  await store.save(keyId, value, new AbortController().signal)

  const account = createHash('sha256').update(keyId).digest('hex')
  assertEquals(runner.calls.length, 2)
  assertEquals(runner.calls[0]?.command, '/usr/bin/security')
  assertEquals(runner.calls[0]?.args, ['-i'])
  assertEquals(
    Buffer.from(runner.calls[0]!.input).toString(),
    `add-generic-password -U -s shadow-test -a ${account} -w "${encoded}"\n`,
  )
  assertEquals(runner.calls[1]?.args, [
    'find-generic-password', '-s', 'shadow-test', '-a', account, '-w',
  ])
  assertEquals(value, new Uint8Array([0, 255, 13, 10, 128, 34, 92]))
})

test('macOS Keychain returns null only for explicit item-not-found', async () => {
  const runner = new FakeRunner({
    success: false, exitCode: 44, stdout: new Uint8Array(),
  })
  const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
  assertEquals(await store.load('missing', new AbortController().signal), null)
})

test('macOS Keychain failures never recreate a locked or denied device key', async () => {
  for (const exitCode of [36, 51, 128, 1, null, undefined]) {
    const runner = new FakeRunner({
      success: false, exitCode, stdout: Buffer.from('sensitive provider output'),
    })
    const provider = new ProtectedEd25519DeviceCredentialProvider(
      new MacOsKeychainDeviceKeyStore('shadow-test', runner),
    )
    await assertRejects(
      () => provider.loadOrCreateKey('device-key-1', new AbortController().signal),
      (error) => error instanceof ProtectedKeyStoreError &&
        error.code === 'lookup-failed' &&
        !error.message.includes('sensitive'),
    )
    assertEquals(runner.calls.length, 1)
  }
})

test('macOS Keychain rejects malformed encoded material without leaking it', async () => {
  for (const output of ['not base64!', 'c2VjcmV0 \n', 'c2VjcmV0\n\n', '/x==\n']) {
    const runner = new FakeRunner({
      success: true, stdout: Buffer.from(output),
    })
    const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
    await assertRejects(
      () => store.load('device-key-1', new AbortController().signal),
      (error) => error instanceof ProtectedKeyStoreError &&
        error.code === 'unprotect-failed' && error.cause === undefined,
    )
  }
})

test('macOS Keychain verifies writes even when interactive security reports success', async () => {
  for (const lookup of [
    { success: false, stdout: new Uint8Array(), exitCode: 44 },
    { success: true, stdout: Buffer.from('b2xk\n'), exitCode: 0 },
    { success: false, stdout: new Uint8Array(), exitCode: 36 },
  ]) {
    const runner = new FakeRunner([
      { success: true, stdout: Buffer.from('ignored command output'), exitCode: 0 },
      lookup,
    ])
    const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
    await assertRejects(
      () => store.save('device-key-1', Buffer.from('new'), new AbortController().signal),
      (error) => error instanceof ProtectedKeyStoreError &&
        ['store-failed', 'lookup-failed'].includes(error.code),
    )
    assertEquals(runner.calls.length, 2)
  }
})

test('macOS Keychain reports failed writes without reading back or logging output', async () => {
  const runner = new FakeRunner({
    success: false, exitCode: 36, stdout: Buffer.from('sensitive provider output'),
  })
  const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
  await assertRejects(
    () => store.save('key', Buffer.from('secret'), new AbortController().signal),
    (error) => error instanceof ProtectedKeyStoreError &&
      error.code === 'store-failed' && !error.message.includes('sensitive'),
  )
  assertEquals(runner.calls.length, 1)
})

test('macOS Keychain rejects unsafe services, oversized values, and aborted operations', async () => {
  const runner = new FakeRunner({ success: true, stdout: new Uint8Array() })
  for (const service of ['', 'a\nquit', '-x', 'a b', 'a"b', 'a'.repeat(129)]) {
    let error: unknown
    try {
      new MacOsKeychainDeviceKeyStore(service, runner)
    } catch (cause) {
      error = cause
    }
    assertEquals(error instanceof TypeError, true)
  }
  const store = new MacOsKeychainDeviceKeyStore('shadow-test', runner)
  await assertRejects(
    () => store.save('key', new Uint8Array(2049), new AbortController().signal),
    (error) => error instanceof ProtectedKeyStoreError && error.code === 'store-failed',
  )
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assertRejects(() => store.load('key', controller.signal), /cancelled/)
  await assertRejects(() => store.save('key', new Uint8Array(), controller.signal), /cancelled/)
  assertEquals(runner.calls.length, 0)
})

test('macOS Keychain live synthetic lifecycle (opt-in, unlocked user Keychain required)', {
  skip: process.platform !== 'darwin' || process.env.SHADOW_TEST_MACOS_KEYCHAIN !== '1',
}, async () => {
  const service = `shadow.keychain-test.${crypto.randomUUID()}`
  const keyId = 'synthetic-device-key'
  const runner = new NodeProtectedKeyCommandRunner()
  const store = new MacOsKeychainDeviceKeyStore(service, runner)
  const signal = AbortSignal.timeout(30_000)
  try {
    assertEquals(await store.load(keyId, signal), null)
    for (const value of [
      new Uint8Array([0, 255, 13, 10, 128, 34, 92]),
      new Uint8Array(2048).fill(255),
      new Uint8Array(),
    ]) {
      await store.save(keyId, value, signal)
      const reopened = new MacOsKeychainDeviceKeyStore(service)
      assertEquals(await reopened.load(keyId, signal), value)
    }
  } finally {
    const result = await runner.run(
      '/usr/bin/security',
      [
        'delete-generic-password', '-s', service,
        '-a', createHash('sha256').update(keyId).digest('hex'),
      ],
      new Uint8Array(),
      AbortSignal.timeout(30_000),
    )
    assertEquals(result.success || result.exitCode === 44, true)
  }
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