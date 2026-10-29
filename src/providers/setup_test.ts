import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { Hono } from 'hono'
import { ConfigSchema, type Config } from '../config/schema.ts'
import { AppProviderConfigStore } from '../projects/config-store.ts'
import { ConfigStore } from '../config/store.ts'
import { configPlugin } from '../config/routes.ts'
import { CopilotAuthenticatorV2 } from './copilot-v2.ts'
import { COPILOT_VERIFICATION_URI } from './copilot.ts'
import { ProviderSetup } from './setup.ts'
import { providerPlugin } from './routes.ts'
import { createProvider, resolveProviderSettings } from './factory.ts'
import type { LLMProvider } from './provider.ts'

const epoch = 1_800_000_000_000
const key = { token: 'synthetic-copilot-token', expires_at: epoch / 1000 + 3600, directOAuth: { clientId: 'Ov23ctr1Udn5GokVCVJf', scope: 'copilot', expiryKnown: true } }
const device = {
  device_code: 'synthetic-private-device',
  user_code: 'ABCD-1234',
  verification_uri: COPILOT_VERIFICATION_URI,
  expires_in: 60,
  interval: 1,
}

function authHarness(options: { existing?: boolean; poll?: unknown; failWrite?: boolean; blockedStart?: boolean } = {}) {
  const files = new Map<string, string>()
  if (options.existing) files.set('api-key.json', JSON.stringify(key))
  const calls: string[] = []
  let releasePoll!: () => void
  const gate = new Promise<void>((resolve) => { releasePoll = resolve })
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
  const tokenDir = join(process.cwd(), '.test-data', 'virtual')
  const auth = new CopilotAuthenticatorV2(tokenDir, {
    now: () => epoch,
    storage: {
      read: (path) => files.get(relative(tokenDir, path)),
      write: (path, value) => {
        if (options.failWrite) throw new Error('synthetic-storage-secret')
        files.set(relative(tokenDir, path), value)
      },
      remove: (path) => { files.delete(relative(tokenDir, path)) },
    },
    wait: async (_ms, signal) => {
      await Promise.race([
        gate,
        new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      ])
      signal?.throwIfAborted()
    },
    fetch: (async (url) => {
      calls.push(String(url))
      if (String(url).endsWith('/device/code')) {
        if (options.blockedStart) await startGate
        return Response.json({ ...device, verification_uri: `${new URL(String(url)).origin}/login/device` })
      }
      if (String(url).endsWith('/access_token')) return Response.json(options.poll ?? { access_token: 'synthetic-access', scope: 'copilot' })
      return Response.json({ copilot_plan: 'individual' })
    }) as typeof fetch,
  })
  return { auth, files, calls, releasePoll: () => releasePoll(), releaseStart: () => releaseStart() }
}

