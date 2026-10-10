import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basename, join } from 'node:path'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  COPILOT_VERIFICATION_URI,
  CopilotAuthenticator,
  CopilotAuthError,
  type CopilotAuthStorage,
} from './copilot.ts'

const epoch = 1_800_000_000_000
const deviceResponse = {
  device_code: 'private-device-token',
  user_code: 'ABCD-1234',
  verification_uri: COPILOT_VERIFICATION_URI,
  expires_in: 60,
  interval: 2,
}
const keyResponse = { token: 'private-copilot-token', expires_at: epoch / 1000 + 3600 }

function harness(responses: Array<unknown | Error>, initial: Record<string, string> = {}) {
  let now = epoch
  const files = new Map(Object.entries(initial))
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const waits: number[] = []
  const storage: CopilotAuthStorage = {
    read: (path) => files.get(basename(path)),
    write: (path, value) => { files.set(basename(path), value) },
    remove: (path) => { files.delete(basename(path)) },
  }
  const auth = new CopilotAuthenticator(join(process.cwd(), '.test-data', 'virtual-auth'), {
    storage,
    now: () => now,
    wait: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); now += ms },
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init })
      const response = responses.shift()
      if (response instanceof Error) throw response
      assert.notEqual(response, undefined, 'Unexpected network request')
      return response instanceof Response ? response : Response.json(response)
    }) as typeof fetch,
  })
  return { auth, calls, waits, files, storage }
}

test('sign-out removes local credentials and the model cache without contacting GitHub', async () => {
  const h = harness([], { 'access-token': 'saved-access', 'api-key.json': JSON.stringify(keyResponse), 'models.json': '{}' })
  h.auth.signOut()
  assert.equal(h.files.size, 0)
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.auth.getApiKey(), (error: unknown) => error instanceof CopilotAuthError && error.code === 'missing')
})

test('a refresh cannot recreate credentials removed by sign-out', async () => {
  const files = new Map([['access-token', 'saved-access']])
  const pending = Promise.withResolvers<Response>()
  const auth = new CopilotAuthenticator('synthetic-auth', {
    now: () => epoch,
    storage: {
      read: path => files.get(basename(path)),
      write: (path, value) => { files.set(basename(path), value) },
      remove: path => { files.delete(basename(path)) },
    },
    fetch: async () => pending.promise,
  })
  const refreshing = auth.getApiKey()
  auth.signOut()
  pending.resolve(Response.json(keyResponse))
  await assert.rejects(refreshing, (error: unknown) => error instanceof CopilotAuthError && error.code === 'cancelled')
  assert.equal(files.size, 0)
})

test('proxy failures expose a safe actionable category rather than private network details', async () => {
  const h = harness([new TypeError('fetch failed', {
    cause: Object.assign(new Error('private-proxy-address'), { code: 'SYSTEM_PROXY_UNAVAILABLE' }),
  })])
  await assert.rejects(h.auth.startDeviceLogin(), (error: unknown) => {
    assert(error instanceof CopilotAuthError)
    assert.equal(error.code, 'proxy')
    assert.match(error.message, /PAC/)
    assert.doesNotMatch(error.message, /private-proxy-address/)
    return true
  })
})

test('device flow honors interval and persistent slow_down, verifies exchange before explicit persistence', async () => {
  const h = harness([
    deviceResponse, { error: 'authorization_pending' }, { error: 'slow_down' },
    { error: 'authorization_pending' }, { access_token: 'private-access-token' }, keyResponse,
  ])
  const device = await h.auth.startDeviceLogin()
  assert.equal(device.expiresAt, epoch + 60_000)
  const intervals: number[] = []
  const grant = await h.auth.completeDeviceLogin(device, undefined, (ms) => intervals.push(ms))
  assert.deepEqual(h.waits, [2000, 2000, 7000, 7000])
  assert.deepEqual(intervals, [7000])
  assert.equal(h.files.size, 0)
  assert.equal(h.calls.at(-1)?.url, 'https://api.github.com/copilot_internal/v2/token')
  h.auth.persistGrant(grant)
  assert.equal(h.files.get('access-token'), 'private-access-token')
  assert.equal(await h.auth.getApiKey(), 'private-copilot-token')
  assert.equal(JSON.parse(h.calls[0].init!.body as string).client_id, 'Iv1.b507a08c87ecfe98')
})

test('missing credentials never initiate implicit device authorization', async () => {
  const h = harness([])
  await assert.rejects(h.auth.getApiKey(), (error) => error instanceof CopilotAuthError && error.code === 'missing')
  assert.equal(h.calls.length, 0)
})

test('existing expired API key refreshes and concurrent callers share one exchange', async () => {
  const h = harness([keyResponse], {
    'access-token': 'existing-access',
    'api-key.json': JSON.stringify({ token: 'expired', expires_at: epoch / 1000 - 1 }),
  })
  const keys = await Promise.all([h.auth.getApiKey(), h.auth.getApiKey()])
  assert.deepEqual(keys, [keyResponse.token, keyResponse.token])
  assert.equal(h.calls.length, 1)
  assert.equal(h.auth.hasValidApiKey(), true)
})

test('explicit credential recheck invalidates a revoked cached API key', async () => {
  const h = harness([new Response('private revoked body', { status: 401 })], {
    'access-token': 'revoked-access',
    'api-key.json': JSON.stringify(keyResponse),
  })
  assert.equal(h.auth.hasValidApiKey(), true)
  await assert.rejects(h.auth.getApiKey(undefined, true), (error) =>
    error instanceof CopilotAuthError && error.code === 'denied')
  assert.equal(h.auth.hasValidApiKey(), false)
})

