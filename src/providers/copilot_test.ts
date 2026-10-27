import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basename, join, relative } from 'node:path'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  COPILOT_VERIFICATION_URI,
  CopilotAuthenticator,
  CopilotProvider,
  CopilotAuthError,
  type CopilotAuthStorage,
} from './copilot.ts'
import { normalizeCopilotHost, copilotVerificationUri } from '../shared/copilot-host.ts'

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
  const root = join(process.cwd(), '.test-data', 'virtual-auth')
  const fileKey = (path: string) => relative(root, path).replaceAll('\\', '/')
  const storage: CopilotAuthStorage = {
    read: (path) => files.get(fileKey(path)),
    write: (path, value) => { files.set(fileKey(path), value) },
    remove: (path) => { files.delete(fileKey(path)) },
  }
  const auth = new CopilotAuthenticator(root, {
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
  return { auth, calls, waits, files, storage, root }
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

const enterpriseHost = 'msft.ghe.com'
const enterpriseKey = { ...keyResponse, token: 'enterprise-key', endpoints: { api: 'https://copilot-api.msft.ghe.com' } }
const enterpriseGrant = { host: enterpriseHost, accessToken: 'enterprise-access', apiKey: enterpriseKey }
const cancelled = (error: unknown) => error instanceof CopilotAuthError && error.code === 'cancelled'

test('host normalization is a closed hostname-only allowlist', () => {
  for (const [input, output] of [[undefined, 'github.com'], [' GitHub.COM ', 'github.com'],
    ['MSFT.GHE.COM', enterpriseHost], ['microsoft.ghe.com', 'microsoft.ghe.com'], ['a-b.ghe.com', 'a-b.ghe.com']]) {
    assert.equal(normalizeCopilotHost(input), output)
  }
  for (const input of [null, false, 5, {}, '', 'ghe.com', 'www.github.com', 'github.internal',
    'https://msft.ghe.com', 'msft.ghe.com/', 'msft.ghe.com:443', 'msft.ghe.com.',
    'msft.ghe.com?x', 'msft.ghe.com#x', 'user@msft.ghe.com', 'a.b.ghe.com',
    '-a.ghe.com', 'a-.ghe.com', 'a_b.ghe.com', 'msft.ghe.com.evil.test',
    'localhost', '127.0.0.1', 'xn--abc.ghe.com', 'mſft.ghe.com', 'a'.repeat(64) + '.ghe.com']) {
    assert.throws(() => normalizeCopilotHost(input), Error, String(input))
  }
  assert.equal(copilotVerificationUri('microsoft.ghe.com'), 'https://microsoft.ghe.com/login/device')
})

test('enterprise OAuth start, poll and exchange stay on the selected host and use the VS Code client', async () => {
  for (const host of [enterpriseHost, 'microsoft.ghe.com']) {
    const h = harness([
      { ...deviceResponse, verification_uri: copilotVerificationUri(host) },
      { access_token: 'enterprise-access' },
      { ...enterpriseKey, endpoints: { api: `https://copilot-api.${host}` } },
    ], { 'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse) })
    const device = await h.auth.startDeviceLogin(undefined, host)
    assert.equal(device.host, host)
    assert.equal(h.auth.getHost(), 'github.com')
    const grant = await h.auth.completeDeviceLogin(device)
    assert.equal(grant.host, host)
    assert.equal(h.auth.getHost(), 'github.com')
    assert.deepEqual(h.calls.map(c => c.url), [
      `https://${host}/login/device/code`, `https://${host}/login/oauth/access_token`,
      `https://api.${host}/copilot_internal/v2/token`,
    ])
    for (const call of h.calls.slice(0, 2)) {
      assert.equal(JSON.parse(call.init!.body as string).client_id, '01ab8ac9400c4e429b23')
      assert.equal(new Headers(call.init?.headers).get('authorization'), null)
    }
    assert.equal(new Headers(h.calls[2].init?.headers).get('authorization'), 'token enterprise-access')
    assert(h.calls.every(c => c.init?.redirect === 'error'))
    h.auth.persistGrant(grant)
    assert.equal(h.auth.getHost(), host)
    assert.equal(h.files.get('access-token'), 'legacy-access')
    assert.equal(h.files.get(`hosts/${host}/access-token`), 'enterprise-access')
    assert.equal(await h.auth.getApiKey(), 'enterprise-key')
    assert.equal(h.auth.getApiBase(), `https://copilot-api.${host}`)
    const restored = new CopilotAuthenticator(h.root, { storage: h.storage, now: () => epoch })
    assert.equal(restored.getHost(), host)
    assert.equal(restored.hasValidApiKey(), true)
  }
})

test('unsupported hosts and mismatched device verification URIs fail before credential requests', async () => {
  const h = harness([])
  for (const host of ['https://msft.ghe.com', 'github.example', 'ghe.com', 'a.b.ghe.com']) {
    await assert.rejects(h.auth.startDeviceLogin(undefined, host), CopilotAuthError)
  }
  await assert.rejects(h.auth.completeDeviceLogin({
    host: enterpriseHost, deviceCode: 'private', userCode: 'ABCD-1234',
    verificationUri: COPILOT_VERIFICATION_URI, expiresAt: epoch + 60_000, intervalMs: 1000,
  }), CopilotAuthError)
  assert.equal(h.calls.length, 0)
  for (const uri of [COPILOT_VERIFICATION_URI, 'https://other.ghe.com/login/device',
    'https://msft.ghe.com/login/device?x', 'https://msft.ghe.com:443/login/device']) {
    const bad = harness([{ ...deviceResponse, verification_uri: uri }])
    await assert.rejects(bad.auth.startDeviceLogin(undefined, enterpriseHost), CopilotAuthError)
  }
})

test('token endpoint validation prevents cross-host routing, suffix tricks, ports and paths', async () => {
  for (const host of ['github.com', enterpriseHost]) {
    const invalid = ['https://evil.example', 'https://copilot-api.other.ghe.com',
      'https://copilot-api.msft.ghe.com.evil.example', 'http://copilot-api.msft.ghe.com',
      'https://user@copilot-api.msft.ghe.com', 'https://copilot-api.msft.ghe.com:443',
      'https://copilot-api.msft.ghe.com:8443', 'https://copilot-api.msft.ghe.com/path',
      'https://copilot-api.msft.ghe.com?x', 'https://copilot-api.msft.ghe.com#x',
      host === 'github.com' ? enterpriseKey.endpoints.api : 'https://api.githubcopilot.com']
    for (const api of invalid) {
      const h = harness([
        { ...deviceResponse, verification_uri: copilotVerificationUri(host) },
        { access_token: 'selected-access' }, { ...keyResponse, endpoints: { api } },
      ])
      await assert.rejects(h.auth.completeDeviceLogin(await h.auth.startDeviceLogin(undefined, host)), CopilotAuthError)
      assert.equal(h.files.size, 0, api)
    }
  }
  for (const api of ['https://api.githubcopilot.com:443', 'https://api.githubcopilot.com/path',
    'https://api.githubcopilot.com?x', 'https://api.githubcopilot.com#x']) {
    const h = harness([], { 'api-key.json': JSON.stringify({ ...keyResponse, endpoints: { api } }) })
    assert.equal(h.auth.hasValidApiKey(), false)
  }
})

test('active-host-specific defaults, caches, refresh and signout preserve other hosts', async () => {
  const h = harness([enterpriseKey, { ...deviceResponse, verification_uri: copilotVerificationUri(enterpriseHost) }], {
    'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse),
    'models.json': JSON.stringify({ models: [{ id: 'legacy-model' }], fetchedAt: epoch }),
  })
  h.auth.persistGrant({ ...enterpriseGrant, apiKey: keyResponse })
  assert.equal(h.auth.getApiBase(), enterpriseKey.endpoints.api, 'fallback is enterprise, never github.com')
  assert.equal(h.auth.readModelsCache(), null)
  h.auth.writeModelsCache([{ id: 'enterprise-model' }])
  assert.equal(h.auth.readModelsCache()?.models[0].id, 'enterprise-model')
  h.auth.clearApiKey()
  assert.equal(await h.auth.getApiKey(), 'enterprise-key')
  assert.equal(h.calls[0].url, 'https://api.msft.ghe.com/copilot_internal/v2/token')
  assert.equal(new Headers(h.calls[0].init?.headers).get('authorization'), 'token enterprise-access')
  assert.equal((await h.auth.startDeviceLogin()).host, enterpriseHost)
  h.auth.signOut()
  assert.equal(h.auth.getHost(), enterpriseHost)
  assert.equal(h.auth.hasAccessToken(), false)
  assert.equal(h.auth.readModelsCache(), null)
  assert.equal(h.files.get('active-host'), enterpriseHost)
  assert.equal(h.files.get('access-token'), 'legacy-access')
  assert.equal(JSON.parse(h.files.get('models.json')!).models[0].id, 'legacy-model')
})

test('hostless legacy grants and devices never silently inherit an enterprise host', async () => {
  const h = harness([{ access_token: 'legacy-new' }, keyResponse])
  h.auth.persistGrant(enterpriseGrant)
  const grant = await h.auth.completeDeviceLogin({
    deviceCode: 'legacy-device', userCode: 'ABCD-1234', verificationUri: COPILOT_VERIFICATION_URI,
    expiresAt: epoch + 60_000, intervalMs: 1000,
  })
  assert.equal(grant.host, 'github.com')
  assert.equal(h.calls[0].url, 'https://github.com/login/oauth/access_token')
  h.auth.persistGrant({ accessToken: 'legacy-new', apiKey: keyResponse })
  assert.equal(h.auth.getHost(), 'github.com')
  assert.equal(h.files.get('hosts/msft.ghe.com/access-token'), 'enterprise-access')
})

test('failed enterprise grant storage rolls back target files and persisted active selection', () => {
  for (const failName of ['access-token', 'api-key.json', 'models.json', 'active-host']) {
    const h = harness([], { 'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse),
      'hosts/msft.ghe.com/access-token': 'previous-enterprise-access',
      'hosts/msft.ghe.com/models.json': JSON.stringify({ models: [{ id: 'prior' }], fetchedAt: epoch }),
    })
    const before = new Map(h.files)
    let failed = false
    const write = h.storage.write, remove = h.storage.remove
    h.storage.write = (path, value) => {
      if (!failed && basename(path) === failName) { failed = true; throw new Error('synthetic storage failure') }
      write(path, value)
    }
    h.storage.remove = (path) => {
      if (!failed && basename(path) === failName) { failed = true; throw new Error('synthetic storage failure') }
      remove(path)
    }
    assert.throws(() => h.auth.persistGrant(enterpriseGrant), (e) => e instanceof CopilotAuthError && e.code === 'storage')
    assert.equal(h.auth.getHost(), 'github.com')
    assert.deepEqual(h.files, before, failName)
  }
})

test('grant rollback is idempotent, restores target models, and cannot undo a newer sign-in', () => {
  const h = harness([], { 'access-token': 'legacy', 'models.json': '{}' })
  const before = new Map(h.files)
  const rollback = h.auth.persistGrant(enterpriseGrant)
  rollback()
  rollback()
  assert.deepEqual(h.files, before)
  assert.equal(h.auth.getHost(), 'github.com')
  const staleRollback = h.auth.persistGrant(enterpriseGrant)
  h.auth.persistGrant({ ...enterpriseGrant, accessToken: 'newer' })
  staleRollback()
  assert.equal(h.files.get('hosts/msft.ghe.com/access-token'), 'newer')
  assert.equal(h.auth.getHost(), enterpriseHost)
})

test('concurrent old-host refreshes cannot write, clear, or serve credentials under a new active host', async () => {
  for (const response of [Response.json(keyResponse), new Response(null, { status: 401 })]) {
    const pending = Promise.withResolvers<Response>()
    const h = harness([], { 'access-token': 'legacy-access' })
    const auth = new CopilotAuthenticator(h.root, {
      storage: h.storage, now: () => epoch, fetch: async () => pending.promise,
    })
    const oldRefresh = auth.getApiKey()
    auth.persistGrant(enterpriseGrant)
    assert.equal(await auth.getApiKey(), 'enterprise-key', 'new host does not share old host refresh')
    pending.resolve(response)
    await assert.rejects(oldRefresh, CopilotAuthError)
    assert.equal(h.files.get('api-key.json'), undefined)
    assert.equal(await auth.getApiKey(), 'enterprise-key')
  }
})

test('failed enterprise exchange does not clear the active github.com key', async () => {
  const h = harness([
    { ...deviceResponse, verification_uri: copilotVerificationUri(enterpriseHost) },
    { access_token: 'unentitled-enterprise-access' }, new Response(null, { status: 403 }),
  ], { 'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse) })
  await assert.rejects(h.auth.completeDeviceLogin(await h.auth.startDeviceLogin(undefined, enterpriseHost)), CopilotAuthError)
  assert.equal(h.auth.getHost(), 'github.com')
  assert.equal(await h.auth.getApiKey(), keyResponse.token)
})

test('provider model catalog cache lasts ten minutes without extending on reads', async (t) => {
  const h = harness([], { 'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse) })
  const provider = new CopilotProvider(h.auth)
  let now = epoch
  let requests = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return Response.json({ data: [{ id: `model-${requests}` }] })
  })
  assert.deepEqual(await provider.listModels(), ['model-1'])
  now = epoch + 5 * 60_000
  assert.deepEqual(await provider.listModels(), ['model-1'])
  now = epoch + 10 * 60_000 - 1
  assert.deepEqual(await provider.listModels(), ['model-1'])
  assert.equal(requests, 1)
  now = epoch + 10 * 60_000
  assert.deepEqual(await provider.listModels(), ['model-2'])
  assert.equal(requests, 2)
})

test('provider model caches are reset on host switch and requests pair credentials with the same host', async (t) => {
  const h = harness([], { 'access-token': 'legacy-access', 'api-key.json': JSON.stringify(keyResponse) })
  const provider = new CopilotProvider(h.auth)
  const calls: Array<{ url: string; auth: string | null }> = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    return Response.json({ data: [{ id: h.auth.getHost() === 'github.com' ? 'legacy-model' : 'enterprise-model' }] })
  })
  assert.deepEqual(await provider.listModels(), ['legacy-model'])
  h.auth.persistGrant(enterpriseGrant)
  assert.deepEqual(await provider.listModels(), ['enterprise-model'])
  assert.deepEqual(calls, [
    { url: 'https://api.githubcopilot.com/models', auth: `Bearer ${keyResponse.token}` },
    { url: `${enterpriseKey.endpoints.api}/models`, auth: 'Bearer enterprise-key' },
  ])
  assert.equal(h.auth.readModelsCache()?.models[0].id, 'enterprise-model')
})

test('in-flight old-host model response is neither returned nor cached under a newly selected host', async (t) => {
  const h = harness([], { 'api-key.json': JSON.stringify(keyResponse) })
  const provider = new CopilotProvider(h.auth)
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); return pending.promise })
  const listing = provider.listModels()
  await entered.promise
  h.auth.persistGrant(enterpriseGrant)
  pending.resolve(Response.json({ data: [{ id: 'stale-github-model' }] }))
  await assert.rejects(listing, cancelled)
  assert.equal(h.auth.readModelsCache(), null)
})

test('host switch between getting a cached key and resolving it prevents any model/chat request', async (t) => {
  const h = harness([], { 'api-key.json': JSON.stringify(keyResponse) })
  const provider = new CopilotProvider(h.auth)
  const getApiKey = h.auth.getApiKey.bind(h.auth)
  t.mock.method(h.auth, 'getApiKey', async () => {
    const key = await getApiKey()
    h.auth.persistGrant(enterpriseGrant)
    return key
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not pair old key with new host'))
  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'synthetic-model' }), cancelled)
})

test('enterprise disk files are private and corrupt active-host state never falls back to legacy credentials', (t) => {
  const root = join(process.cwd(), '.test-data', `copilot-enterprise-${randomUUID()}`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const auth = new CopilotAuthenticator(root, { now: () => epoch })
  auth.persistGrant(enterpriseGrant)
  const restored = new CopilotAuthenticator(root, { now: () => epoch })
  assert.equal(restored.getHost(), enterpriseHost)
  assert.equal(restored.hasValidApiKey(), true)
  assert.equal(readFileSync(join(root, 'hosts', enterpriseHost, 'access-token'), 'utf8'), enterpriseGrant.accessToken)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'hosts', enterpriseHost, 'access-token')).mode & 0o777, 0o600)
    assert.equal(statSync(join(root, 'hosts', enterpriseHost)).mode & 0o777, 0o700)
    assert.equal(statSync(join(root, 'active-host')).mode & 0o777, 0o600)
  }
  assert.throws(() => harness([], { 'active-host': 'evil.example', 'access-token': 'legacy' }), CopilotAuthError)
})