function fixture(
  t: TestContext,
  raw: Record<string, unknown>,
  auth = authHarness(),
  request: typeof fetch = (async () => Response.json({ data: [] })) as typeof fetch,
  appStore = false,
) {
  const root = join(process.cwd(), '.test-data', `setup-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify(raw))
  let active = ConfigSchema.parse(raw)
  let now = epoch
  let applyCount = 0
  let failApply = false
  let activationGate: Promise<void> | undefined
  let releaseActivation: (() => void) | undefined
  const store = new (appStore ? AppProviderConfigStore : ConfigStore)({
    configPath: path, getConfig: () => active,
    onChanged: async (config) => {
      if (failApply) throw new Error('synthetic-activation-secret')
      applyCount++
      active = config
      await activationGate
    },
  })
  const setup = new ProviderSetup({ store, getConfig: () => active, auth: auth.auth, fetch: request, now: () => now })
  const app = new Hono()
  setup.plugin()(app)
  configPlugin({ store })(app)
  t.after(async () => {
    await setup.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    setup, store, app, auth, path,
    active: () => active,
    applyCount: () => applyCount,
    failApply: () => { failApply = true },
    pauseActivation: () => { activationGate = new Promise<void>(resolve => { releaseActivation = resolve }) },
    resumeActivation: () => { releaseActivation?.() },
    advanceTime: (ms: number) => { now += ms },
  }
}

async function settle(setup: ProviderSetup, id: string): Promise<void> {
  for (let i = 0; i < 20 && setup.get(id)?.state === 'pending'; i++) await setImmediate()
  assert.notEqual(setup.get(id)?.state, 'pending', 'Flow did not settle')
}

test('explicit sign-in requests a new device code even when cached credentials exist', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
  const response = await f.app.request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ reauthenticate: true }),
  })
  const login = await response.json()
  assert.equal(login.state, 'pending')
  assert.equal(login.userCode, device.user_code)
  assert(f.auth.files.has('api-key.json'), 'Existing credentials remain until the new flow succeeds or explicit sign-out')
  assert.deepEqual(f.auth.calls, ['https://github.com/login/device/code'])
})

test('local sign-out cancels login, clears credentials and allows a fresh device code', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
  f.auth.files.set('access-token', 'synthetic-access')
  const login = await f.setup.start(undefined, undefined, undefined, true)
  const before = f.auth.calls.length
  const response = await f.app.request('/api/auth/logout', { method: 'POST' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { authenticated: false })
  assert.equal(f.auth.calls.length, before, 'Sign-out does not revoke authorization remotely')
  assert.equal(f.auth.files.size, 0)
  assert.equal(f.setup.get(login.loginId), undefined, 'logout clears retained flows')
  assert.equal((await f.setup.status()).reason, 'missing_credentials')
  const next = await f.setup.start(undefined, undefined, undefined, true)
  assert.equal(next.state, 'pending')
  assert.equal(next.userCode, device.user_code)
})

test('Copilot sign-in defaults to Astra without replacing an explicit Copilot choice', async t => {
  for (const [raw, expected] of [
    [{}, 'gpt-6-astra@copilot'],
    [{ agent: { model: 'gpt-4o@openai' } }, 'gpt-6-astra@copilot'],
    [{ agent: { model: 'claude-sonnet-4.6' } }, 'claude-sonnet-4.6@copilot'],
  ] as const) {
    const f = fixture(t, raw)
    const login = await f.setup.start()
    f.auth.releasePoll()
    await settle(f.setup, login.loginId)
    assert.equal(f.setup.get(login.loginId)?.state, 'succeeded')
    assert.equal(f.active().agent.model, expected)
    assert.equal(f.active().agent.reasoningEffort, 'medium')
  }
})

function inventoryEnvironment(t: TestContext): void {
  const original = new Map<string, string | undefined>()
  for (const name of ['OPENAI', 'ANTHROPIC', 'DEEPSEEK', 'OPENROUTER', 'GEMINI', 'GROQ', 'STEPFUN', 'KIMI']) {
    const key = `${name}_API_KEY`
    original.set(key, process.env[key])
    delete process.env[key]
  }
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('configured inventory lists meaningful providers, selected model and safe fields without probes or writes', async (t) => {
  inventoryEnvironment(t)
  const f = fixture(t, {
    agent: { model: 'gpt-4o@openai', quickModel: 'unused@unconfigured', temperature: 0.2 },
    providers: {
      openai: { apiKey: 'synthetic-openai-key' },
      anthropic: { apiKey: 'synthetic-anthropic-key', quickModel: 'not-the-selected-model' },
      local: { baseUrl: 'http://127.0.0.1:11434/v1' },
      quick: { quickModel: 'small' },
      windows: { modelContextWindows: { large: 100_000 } },
      copilot: {},
      blank: {},
    },
  }, undefined, (async () => { assert.fail('Inventory must not probe provider readiness') }) as typeof fetch)
  t.mock.method(f.auth.auth, 'getApiKey', () => { assert.fail('Inventory must not refresh authentication') })
  t.mock.method(f.setup, 'status', () => { assert.fail('Inventory must not check status') })
  t.mock.method(f.store, 'read', () => { assert.fail('Inventory must use the active config') })
  t.mock.method(f.store, 'update', () => { assert.fail('Inventory must not save config') })
  const before = readFileSync(f.path, 'utf8')
  const active = structuredClone(f.active())
  const authFiles = [...f.auth.files]
  const response = await f.app.request('/api/provider/configured')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.deepEqual(body, { providers: [
    { provider: 'openai', authMode: 'api-key', hasApiKey: true, selected: true, model: 'gpt-4o@openai', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'anthropic', authMode: 'api-key', hasApiKey: true, selected: false, baseUrl: 'https://api.anthropic.com/v1' },
    { provider: 'copilot', authMode: 'copilot', host: 'github.com', hasApiKey: false, selected: false },
    { provider: 'local', authMode: 'none', hasApiKey: false, selected: false, baseUrl: 'http://127.0.0.1:11434/v1' },
    { provider: 'quick', authMode: 'api-key', hasApiKey: false, selected: false },
    { provider: 'windows', authMode: 'api-key', hasApiKey: false, selected: false },
  ] })
  assert.doesNotMatch(JSON.stringify(body), /synthetic-|ready|quickModel|modelContextWindows|temperature/)
  assert.deepEqual(await (await f.app.request('/api/provider/configured')).json(), body)
  assert.equal(readFileSync(f.path, 'utf8'), before)
  assert.deepEqual(f.active(), active)
  assert.deepEqual([...f.auth.files], authFiles)
  assert.equal(f.applyCount(), 0)
  assert.deepEqual(f.auth.calls, [])
})

test('configured inventory excludes default selections and blank placeholders but includes explicit Copilot', async (t) => {
  inventoryEnvironment(t)
  for (const raw of [
    {},
    { agent: { model: 'gpt-4o' } },
    { agent: { model: 'small@custom' }, providers: { custom: {} } },
    { providers: { openai: {}, anthropic: { apiKey: '', baseUrl: '', quickModel: '', modelContextWindows: {} }, blank: { apiKey: ' ', baseUrl: ' ', quickModel: ' ' } } },
  ]) {
    const f = fixture(t, raw)
    const before = readFileSync(f.path, 'utf8')
    assert.deepEqual(await (await f.app.request('/api/provider/configured')).json(), { providers: [] })
    assert.equal(readFileSync(f.path, 'utf8'), before)
    assert.equal(f.applyCount(), 0)
  }
  const f = fixture(t, { providers: { copilot: {} } })
  assert.deepEqual(await (await f.app.request('/api/provider/configured')).json(), { providers: [
    { provider: 'copilot', authMode: 'copilot', host: 'github.com', hasApiKey: false, selected: true, model: f.active().agent.model },
  ] })
})

test('configured inventory includes environment credentials, respects explicit empty keys and infers selection', async (t) => {
  inventoryEnvironment(t)
  process.env.OPENAI_API_KEY = 'synthetic-env-openai'
  process.env.GEMINI_API_KEY = 'synthetic-env-gemini'
  process.env.DEEPSEEK_API_KEY = 'synthetic-env-overridden'
  const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { deepseek: { apiKey: '' } } })
  assert.deepEqual(await (await f.app.request('/api/provider/configured')).json(), { providers: [
    { provider: 'openai', authMode: 'api-key', hasApiKey: true, selected: true, model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
    { provider: 'gemini', authMode: 'api-key', hasApiKey: true, selected: false, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  ] })
  assert.deepEqual(f.active().providers, { deepseek: { apiKey: '' } })
  assert.equal(f.applyCount(), 0)
  assert.deepEqual(f.auth.calls, [])
})

test('configured inventory includes nonselected cached Copilot without getting or refreshing credentials', async (t) => {
  inventoryEnvironment(t)
  for (const cache of ['access', 'valid-key', 'expired-key', 'empty'] as const) {
    const auth = authHarness({ existing: cache === 'valid-key' })
    if (cache === 'access') auth.files.set('access-token', 'synthetic-cached-access')
    if (cache === 'expired-key') auth.files.set('api-key.json', JSON.stringify({ ...key, expires_at: epoch / 1000 - 1 }))
    const f = fixture(t, { agent: { model: 'small@local' }, providers: { local: { baseUrl: 'http://localhost:11434/v1' } } }, auth)
    t.mock.method(auth.auth, 'getApiKey', () => { assert.fail('Inventory must not get an API key') })
    const before = [...auth.files]
    const { providers } = await (await f.app.request('/api/provider/configured')).json()
    assert.deepEqual(providers[0], { provider: 'local', authMode: 'none', hasApiKey: false, selected: true, model: 'small@local', baseUrl: 'http://localhost:11434/v1' })
    assert.deepEqual(providers.slice(1), cache === 'valid-key'
      ? [{ provider: 'copilot', authMode: 'copilot', host: 'github.com', hasApiKey: false, selected: false }]
      : [])
    assert.deepEqual([...auth.files], before)
    assert.deepEqual(auth.calls, [])
    assert.equal(f.applyCount(), 0)
  }
})

test('configured inventory omits malformed or credential-bearing base URLs without leaking config', async (t) => {
  inventoryEnvironment(t)
  for (const baseUrl of [
    'https://synthetic-user:synthetic-password@fixture.invalid/v1',
    'https://fixture.invalid/v1?token=synthetic-secret',
    'https://fixture.invalid/v1#synthetic-secret',
    'file:///synthetic-secret',
    'not-a-url-synthetic-secret',
  ]) {
    const f = fixture(t, {
      agent: { model: 'small@custom' },
      providers: { custom: { baseUrl, apiKey: 'synthetic-api-secret', quickModel: 'private-model', modelContextWindows: { private: 1000 } } },
    })
    assert.deepEqual(await (await f.app.request('/api/provider/configured')).json(), { providers: [
      { provider: 'custom', authMode: 'api-key', hasApiKey: true, selected: true, model: 'small@custom' },
    ] })
    assert.deepEqual(f.auth.calls, [])
  }
})

test('provider-aware readiness covers missing keys, local/custom endpoints and Copilot without OpenAI credentials', async (t) => {
  for (const [raw, provider, mode, ready] of [
    [{ agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: '' } } }, 'openai', 'api-key', false],
    [{ agent: { model: 'claude-sonnet-4-20250514' }, providers: { anthropic: { apiKey: '' } } }, 'anthropic', 'api-key', false],
    [{ agent: { model: 'qwen@local' }, providers: { local: { baseUrl: 'http://127.0.0.1:11434/v1' } } }, 'local', 'none', true],
    [{ agent: { model: 'qwen@custom' }, providers: { custom: { baseUrl: 'https://fixture.invalid/v1' } } }, 'custom', 'none', true],
    [{ agent: { model: 'qwen@openai' }, providers: { openai: { baseUrl: 'http://localhost:1234/v1', apiKey: '' } } }, 'openai', 'none', true],
    [{ agent: { model: 'claude-sonnet-4.6' }, providers: { copilot: {}, openai: { apiKey: '' } } }, 'copilot', 'copilot', true],
  ] as const) {
    const f = fixture(t, raw, authHarness({ existing: true }))
    const status = await f.setup.status()
    assert.equal(status.provider, provider)
    assert.equal(status.authMode, mode)
    assert.equal(status.ready, ready)
    assert.doesNotMatch(JSON.stringify(status), /synthetic-/)
  }
})

test('API-key readiness deduplicates checks and distinguishes revoked keys from network failures', async (t) => {
  for (const [code, reason] of [[401, 'invalid_credentials'], [403, 'invalid_credentials'], [503, 'network_error'], [200, undefined]] as const) {
    let requests = 0
    const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: 'synthetic-api-key' } } }, undefined,
      (async () => { requests++; return new Response('private-response', { status: code }) }) as typeof fetch)
    const [one, two] = await Promise.all([f.setup.status(), f.setup.status()])
    assert.deepEqual(one, two)
    assert.equal(one.reason, reason)
    assert.equal(one.ready, code === 200)
    assert.equal(requests, 1)
    assert.doesNotMatch(JSON.stringify(one), /synthetic-api-key|private-response/)
  }
})

test('explicit readiness recheck bypasses the cached result after credentials are revoked', async (t) => {
  let rejected = false
  const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: 'synthetic-api-key' } } }, undefined,
    (async () => new Response('', { status: rejected ? 401 : 200 })) as typeof fetch)
  assert.equal((await f.setup.status()).ready, true)
  rejected = true
  const response = await f.app.request('/api/provider/setup?refresh=true')
  assert.equal((await response.json()).reason, 'invalid_credentials')
  assert.equal((await f.setup.status()).ready, false)
})

test('login HTTP contract exposes no device secret, validates attempts and supports pre-response cancellation', async (t) => {
  const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } })
  const id = randomUUID()
  const cancelled = await f.app.request(`/api/auth/login/${id}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  const start = await f.app.request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ attemptId: id }),
  })
  assert.equal((await start.json()).state, 'cancelled')
  assert.equal(f.auth.calls.length, 0)
  const login = await f.app.request('/api/auth/login', { method: 'POST', body: '{}' })
  assert.equal(login.headers.get('cache-control'), 'no-store')
  const body = await login.json()
  assert.equal(body.state, 'pending')
  assert.doesNotMatch(JSON.stringify(body), /deviceCode|device_code|synthetic-/)
  const poll = await f.app.request(`/api/auth/login/${body.loginId}`)
  assert.equal((await poll.json()).userCode, 'ABCD-1234')
  assert.equal((await f.app.request(`/api/auth/login/${randomUUID()}`)).status, 404)
  assert.equal((await f.app.request('/api/auth/poll', { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await f.app.request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ device_code: 'not accepted' }),
  })).status, 400)
})

