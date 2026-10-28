import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { ConfigStore } from '../config/store.ts'
import { CopilotProvider, CopilotAuthError } from './copilot.ts'
import { Hono } from 'hono'
import { CopilotAuthenticatorV2, CopilotProviderV2 } from './copilot-v2.ts'
import { createProvider, createAggregatedProvider, copilotAuthForInstance, resolveProviderSettings } from './factory.ts'
import { ProviderSetup } from './setup.ts'

function fixture() {
  const files = new Map<string, string>()
  const now = 1_800_000_000_000
  const auth = new CopilotAuthenticatorV2(join(process.cwd(), '.test-data', 'virtual-v2-integration'), {
    now: () => now,
    storage: { read: key => files.get(key), write: (key, value) => { files.set(key, value) }, remove: key => { files.delete(key) } },
    fetch: async () => { throw new Error('Unexpected external request') },
  })
  const grant = { accessToken: 'synthetic-inference', apiKey: { token: 'synthetic-inference', expires_at: now / 1000 + 3600, directOAuth: { clientId: 'Ov23ctr1Udn5GokVCVJf', scope: 'copilot', expiryKnown: true } } }
  return { auth, files, grant }
}

test('stable Copilot ID and explicit v2 select v2', () => {
  const { auth } = fixture()
  for (const type of ['copilot', 'copilot-v2']) {
    const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@office' }, providers: { office: { type } } })
    const provider = createProvider('gpt-6-astra', config, 'office', auth)
    assert.ok(provider instanceof CopilotProvider)
    assert.equal(provider instanceof CopilotProviderV2, true)
    assert.equal(provider.auth, copilotAuthForInstance(config, 'office', auth))
    assert.equal(provider.auth instanceof CopilotAuthenticatorV2, true)
    assert.equal(resolveProviderSettings(config, 'office').authMode, 'copilot')
    assert.equal(provider.name, 'copilot', 'protocol and AI credit accounting remain stable')
    assert.doesNotThrow(() => createAggregatedProvider(config, auth))
  }
  const config = ConfigSchema.parse({ agent: { model: 'claude-sonnet-4.6' } })
  assert.ok(createProvider('claude-sonnet-4.6', config, undefined, auth) instanceof CopilotProviderV2)
})

for (const type of ['copilot', 'copilot-v2']) {
  test(`${type}: setup readiness and inference share the same credential instance`, async t => {
    const { auth, grant } = fixture()
    const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@office' }, providers: { office: { type, name: 'Office' } } })
    const scoped = copilotAuthForInstance(config, 'office', auth)
    scoped.persistGrant(grant)
    const store = new ConfigStore({ configPath: join(process.cwd(), '.test-data', 'unused-v2-config.json'), getConfig: () => config, onChanged: () => {} })
    const setup = new ProviderSetup({ getConfig: () => config, store, auth })
    t.after(() => setup.dispose())
    assert.deepEqual(await setup.status(), {
      provider: 'office', type, name: 'Office', model: 'gpt-6-astra@office', authMode: 'copilot', ready: true,
      baseUrl: undefined, hasApiKey: false, host: 'github.com',
    })
    assert.equal(setup.configured().find(item => item.provider === 'office')?.authMode, 'copilot')
    const provider = createProvider('gpt-6-astra', config, 'office', auth) as CopilotProvider
    assert.equal(await provider.auth.getApiKey(), 'synthetic-inference')
    assert.equal(provider.auth, scoped)
    scoped.signOut()
    setup.invalidate()
    assert.equal((await setup.status()).ready, false)
    await assert.rejects(provider.auth.getApiKey(), /Sign in/)
  })
}


test('login HTTP exposes only allowlisted authentication phase and status, never upstream details', async t => {
  const { auth } = fixture()
  t.mock.method(auth, 'startDeviceLogin', async () => ({ deviceCode: 'private-device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', host: 'github.com', expiresAt: Date.now() + 60_000, intervalMs: 1000 }))
  t.mock.method(auth, 'completeDeviceLogin', async () => { throw new CopilotAuthError('denied', 'copilot_token', 403) })
  const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@copilot' } })
  const store = new ConfigStore({ configPath: join(process.cwd(), '.test-data', 'unused-phase-config.json'), getConfig: () => config, onChanged: () => {} })
  const setup = new ProviderSetup({ getConfig: () => config, store, auth })
  t.after(() => setup.dispose())
  const app = new Hono()
  setup.plugin()(app)
  const start = await (await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reauthenticate: true }) })).json()
  const result = await (await app.request(`/api/auth/login/${start.loginId}`)).json()
  assert.equal(result.state, 'denied')
  assert.equal(result.errorCode, 'denied')
  assert.equal(result.errorStage, 'copilot_token')
  assert.equal(result.httpStatus, 403)
  assert.doesNotMatch(JSON.stringify(result), /private-device|accessToken|apiKey/)
})


