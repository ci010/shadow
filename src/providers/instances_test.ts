import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { providerPlugin } from './routes.ts'
import { join, relative } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import { createAggregatedProvider, createProvider, resolveProviderSettings } from './factory.ts'
import { CopilotAuthenticator, CopilotProvider } from './copilot.ts'
import { DeepSeekProvider } from './deepseek.ts'
import { AggregatedProvider } from './aggregated.ts'
import type { LLMProvider } from './provider.ts'

const config = () => ConfigSchema.parse({
  agent: { model: 'deepseek-flash@personal' }, providers: {
    personal: { type: 'deepseek', name: 'Personal', apiKey: 'synthetic-personal' },
    work: { type: 'deepseek', name: 'Work', apiKey: 'synthetic-work' },
  },
})

test('factory selects implementation by type, preserves identity and never borrows another key', async t => {
  const cfg = config()
  assert.ok(createProvider('deepseek-flash', cfg, 'personal') instanceof DeepSeekProvider)
  assert.ok(createProvider('deepseek-flash', cfg, 'work') instanceof DeepSeekProvider)
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization')
    return Response.json({ choices: [{ message: { content: auth }, finish_reason: 'stop' }] })
  })
  const provider = createAggregatedProvider(cfg)
  for (const id of ['personal', 'work']) {
    const result = await provider.chat([{ role: 'user', content: 'fixture' }], [], { model: `deepseek-flash@${id}` })
    assert.equal(result.content, `Bearer synthetic-${id}`)
  }
  assert.throws(() => provider.chat([], [], { model: 'deepseek-flash@missing' }), /not configured/i)
  assert.throws(() => createProvider('deepseek-flash', cfg, 'missing'), /Unknown provider instance/)
  cfg.providers.personal.name = 'Renamed'
  assert.equal(createAggregatedProvider(cfg).qualifiedModelId('deepseek-flash'), 'deepseek-flash@personal')
  cfg.providers.work.apiKey = undefined
  const previous = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'synthetic-environment'
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous })
  assert.equal(resolveProviderSettings(cfg, 'work').apiKey, '')
  assert.equal(resolveProviderSettings(cfg, 'deepseek').apiKey, 'synthetic-environment')
})

test('model list failures are contained to one instance, with no request failover', async () => {
  let called = 0
  const good: LLMProvider = { name: 'deepseek', listModels: async () => ['same'], chat: async () => { called++; return { content: 'ok', toolCalls: [] } } }
  const bad: LLMProvider = { name: 'deepseek', listModels: async () => { throw new Error('offline') }, chat: async () => { throw new Error('denied') } }
  const provider = new AggregatedProvider(new Map([['a', bad], ['b', good]]), 'a')
  assert.deepEqual(await provider.listModels(), ['same@b'])
  assert.deepEqual(await provider.listModelInfos(), [{ id: 'same@b' }])
  await assert.rejects(provider.chat([], [], { model: 'same@a' }), /denied/)
  assert.equal(called, 0)
})

test('Copilot tokens, refreshes, persisted hosts and model caches are isolated by stable instance', async () => {
  const files = new Map<string, string>()
  const root = join(process.cwd(), '.test-data', 'virtual-instances')
  const key = (path: string) => relative(root, path).replaceAll('\\', '/')
  const now = 1_800_000_000_000
  const auth = new CopilotAuthenticator(root, {
    now: () => now,
    storage: { read: path => files.get(key(path)), write: (path, value) => { files.set(key(path), value) }, remove: path => { files.delete(key(path)) } },
    fetch: async (_url, init) => Response.json({ token: new Headers(init?.headers).get('authorization'), expires_at: now / 1000 + 3600 }),
  })
  const a = auth.forInstance('a'), b = auth.forInstance('b')
  assert.equal(auth.forInstance('a'), a)
  assert.equal(auth.forInstance('copilot'), auth)
  const grant = (id: string) => ({ accessToken: `synthetic-${id}`, apiKey: { token: `key-${id}`, expires_at: now / 1000 + 3600 } })
  auth.persistGrant(grant('legacy'))
  a.persistGrant(grant('a'))
  b.persistGrant(grant('b'))
  a.writeModelsCache([{ id: 'a-model' }]); b.writeModelsCache([{ id: 'b-model' }])
  assert.deepEqual(a.readModelsCache()?.models, [{ id: 'a-model' }])
  assert.deepEqual(b.readModelsCache()?.models, [{ id: 'b-model' }])
  assert.equal(await a.getApiKey(), 'key-a')
  assert.equal(await b.getApiKey(), 'key-b')
  assert.notEqual(await a.getApiKey(undefined, true), await b.getApiKey(undefined, true))
  a.signOut()
  await assert.rejects(a.getApiKey(), /sign in|credentials|Sign in/i)
  assert.equal(await auth.getApiKey(), 'key-legacy')
  assert.ok(await b.getApiKey())
  assert.ok(b.readModelsCache())
  assert.ok([...files.keys()].some(name => name.startsWith('instances/b/')))
  assert.throws(() => auth.forInstance('../escape'), /Invalid/)
  const cfg = ConfigSchema.parse({ agent: { model: 'gpt-4o@b' }, providers: { b: { type: 'copilot' } } })
  assert.ok(createProvider('gpt-4o', cfg, 'b', auth) instanceof CopilotProvider)
})


test('model catalog exposes only safe instance labels and rename keeps model IDs unchanged', async () => {
  const cfg = config()
  let aggregate = createAggregatedProvider(cfg)
  const app = new Hono()
  providerPlugin(() => aggregate)(app)
  const before = await (await app.request('/debug/models')).json()
  assert.deepEqual(before.providers, [
    { id: 'personal', type: 'deepseek', name: 'Personal' }, { id: 'work', type: 'deepseek', name: 'Work' },
  ])
  assert.ok(!JSON.stringify(before).includes('synthetic-'))
  cfg.providers.work.name = 'Office'
  aggregate = createAggregatedProvider(cfg)
  const after = await (await app.request('/debug/models')).json()
  assert.deepEqual(after.models, before.models)
  assert.equal(after.providers[1].name, 'Office')
})