test('provider save validates, persists exact config path, preserves unrelated data and activates immediately', async (t) => {
  const f = fixture(t, {
    agent: { model: 'gpt-4o', temperature: 0.2 },
    providers: { openai: { apiKey: '' }, other: { baseUrl: 'http://localhost:1/v1' } },
    channels: { web: { enabled: true } },
    customFixture: { preserve: true },
  })
  const response = await f.app.request('/api/provider/setup', {
    method: 'POST',
    body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'synthetic-saved-key' }),
  })
  assert.equal(response.status, 200)
  const status = await response.json()
  assert.equal(status.ready, true)
  assert.equal(status.provider, 'deepseek')
  assert.doesNotMatch(JSON.stringify(status), /synthetic-saved-key/)
  assert.equal(f.active().providers.deepseek.apiKey, 'synthetic-saved-key')
  assert.equal(f.active().agent.model, 'deepseek-v4-flash@deepseek')
  const disk = JSON.parse(readFileSync(f.path, 'utf8'))
  assert.equal(disk.customFixture.preserve, true)
  assert.equal(disk.agent.temperature, 0.2)
  assert.equal(disk.channels.web.enabled, true)
  assert.equal(ConfigSchema.parse(disk).providers.deepseek.apiKey, 'synthetic-saved-key')
  assert.doesNotMatch(await (await f.app.request('/api/config')).text(), /synthetic-saved-key/)
  assert.equal(f.applyCount(), 1)
})