test('missing copilot grant is exposed by login HTTP without selecting or persisting an account', async t => {
  const { auth, files } = fixture()
  t.mock.method(auth, 'startDeviceLogin', async () => ({ deviceCode: 'private-device', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', host: 'github.com', expiresAt: Date.now() + 60_000, intervalMs: 1000 }))
  t.mock.method(auth, 'completeDeviceLogin', async () => { throw new CopilotAuthError('scope_missing', 'oauth_token') })
  const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@copilot' } })
  const store = new ConfigStore({ configPath: join(process.cwd(), '.test-data', 'unused-scope-config.json'), getConfig: () => config, onChanged: () => assert.fail('must not activate incomplete authorization') })
  const setup = new ProviderSetup({ getConfig: () => config, store, auth })
  t.after(() => setup.dispose())
  const app = new Hono(); setup.plugin()(app)
  const start = await (await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reauthenticate: true }) })).json()
  const result = await (await app.request(`/api/auth/login/${start.loginId}`)).json()
  assert.equal(result.state, 'error')
  assert.equal(result.errorCode, 'scope_missing')
  assert.equal(result.errorStage, 'oauth_token')
  assert.equal(files.size, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-device|accessToken/)
})


test('login HTTP preserves server 404 at Copilot access stage without exposing body diagnostics', async t => {
  const { auth } = fixture()
  t.mock.method(auth, 'startDeviceLogin', async () => ({ deviceCode: 'private-device', userCode: 'ABCD-1234', verificationUri: 'https://msft.ghe.com/login/device', host: 'msft.ghe.com', expiresAt: Date.now() + 60_000, intervalMs: 1000 }))
  t.mock.method(auth, 'completeDeviceLogin', async () => { throw new CopilotAuthError('network', 'copilot_access', 404) })
  const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@copilot' } })
  const store = new ConfigStore({ configPath: join(process.cwd(), '.test-data', 'unused-access-status.json'), getConfig: () => config, onChanged: () => assert.fail('must not activate failed access') })
  const setup = new ProviderSetup({ getConfig: () => config, store, auth })
  t.after(() => setup.dispose())
  const app = new Hono(); setup.plugin()(app)
  const start = await (await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'msft.ghe.com', reauthenticate: true }) })).json()
  const status = await (await app.request(`/api/auth/login/${start.loginId}`)).json()
  assert.equal(status.errorStage, 'copilot_access')
  assert.equal(status.httpStatus, 404)
  assert.equal(status.state, 'error')
  assert.doesNotMatch(JSON.stringify(status), /private-device/)
})


test('retired v1 configuration fails closed without changing credentials or selecting another account', async t => {
  const { auth, files, grant } = fixture()
  auth.persistGrant(grant)
  const before = new Map(files)
  for (const providers of [{ office: { type: 'copilot-v1' } }, { 'copilot-v1': {} }]) {
    const id = 'office' in providers ? 'office' : 'copilot-v1'
    const config = ConfigSchema.parse({ agent: { model: `gpt-6-astra@${id}` }, providers })
    const direct = createProvider('gpt-6-astra', config, id, auth)
    await assert.rejects(direct.chat([], [], { model: 'gpt-6-astra' }), /no longer supported.*Reconfigure/)
    await assert.rejects(Promise.resolve().then(() => direct.listModels()), /no longer supported/)
    assert.throws(() => resolveProviderSettings(config, id), /no longer supported/)
    assert.throws(() => copilotAuthForInstance(config, id, auth), /no longer supported/)
    const aggregated = createAggregatedProvider(config, auth)
    assert.ok(aggregated.getProvider(id))
    assert.equal(aggregated.qualifiedModelId('gpt-6-astra'), `gpt-6-astra@${id}`)
    await assert.rejects(aggregated.chat([], [], { model: 'gpt-6-astra' }), /no longer supported/)
    await assert.rejects(aggregated.chat([], [], { model: `gpt-6-astra@${id}` }), /no longer supported/)
    assert.deepEqual(await aggregated.listModels(), [])
    const store = new ConfigStore({ configPath: join(process.cwd(), '.test-data', 'unused-retired.json'), getConfig: () => config, onChanged: () => assert.fail('must not change config') })
    const setup = new ProviderSetup({ getConfig: () => config, store, auth })
    t.after(() => setup.dispose())
    assert.equal((await setup.status()).ready, false)
    assert.equal((await setup.status()).reason, 'retired_copilot')
    assert.ok(setup.configured().some(p => p.provider === id && p.reason === 'retired_copilot'))
    const app = new Hono(); setup.plugin()(app)
    assert.equal((await app.request(`/api/auth/login?provider=${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409)
    assert.equal((await app.request('/api/provider/instances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'new-old', type: 'copilot-v1', name: 'Old' }) })).status, 400)
    assert.deepEqual(files, before)
  }
  assert.equal(await auth.getApiKey(), grant.accessToken, 'existing v2 login remains usable')
  const config = ConfigSchema.parse({ agent: { model: 'gpt-6-astra@copilot' }, providers: { copilot: {}, retired: { type: 'copilot-v1' } } })
  const aggregated = createAggregatedProvider(config, auth)
  assert.ok(aggregated.getProvider('copilot') instanceof CopilotProviderV2)
  assert.ok(aggregated.getProvider('retired'), 'retain retired secondary routing identity')
  assert.equal(aggregated.qualifiedModelId('gpt-6-astra'), 'gpt-6-astra@copilot')
  let currentCalls = 0
  t.mock.method(aggregated.getProvider('copilot')!, 'chat', async () => {
    currentCalls++
    return { content: 'synthetic-current', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } }
  })
  await aggregated.chat([], [], { model: 'gpt-6-astra' })
  assert.equal(currentCalls, 1, 'valid primary remains usable')
  await assert.rejects(aggregated.chat([], [], { model: 'gpt-6-astra@retired' }), /Reconfigure/)
  assert.equal(currentCalls, 1, 'retired request must not fall back to current account')
  assert.deepEqual(files, before)
})
