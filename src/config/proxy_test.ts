import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ConfigSchema } from './schema.ts'
import { AppProviderConfigStore } from '../projects/config-store.ts'
import { registerGatewayRoutes } from '../gateway/server.ts'
import { appProxyPlugin, proxyStatus } from './proxy-routes.ts'
import { isLocalProxyEnabled, localProxyConfiguration, setLocalProxyEnabled } from '../execution/network/proxy.ts'
import { updateBackendNetwork } from '../execution/network/backend.ts'

test('disabled bypasses invalid environment and Windows detection; detection remains available without enabling', async () => {
  setLocalProxyEnabled(false)
  try {
    const options = { platform: 'win32' as const, env: { HTTPS_PROXY: 'http://user:secret@proxy.example' }, readWindows: async () => { throw new Error('must not read Windows') } }
    assert.deepEqual(await localProxyConfiguration(undefined, options), { source: 'direct', bypass: [] })
    assert.deepEqual(await localProxyConfiguration(undefined, { ...options, env: {} }), { source: 'direct', bypass: [] })
    await assert.rejects(localProxyConfiguration(undefined, { ...options, detectOnly: true }))
    assert.equal(isLocalProxyEnabled(), false)
    const status = await proxyStatus(false, async () => { throw new Error('password-secret') })
    assert.equal(status.enabled, false)
    assert.equal(status.detectionFailed, true)
    assert.doesNotMatch(JSON.stringify(status), /password-secret/)
    const pac = await proxyStatus(false, async () => ({ source: 'windows-auto', bypass: [] }))
    assert.deepEqual(pac, { enabled: false, detected: true, source: 'windows-auto', http: '', https: '', detectionFailed: false })
  } finally { setLocalProxyEnabled(true) }
})

test('App proxy routes authenticate, strictly validate, persist and redetect without re-enabling', async () => {
  await withTempWorkspace(async root => {
    const configPath = join(root, 'app.json')
    const initial = { agent: { workspace: root }, providers: { openai: { apiKey: 'private-key' } }, tools: { braveApiKey: 'private-search' } }
    await writeFile(configPath, JSON.stringify(initial))
    let active = ConfigSchema.parse(initial)
    const store = new AppProviderConfigStore({ configPath, getConfig: () => active, onChanged: async value => { await updateBackendNetwork(value.network?.proxyEnabled ?? true); active = value } })
    const app = new Hono()
    registerGatewayRoutes(app, [appProxyPlugin(store, () => active)], { launchCredential: 'fixture-admin' })
    const headers = { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }
    for (const [path, method] of [['/api/app/proxy', 'GET'], ['/api/app/proxy', 'PATCH'], ['/api/app/proxy/detect', 'POST']]) {
      assert.equal((await app.request(path, { method })).status, 401)
    }
    for (const body of [{ enabled: 'false' }, { enabled: false, url: 'http://override' }, {}, null, []]) {
      assert.equal((await app.request('/api/app/proxy', { method: 'PATCH', headers, body: JSON.stringify(body) })).status, 400)
    }
    assert.equal((await app.request('/api/app/proxy', { method: 'PATCH', headers, body: '{' })).status, 400)
    try {
      const saved = await app.request('/api/app/proxy', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })
      assert.equal(saved.status, 200)
      assert.equal(saved.headers.get('cache-control'), 'no-store')
      assert.equal((await saved.json()).enabled, false)
      const file = JSON.parse(await readFile(configPath, 'utf8'))
      assert.deepEqual(file, { ...initial, network: { proxyEnabled: false } })
      const restored = ConfigSchema.parse(await new AppProviderConfigStore({ configPath }).read())
      assert.equal(restored.network?.proxyEnabled, false)
      const detected = await app.request('/api/app/proxy/detect', { method: 'POST', headers })
      assert.equal((await detected.json()).enabled, false)
      assert.equal(isLocalProxyEnabled(), false)
      assert.equal(JSON.parse(await readFile(configPath, 'utf8')).network.proxyEnabled, false)
      assert.doesNotMatch(await (await app.request('/api/app/proxy', { headers })).text(), /private-key|private-search/)
    } finally { setLocalProxyEnabled(true) }
  })
})

test('proxy policy schema keeps automatic detection as the default and rejects non-booleans', () => {
  assert.equal(ConfigSchema.parse({}).network, undefined)
  assert.equal(ConfigSchema.parse({ network: {} }).network?.proxyEnabled, true)
  assert.equal(ConfigSchema.safeParse({ network: { proxyEnabled: 'false' } }).success, false)
})

test('Project configuration inherits live Main proxy policy but cannot override or persist it', async () => {
  await withTempWorkspace(async root => {
    const { ProjectConfigStore } = await import('../projects/config-store.ts')
    let shared = ConfigSchema.parse({ network: { proxyEnabled: false } })
    const path = join(root, 'project.json')
    const store = new ProjectConfigStore({ configPath: path, home: root, getSharedConfig: () => shared })
    await store.init()
    assert.equal(store.current().network?.proxyEnabled, false)
    await assert.rejects(store.update(raw => ({ ...raw, network: { proxyEnabled: true } })), /Shared proxy settings/)
    shared = ConfigSchema.parse({ network: { proxyEnabled: true } })
    await store.refreshShared()
    assert.equal(store.current().network?.proxyEnabled, true)
    await store.update(raw => ({ ...raw, agent: { ...(raw.agent as object), maxSteps: 123 } }))
    assert.equal(JSON.parse(await readFile(path, 'utf8')).network, undefined)
  })
})

test('failed enable preserves disabled runtime and persisted policy without leaking proxy credentials', async () => {
  const keys = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'] as const
  const previous = keys.map(key => process.env[key])
  for (const key of keys) process.env[key] = 'http://user:private-proxy-password@proxy.invalid'
  try {
    await withTempWorkspace(async root => {
      const configPath = join(root, 'app.json')
      await writeFile(configPath, JSON.stringify({ network: { proxyEnabled: false } }))
      let active = ConfigSchema.parse({ network: { proxyEnabled: false } })
      await updateBackendNetwork(false)
      const store = new AppProviderConfigStore({ configPath, onChanged: async value => { await updateBackendNetwork(value.network?.proxyEnabled ?? true); active = value } })
      const app = new Hono()
      registerGatewayRoutes(app, [appProxyPlugin(store, () => active)], { launchCredential: 'fixture-admin' })
      const headers = { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }
      const failed = await app.request('/api/app/proxy', { method: 'PATCH', headers, body: '{"enabled":true}' })
      assert.equal(failed.status, 500)
      assert.doesNotMatch(await failed.text(), /private-proxy-password|proxy.invalid/)
      assert.equal(isLocalProxyEnabled(), false)
      assert.equal(active.network?.proxyEnabled, false)
      assert.equal(JSON.parse(await readFile(configPath, 'utf8')).network.proxyEnabled, false)
      const status = await (await app.request('/api/app/proxy/detect', { method: 'POST', headers })).json()
      assert.equal(status.enabled, false)
      assert.equal(status.source, 'environment')
      assert.equal(status.detectionFailed, true)
    })
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
    setLocalProxyEnabled(true)
  }
})