test('invalid input and failed live activation never report readiness or overwrite config', async (t) => {
  const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: '' } } })
  const original = readFileSync(f.path, 'utf8')
  for (const body of [
    { provider: 'openai', model: 'gpt-4o@copilot' },
    { provider: '__proto__', model: 'gpt-4o' },
    { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://user:secret@example.com' },
    { provider: 'openai', model: 'gpt-4o', apiKey: '__SHADOW_REDACTED__' },
    { provider: 'openai', model: 'gpt-4o', extra: 'not allowed' },
  ]) {
    const response = await f.app.request('/api/provider/setup', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(response.status, 400)
  }
  f.failApply()
  const response = await f.app.request('/api/provider/setup', {
    method: 'POST', body: JSON.stringify({ provider: 'openai', model: 'gpt-4.1', apiKey: 'synthetic-new-key' }),
  })
  assert.equal(response.status, 500)
  assert.doesNotMatch(await response.text(), /synthetic-/)
  assert.equal(readFileSync(f.path, 'utf8'), original)
  assert.equal(f.active().agent.model, 'gpt-4o')
})

test('model-only updates preserve credentials and endpoint; empty base URL restores provider default', async (t) => {
  const f = fixture(t, {
    agent: { model: 'gpt-4o@openai' },
    providers: { openai: { apiKey: 'synthetic-saved-key', baseUrl: 'https://fixture.invalid/v1' } },
  })
  const save = (body: Record<string, unknown>) => f.app.request('/api/provider/setup', {
    method: 'POST', body: JSON.stringify(body),
  })
  const changedModel = await save({ provider: 'openai', model: 'gpt-4.1' })
  assert.equal(changedModel.status, 200)
  assert.equal((await changedModel.json()).ready, true)
  assert.equal(f.active().providers.openai.apiKey, 'synthetic-saved-key')
  assert.equal(f.active().providers.openai.baseUrl, 'https://fixture.invalid/v1')
  const cleared = await save({ provider: 'openai', model: 'gpt-4.1', baseUrl: '' })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).baseUrl, 'https://api.openai.com/v1')
  assert.equal(f.active().providers.openai.baseUrl, undefined)
  assert.equal(f.active().providers.openai.apiKey, 'synthetic-saved-key')
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).providers.openai.baseUrl, undefined)
})

test('device login has one active start/poll, no wire secrets, and commits only after exchange', async (t) => {
  const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: '' } } })
  const id = randomUUID()
  const [first, duplicate] = await Promise.all([
    f.setup.start('claude-sonnet-4.6', id), f.setup.start('claude-sonnet-4.6', id),
  ])
  assert.deepEqual(first, duplicate)
  assert.equal(first.state, 'pending')
  assert.equal(first.userCode, device.user_code)
  assert.equal(first.verificationUri, COPILOT_VERIFICATION_URI)
  assert.equal(first.intervalMs, 1000)
  assert.equal(f.auth.calls.length, 1)
  assert.equal(f.auth.files.size, 0)
  assert.doesNotMatch(JSON.stringify(first), /synthetic-private-device|synthetic-access|synthetic-copilot-token/)
  const alias = await f.setup.start(undefined, randomUUID())
  assert.equal(alias.loginId, id)
  f.auth.releasePoll()
  await settle(f.setup, id)
  assert.equal(f.setup.get(id)?.state, 'succeeded')
  assert.equal(f.auth.calls.length, 3)
  assert.equal(f.auth.files.get('access-token'), 'synthetic-access')
  assert.equal(f.active().agent.model, 'claude-sonnet-4.6@copilot')
  assert.equal(f.applyCount(), 1)
  assert.equal((await f.setup.status()).ready, true)
  assert.doesNotMatch(JSON.stringify(f.setup.get(id)), /synthetic-|ABCD-1234/)
})