test('cancelling an in-flight OAuth HTTP request aborts it without storing tokens', async () => {
  let enterPoll!: () => void
  const entered = new Promise<void>((resolve) => { enterPoll = resolve })
  const controller = new AbortController()
  const auth = new CopilotAuthenticator(join(process.cwd(), '.test-data', 'virtual-inflight'), {
    now: () => epoch,
    storage: { read: () => undefined, write: () => assert.fail('Must not persist'), remove: () => {} },
    wait: async () => {},
    fetch: (async (_url, init) => {
      enterPoll()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private-network-error')), { once: true })
      })
    }) as typeof fetch,
  })
  const completion = auth.completeDeviceLogin({
    deviceCode: 'private', userCode: 'ABCD-1234', verificationUri: COPILOT_VERIFICATION_URI,
    intervalMs: 1000, expiresAt: epoch + 60_000,
  }, controller.signal)
  await entered
  controller.abort()
  await assert.rejects(completion, (error) => error instanceof CopilotAuthError && error.code === 'cancelled')
})

test('denial, expiry and malformed OAuth responses have safe classified errors', async () => {
  for (const [response, code] of [
    [{ error: 'access_denied', error_description: 'private-secret-body' }, 'denied'],
    [{ error: 'expired_token', error_description: 'private-secret-body' }, 'expired'],
    [{ access_token: 123, private: 'private-secret-body' }, 'invalid'],
    [new Response('private-secret-body', { status: 503 }), 'network'],
    [new Error('private-secret-body'), 'network'],
  ] as const) {
    const h = harness([deviceResponse, response])
    const device = await h.auth.startDeviceLogin()
    await assert.rejects(h.auth.completeDeviceLogin(device), (error) => {
      assert.ok(error instanceof CopilotAuthError)
      assert.equal(error.code, code)
      assert.doesNotMatch(String(error), /private-secret-body/)
      return true
    })
    assert.equal(h.files.size, 0)
  }
})

test('server expiry prevents another poll and cancellation prevents persistence', async () => {
  const h = harness([{ ...deviceResponse, expires_in: 3 }, { error: 'authorization_pending' }])
  const device = await h.auth.startDeviceLogin()
  await assert.rejects(h.auth.completeDeviceLogin(device), (error) => error instanceof CopilotAuthError && error.code === 'expired')
  assert.deepEqual(h.waits, [2000, 1000])
  assert.equal(h.calls.length, 2)
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => h.auth.persistGrant({ accessToken: 'secret', apiKey: keyResponse }, controller.signal))
  assert.equal(h.files.size, 0)
})

test('verification URI and token exchange endpoints reject untrusted wire data', async () => {
  for (const response of [
    { ...deviceResponse, verification_uri: 'https://example.com/login/device' },
    { ...deviceResponse, verification_uri: 'http://github.com/login/device' },
    { ...deviceResponse, interval: 0 },
    { ...deviceResponse, interval: 0.5 },
    { ...deviceResponse, expires_in: '60' },
    { ...deviceResponse, device_code: 123 },
  ]) {
    const h = harness([response])
    await assert.rejects(h.auth.startDeviceLogin(), CopilotAuthError)
  }
  const h = harness([
    deviceResponse, { access_token: 'secret' },
    { ...keyResponse, endpoints: { api: 'https://evil.example/api' } },
  ])
  await assert.rejects(h.auth.completeDeviceLogin(await h.auth.startDeviceLogin()), CopilotAuthError)
  assert.equal(h.files.size, 0)
})

test('OAuth success without Copilot entitlement is not persisted', async () => {
  const h = harness([deviceResponse, { access_token: 'secret' }, new Response('private denial', { status: 403 })])
  await assert.rejects(h.auth.completeDeviceLogin(await h.auth.startDeviceLogin()), (error) =>
    error instanceof CopilotAuthError && error.code === 'denied')
  assert.equal(h.files.size, 0)
})

test('persistence failures are surfaced and restore previous token state', () => {
  const h = harness([], { 'access-token': 'old' })
  const write = h.storage.write
  h.storage.write = (path, value) => {
    if (basename(path) === 'api-key.json') throw new Error('private filesystem detail')
    write(path, value)
  }
  assert.throws(() => h.auth.persistGrant({ accessToken: 'new', apiKey: keyResponse }), (error) =>
    error instanceof CopilotAuthError && error.code === 'storage' && !error.message.includes('private'))
  assert.equal(h.files.get('access-token'), 'old')
})

test('disk credentials are private and restored by a new authenticator', (t) => {
  const root = join(process.cwd(), '.test-data', `copilot-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const auth = new CopilotAuthenticator(root, { now: () => epoch })
  auth.persistGrant({ accessToken: 'synthetic-access', apiKey: keyResponse })
  const restored = new CopilotAuthenticator(root, { now: () => epoch })
  assert.equal(restored.hasAccessToken(), true)
  assert.equal(restored.hasValidApiKey(), true)
  assert.equal(readFileSync(join(root, 'access-token'), 'utf8'), 'synthetic-access')
  if (process.platform !== 'win32') assert.equal(statSync(join(root, 'access-token')).mode & 0o777, 0o600)
})