test('existing Copilot authorization saves selected provider/model before succeeded', async (t) => {
  const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: '' } } }, authHarness({ existing: true }))
  const result = await f.setup.start('gpt-4.1@copilot')
  assert.equal(result.state, 'succeeded')
  assert.equal(result.ready, true)
  assert.equal(f.active().agent.model, 'gpt-4.1@copilot')
  assert.equal(f.auth.calls.length, 1, 'Current OAuth authorization is explicitly rechecked')
})

test('denied/expired flows are recoverable and token storage failures cannot mark ready', async (t) => {
  for (const [options, state] of [
    [{ poll: { error: 'access_denied', error_description: 'synthetic-secret' } }, 'denied'],
    [{ poll: { error: 'expired_token' } }, 'expired'],
    [{ failWrite: true }, 'error'],
  ] as const) {
    const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } }, authHarness(options))
    const flow = await f.setup.start()
    f.auth.releasePoll()
    await settle(f.setup, flow.loginId)
    assert.equal(f.setup.get(flow.loginId)?.state, state)
    assert.equal(f.applyCount(), 0)
    assert.doesNotMatch(JSON.stringify(f.setup.get(flow.loginId)), /synthetic-secret|synthetic-storage-secret/)
  }
})

test('cancel before start is tombstoned and cancellation/shutdown abort active polls without committing', async (t) => {
  const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } })
  const cancelledId = randomUUID()
  f.setup.cancel(cancelledId)
  assert.equal((await f.setup.start(undefined, cancelledId)).state, 'cancelled')
  assert.equal(f.auth.calls.length, 0)
  const pending = await f.setup.start()
  assert.equal(f.setup.cancel(pending.loginId).state, 'cancelled')
  assert.equal(f.setup.cancel(pending.loginId).state, 'cancelled')
  const second = await f.setup.start()
  await f.setup.dispose()
  assert.equal(f.setup.get(second.loginId)?.state, 'cancelled')
  assert.equal(f.auth.files.size, 0)
  assert.equal(f.applyCount(), 0)
})

test('request aborted before start response cannot orphan a flow', async (t) => {
  const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } }, authHarness({ blockedStart: true }))
  const controller = new AbortController()
  const id = randomUUID()
  const pending = f.setup.start(undefined, id, controller.signal)
  await setImmediate()
  controller.abort()
  f.auth.releaseStart()
  const result = await pending
  assert.equal(result.state, 'cancelled')
  assert.equal(f.auth.calls.length, 1)
  assert.equal(f.auth.files.size, 0)
})

test('expired pending flows abort and terminal statuses/tombstones are collected after their TTL', async (t) => {
  const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } })
  const login = await f.setup.start()
  f.advanceTime(60_001)
  assert.equal(f.setup.get(login.loginId)?.state, 'expired')
  await setImmediate()
  assert.equal(f.setup.get(login.loginId)?.state, 'expired')
  assert.equal(f.auth.files.size, 0)
  const id = randomUUID()
  f.setup.cancel(id)
  assert.equal(f.setup.get(id)?.state, 'cancelled')
  f.advanceTime(10 * 60_000 + 1)
  assert.equal(f.setup.get(login.loginId), undefined)
  assert.equal(f.setup.get(id), undefined)
  assert.equal(f.applyCount(), 0)
})

test('ordinary config change invalidates a pending login before it can select a stale model', async (t) => {
  const f = fixture(t, { agent: { model: 'claude-sonnet-4.6' } })
  const login = await f.setup.start()
  await f.store.update((raw) => ({ ...raw, agent: { model: 'qwen@local' }, providers: { local: { baseUrl: 'http://localhost:1/v1' } } }))
  f.auth.releasePoll()
  await settle(f.setup, login.loginId)
  assert.equal(f.setup.get(login.loginId)?.state, 'cancelled')
  assert.equal(f.active().agent.model, 'qwen@local')
  assert.equal(f.auth.files.size, 0)
})

test('provider routes list live providers independently of primary readiness', async () => {
  let calls = 0
  let provider: LLMProvider = {
    name: 'first', listModels: async () => { calls++; return ['first'] },
    chat: async () => ({ content: '', toolCalls: [] }),
  }
  let ready = false
  const app = new Hono()
  providerPlugin(() => provider, async () => ({
    provider: 'openai', model: 'gpt-4o', authMode: 'api-key', ready, hasApiKey: ready,
  }))(app)
  assert.deepEqual((await (await app.request('/api/models')).json()).models, ['first'])
  assert.equal(calls, 1)
  ready = true
  provider = { ...provider, name: 'second', listModels: async () => ['second'] }
  assert.deepEqual((await (await app.request('/api/models')).json()).models, ['second'])
  assert.equal((await (await app.request('/v1/models')).json()).data[0].owned_by, 'second')
})

test('factory passes saved DeepSeek API key and base URL to its actual runtime implementation', async (t) => {
  const config = ConfigSchema.parse({
    agent: { model: 'deepseek-v4-flash' },
    providers: { deepseek: { apiKey: 'synthetic-config-key', baseUrl: 'http://localhost:1234/v1' } },
  })
  const settings = resolveProviderSettings(config, 'deepseek')
  assert.equal(settings.apiKey, 'synthetic-config-key')
  let request: { url: string; headers: Headers } | undefined
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    request = { url: String(url), headers: new Headers(init.headers) }
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  })
  const provider = createProvider('deepseek-v4-flash', config, 'deepseek')
  await provider.chat([{ role: 'user', content: 'hello' }], [], { model: 'deepseek-v4-flash' })
  assert.equal(request?.headers.get('authorization'), 'Bearer synthetic-config-key')
  assert.equal(request?.url, 'http://localhost:1234/v1/chat/completions')
})


test('GHE login HTTP selects its host through OAuth, persists it, and exposes no credentials', async t => {
  for (const host of ['msft.ghe.com', 'microsoft.ghe.com']) {
    const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
    const response = await f.app.request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ host }),
    })
    assert.equal(response.status, 200)
    const login = await response.json()
    assert.equal(login.state, 'pending', 'A cached github.com key must not bypass enterprise authorization')
    assert.equal(login.host, host)
    assert.equal(login.verificationUri, `https://${host}/login/device`)
    assert.equal(f.auth.auth.getHost(), 'github.com', 'Pending login does not switch active credentials')
    assert.deepEqual(f.auth.calls, [`https://${host}/login/device/code`])
    f.auth.releasePoll()
    await settle(f.setup, login.loginId)
    assert.equal(f.setup.get(login.loginId)?.state, 'succeeded')
    assert.equal(f.setup.get(login.loginId)?.host, host)
    assert.equal(f.auth.auth.getHost(), host)
    assert.deepEqual(f.auth.calls, [
      `https://${host}/login/device/code`,
      `https://${host}/login/oauth/access_token`,
      `https://api.${host}/copilot_internal/user`,
    ])
    const status = await f.setup.status()
    assert.equal(status.host, host)
    assert.equal(status.ready, true)
    assert.equal(f.setup.configured().find(p => p.provider === 'copilot')?.host, host)
    assert.doesNotMatch(JSON.stringify({ login, status, terminal: f.setup.get(login.loginId) }), /synthetic-|access_token|device_code/)
  }
})

test('invalid enterprise hosts are rejected before any network or credential changes', async t => {
  const f = fixture(t, {})
  for (const host of ['', 'ghe.com', 'evil.example', 'msft.ghe.com.evil.example', 'a.b.ghe.com',
    'http://msft.ghe.com', 'msft.ghe.com:443', 'https://user@msft.ghe.com',
    'msft.ghe.com/path', 'msft.ghe.com?query', 'msft.ghe.com#fragment', '-bad.ghe.com']) {
    const response = await f.app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ host }) })
    assert.equal(response.status, 400, host)
  }
  assert.deepEqual(f.auth.calls, [])
  assert.equal(f.auth.files.size, 0)
})

test('pending sign-in and attempt aliases never silently reuse another enterprise host', async t => {
  const f = fixture(t, {})
  const login = await f.setup.start(undefined, undefined, undefined, true, 'msft.ghe.com')
  for (const attemptId of [login.loginId, randomUUID()]) {
    const response = await f.app.request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ attemptId, host: 'microsoft.ghe.com' }),
    })
    assert.equal(response.status, 409)
  }
  const sameHost = await f.setup.start(undefined, undefined, undefined, true, 'msft.ghe.com')
  assert.equal(sameHost.loginId, login.loginId)
  assert.equal(f.auth.calls.length, 1)
  f.setup.cancel(login.loginId)
  assert.equal(f.setup.get(login.loginId)?.host, 'msft.ghe.com')
  assert.equal(f.auth.auth.getHost(), 'github.com')
  const next = await f.setup.start(undefined, undefined, undefined, true, 'microsoft.ghe.com')
  assert.equal(next.host, 'microsoft.ghe.com')
  assert.equal(next.verificationUri, 'https://microsoft.ghe.com/login/device')
})

test('failed enterprise authorization preserves the previously active github.com credentials', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({
    existing: true, poll: { error: 'access_denied' },
  }))
  const before = [...f.auth.files]
  assert.equal((await f.setup.status()).host, 'github.com')
  const login = await f.setup.start(undefined, undefined, undefined, true, 'msft.ghe.com')
  f.auth.releasePoll()
  await settle(f.setup, login.loginId)
  assert.equal(f.setup.get(login.loginId)?.state, 'denied')
  assert.equal(f.setup.get(login.loginId)?.host, 'msft.ghe.com')
  assert.equal(f.auth.auth.getHost(), 'github.com')
  assert.deepEqual([...f.auth.files], before)
  assert.equal((await f.setup.status()).ready, true)
  assert.equal(f.applyCount(), 0)
})


test('enterprise host activation rolls back if provider config cannot be activated', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
  const before = [...f.auth.files]
  const config = readFileSync(f.path, 'utf8')
  f.failApply()
  const login = await f.setup.start(undefined, undefined, undefined, true, 'msft.ghe.com')
  f.auth.releasePoll()
  await settle(f.setup, login.loginId)
  assert.equal(f.setup.get(login.loginId)?.state, 'error')
  assert.equal(f.auth.auth.getHost(), 'github.com')
  assert.deepEqual([...f.auth.files], before)
  assert.equal(readFileSync(f.path, 'utf8'), config)
  assert.equal(f.applyCount(), 0)
})


test('readiness caches are keyed by active Copilot host even without a project config change', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } })
  let host = 'github.com'
  let probes = 0
  t.mock.method(f.auth.auth, 'getHost', () => host)
  t.mock.method(f.auth.auth, 'getApiKey', async () => { probes++; return 'synthetic-token' })
  assert.equal((await f.setup.status()).host, 'github.com')
  host = 'msft.ghe.com'
  assert.equal((await f.setup.status()).host, 'msft.ghe.com')
  assert.equal((await f.setup.status()).host, 'msft.ghe.com')
  assert.equal(probes, 2)
})


test('cancel or sign-out during asynchronous activation cannot be overwritten by login success', async t => {
  for (const signOut of [false, true]) {
    const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
    const before = [...f.auth.files]
    f.pauseActivation()
    const login = await f.setup.start(undefined, undefined, undefined, true, 'msft.ghe.com')
    f.auth.releasePoll()
    for (let i = 0; i < 20 && f.applyCount() === 0; i++) await setImmediate()
    assert.equal(f.applyCount(), 1, 'Activation must be paused after credential persistence')
    assert.equal(f.auth.auth.getHost(), 'msft.ghe.com')
    if (signOut) f.setup.signOut()
    else f.setup.cancel(login.loginId)
    assert.equal(f.setup.get(login.loginId)?.state, 'cancelled')
    f.resumeActivation()
    await f.setup.dispose()
    assert.equal(f.setup.get(login.loginId)?.state, 'cancelled')
    if (signOut) {
      assert.equal(f.auth.auth.getHost(), 'msft.ghe.com')
      assert.equal(f.auth.auth.hasAccessToken(), false)
      assert.equal(f.auth.auth.hasValidApiKey(), false, 'Rollback must not restore credentials removed by sign-out')
    } else {
      assert.equal(f.auth.auth.getHost(), 'github.com')
      assert.deepEqual([...f.auth.files], before)
    }
  }
})

test('cached-credential login cannot report success after sign-out during activation', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@copilot' } }, authHarness({ existing: true }))
  f.pauseActivation()
  const id = randomUUID()
  const pending = f.setup.start(undefined, id)
  for (let i = 0; i < 20 && f.applyCount() === 0; i++) await setImmediate()
  assert.equal(f.applyCount(), 1)
  f.setup.signOut()
  f.resumeActivation()
  assert.equal((await pending).state, 'cancelled')
  assert.equal(f.setup.get(id)?.state, 'cancelled')
  assert.equal(f.auth.auth.hasValidApiKey(), false)
})


test('Agnes setup saves both documented Flash IDs using the built-in endpoint and keeps credentials private', async (t) => {
  let requests = 0
  const f = fixture(t, { agent: { model: 'gpt-4o' } }, undefined, (async (url, init) => {
    requests++
    assert.equal(String(url), 'https://apihub.agnes-ai.com/v1/models')
    assert.equal(init?.method ?? 'GET', 'GET')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-agnes-key')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.body, undefined, 'Setup must not send an inference request')
    return Response.json({ data: [] })
  }) as typeof fetch)
  for (const model of ['agnes-3.0-flash', 'agnes-2.5-flash']) {
    const response = await f.app.request('/api/provider/setup', {
      method: 'POST', body: JSON.stringify({ provider: 'agnes', model, apiKey: 'synthetic-agnes-key' }),
    })
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.ready, true)
    assert.equal(status.baseUrl, 'https://apihub.agnes-ai.com/v1')
    assert.equal(f.active().agent.model, `${model}@agnes`)
    assert.equal(f.active().providers.agnes.apiKey, 'synthetic-agnes-key')
    assert.doesNotMatch(JSON.stringify(status), /synthetic-agnes-key/)
    const inventory = await (await f.app.request('/api/provider/configured')).json()
    assert.ok(inventory.providers.some((item: any) => item.provider === 'agnes' && item.selected))
    assert.doesNotMatch(JSON.stringify(inventory), /synthetic-agnes-key/)
  }
  assert.equal(requests, 2)
})

test('Agnes rejected credentials and denied permissions block saving without leaking upstream responses', async (t) => {
  for (const [code, reason] of [[401, 'invalid_credentials'], [403, 'permission_denied'], [503, 'network_error']] as const) {
    let requests = 0
    const f = fixture(t, { agent: { model: 'gpt-4o' }, providers: { openai: { apiKey: '' } } }, undefined,
      (async (url, init) => {
        requests++
        assert.equal(String(url), 'https://apihub.agnes-ai.com/v1/models')
        assert.equal(init?.method ?? 'GET', 'GET')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-rejected-key')
        assert.equal(init?.body, undefined)
        return new Response('synthetic-private-upstream-response', { status: code })
      }) as typeof fetch)
    const before = readFileSync(f.path, 'utf8')
    const active = f.active()
    const response = await f.app.request('/api/provider/setup', {
      method: 'POST', body: JSON.stringify({ provider: 'agnes', model: 'agnes-3.0-flash', apiKey: 'synthetic-rejected-key' }),
    })
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.ready, false)
    assert.equal(status.reason, reason)
    assert.doesNotMatch(JSON.stringify(status), /synthetic-/)
    assert.equal(requests, 1, 'No billable inference or credential-validation fallback')
    assert.equal(readFileSync(f.path, 'utf8'), before)
    assert.equal(f.active(), active)
    assert.equal(f.applyCount(), 0)
  }
})


test('instance metadata creation and rename preserve default and secrets; type cannot change', async t => {
  const f = fixture(t, { agent: { model: 'deepseek-flash@deepseek' }, providers: { deepseek: { apiKey: 'synthetic-first' } } })
  const metadata = (body: unknown) => f.app.request('/api/provider/instances', { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await metadata({ provider: 'work', type: 'deepseek', name: 'Work' })).status, 200)
  assert.equal(f.active().agent.model, 'deepseek-flash@deepseek')
  assert.equal((await f.setup.save({ provider: 'work', type: 'deepseek', model: 'deepseek-flash', apiKey: 'synthetic-second' })).ready, true)
  assert.equal((await metadata({ provider: 'work', type: 'deepseek', name: 'Renamed' })).status, 200)
  assert.equal(f.active().providers.work.apiKey, 'synthetic-second')
  assert.equal(f.active().providers.deepseek.apiKey, 'synthetic-first')
  assert.equal(f.active().providers.work.name, 'Renamed')
  assert.equal((await metadata({ provider: 'work', type: 'copilot', name: 'Wrong type' })).status, 409)
  assert.equal(f.active().providers.work.type, 'deepseek')
})

test('Copilot login, cancel, sign-out and status routes are scoped to the instance', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@work' }, providers: { work: { type: 'copilot' }, personal: { type: 'copilot' } } })
  const start = async (provider: string, attemptId: string) => {
    const response = await f.app.request(`/api/auth/login?provider=${provider}`, { method: 'POST', body: JSON.stringify({ attemptId, reauthenticate: true }) })
    assert.equal(response.status, 200)
    return await response.json()
  }
  const id = randomUUID()
  assert.equal((await start('work', id)).state, 'pending')
  assert.equal((await start('personal', id)).state, 'pending', 'same client attempt ID is scoped per instance')
  await f.app.request(`/api/auth/login/${id}?provider=work`, { method: 'DELETE' })
  assert.equal((await (await f.app.request(`/api/auth/login/${id}?provider=work`)).json()).state, 'cancelled')
  assert.equal((await (await f.app.request(`/api/auth/login/${id}?provider=personal`)).json()).state, 'pending')
  f.auth.releasePoll()
  for (let i = 0; i < 20; i++) await setImmediate()
  assert.equal((await (await f.app.request(`/api/auth/login/${id}?provider=personal`)).json()).state, 'succeeded')
  assert.ok(f.auth.auth.forInstance('personal').hasAccessToken())
  assert.equal(f.auth.auth.forInstance('work').hasAccessToken(), false)
  await f.app.request('/api/auth/logout?provider=work', { method: 'POST' })
  assert.ok(f.auth.auth.forInstance('personal').hasAccessToken())
  const missing = await f.app.request('/api/auth/login?provider=missing', { method: 'POST', body: '{}' })
  assert.equal(missing.status, 409)
})


test('Main App store keeps defaults while concurrent Copilot accounts commit independently', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@work' }, providers: { work: { type: 'copilot' }, personal: { type: 'copilot' } } }, authHarness(), undefined, true)
  const ids = [randomUUID(), randomUUID()]
  for (const [index, provider] of ['work', 'personal'].entries()) {
    const response = await f.app.request(`/api/auth/login?provider=${provider}`, { method: 'POST', body: JSON.stringify({ attemptId: ids[index], reauthenticate: true }) })
    assert.equal((await response.json()).state, 'pending')
  }
  f.auth.releasePoll()
  for (let i = 0; i < 30; i++) await setImmediate()
  for (const [index, provider] of ['work', 'personal'].entries()) {
    const status = await (await f.app.request(`/api/auth/login/${ids[index]}?provider=${provider}`)).json()
    assert.equal(status.state, 'succeeded')
  }
  assert.equal(f.active().agent.model, 'gpt-4o@work')
  assert.equal((await f.setup.status()).ready, true)
  await f.app.request('/api/auth/logout?provider=work', { method: 'POST' })
  assert.equal((await f.setup.status()).ready, false, 'selected-account readiness does not reuse pre-logout cache')
  assert.ok(f.auth.auth.forInstance('personal').hasValidApiKey())
  assert.equal(f.active().agent.model, 'gpt-4o@work', 'sign-out must not select another account')
})


test('logout removes target provider without falling back or changing other accounts', async t => {
  const f = fixture(t, { agent: { model: 'gpt-4o@work' }, providers: { work: { type: 'copilot' }, personal: { type: 'copilot' }, openai: { apiKey: 'synthetic-other' } } }, authHarness(), undefined, true)
  const response = await f.app.request('/api/auth/logout?provider=work', { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal(f.active().providers.work, undefined)
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).providers.work, undefined)
  assert.equal(f.active().providers.personal.type, 'copilot')
  assert.equal(f.active().providers.openai.apiKey, 'synthetic-other')
  assert.equal(f.setup.configured().some(item => item.provider === 'work'), false)
  assert.equal(f.active().agent.model, 'gpt-4o@work')
  const status = await f.setup.status()
  assert.equal(status.provider, 'work')
  assert.equal(status.ready, false)
  assert.equal(status.reason, 'missing_base_url')
  assert.throws(() => createProvider('gpt-4o', f.active(), 'work'), /Unknown provider instance/)
})


test('logout clears current profile host credentials and model cache only', async t => {
  const f = fixture(t, { providers: { work: { type: 'copilot' }, personal: { type: 'copilot' } } })
  const work = f.auth.auth.forInstance('work'), personal = f.auth.auth.forInstance('personal')
  work.persistGrant({ host: 'octocat.ghe.com', accessToken: key.token, apiKey: key })
  work.writeModelsCache([{ id: 'enterprise-model' }])
  work.persistGrant({ host: 'github.com', accessToken: key.token, apiKey: key })
  work.writeModelsCache([{ id: 'work-model' }])
  personal.persistGrant({ accessToken: key.token, apiKey: key })
  personal.writeModelsCache([{ id: 'personal-model' }])
  const retained = new Map([...f.auth.files].filter(([name]) => name.includes('octocat.ghe.com') || name.includes(join('instances', 'personal'))))
  assert.ok(retained.size > 0)
  assert.equal((await f.app.request('/api/auth/logout?provider=work', { method: 'POST' })).status, 200)
  assert.equal(work.hasAccessToken(), false)
  assert.equal(work.hasValidApiKey(), false)
  assert.equal(work.readModelsCache(), null)
  assert.equal(personal.hasAccessToken(), true)
  assert.deepEqual(personal.readModelsCache()?.models, [{ id: 'personal-model' }])
  for (const [name, value] of retained) assert.equal(f.auth.files.get(name), value)
})
