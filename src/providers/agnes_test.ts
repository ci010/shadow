import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigSchema } from '../config/schema.ts'
import { createProvider, createAggregatedProvider, detectProvider, knownProviderNames, resolveProviderSettings } from './factory.ts'
import { resolveContextWindow } from './model-registry.ts'
import { providerPresets } from '../../app/src/provider-setup.ts'
import { cacheRate } from '../../app/src/session-details.ts'

const ids = ['agnes-3.0-flash', 'agnes-2.5-flash']

test('Agnes built-in defaults, setup preset, detection and qualified catalog use documented API IDs', async () => {
  const config = ConfigSchema.parse({ agent: { model: ids[0] }, providers: { agnes: { apiKey: 'synthetic-key' } } })
  assert.ok(knownProviderNames().includes('agnes'))
  assert.equal(providerPresets.find(p => p.id === 'agnes')?.model, ids[0])
  assert.equal(resolveProviderSettings(config, 'agnes').baseUrl, 'https://apihub.agnes-ai.com/v1')
  for (const id of ids) {
    assert.equal(detectProvider(id), 'agnes')
    assert.equal(resolveContextWindow(`${id}@agnes`), 512_000)
  }
  const provider = createProvider(ids[0], config)
  assert.deepEqual(await provider.listModels(), ids)
  const infos = await provider.listModelInfos!()
  assert.ok(infos.every(info => info.vision && info.contextWindow === 512_000))
  assert.equal(infos[0].maxOutputTokens, 65_536)
  assert.equal(infos[1].maxOutputTokens, undefined)
  assert.deepEqual(await createAggregatedProvider(config).listModels(), ids.map(id => `${id}@agnes`).sort())
})

for (const id of ids) test(`${id} sends native thinking switch and preserves reported reasoning/cache for display`, async t => {
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://agnes.fixture/v1/chat/completions')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-key')
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({ model: id, choices: [{ message: { content: 'Answer', reasoning_content: 'Returned reasoning' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 75 } } })
  })
  const provider = createProvider(id, ConfigSchema.parse({ providers: { agnes: { apiKey: 'synthetic-key', baseUrl: 'https://agnes.fixture/v1/' } } }))
  const signal = new AbortController().signal
  for (const thinking of [undefined, { type: 'enabled' as const }, { type: 'disabled' as const }]) {
    const result = await provider.chat([{ role: 'user', content: 'Hello' }], [], { model: id, thinking, reasoningEffort: 'high', maxTokens: 1024, signal })
    assert.equal(result.reasoningText, 'Returned reasoning')
    assert.equal(result.reasoningContent, null)
    assert.equal(result.usage?.cachedTokens, 75)
    assert.equal(cacheRate(result.usage!), 75)
  }
  assert.deepEqual(bodies.map(b => b.chat_template_kwargs), [{ enable_thinking: true }, { enable_thinking: true }, { enable_thinking: false }])
  assert.ok(bodies.every(b => !('thinking' in b) && !('reasoning_effort' in b) && b.max_tokens === 1024 && b.model === id))
})

test('compatible cache usage distinguishes absent, zero hits and DeepSeek hits; narration is display-only', async t => {
  const usages = [{}, { prompt_tokens_details: { cached_tokens: 0 } }, { prompt_cache_hit_tokens: 60 }]
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.ok(!String(init.body).includes('display-only'))
    return Response.json({ choices: [{ message: { content: 'Answer', reasoning_text: 'Narration' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, ...usages.shift() } })
  })
  const provider = createProvider(ids[0], ConfigSchema.parse({ providers: { agnes: { apiKey: 'synthetic-key' } } }))
  for (const expected of [undefined, 0, 60]) {
    const result = await provider.chat([{ role: 'assistant', content: 'Old answer', reasoning_text: 'display-only', reasoning_content: 'display-only content' }], [], { model: ids[0] })
    assert.equal(result.reasoningText, 'Narration')
    assert.equal(result.usage?.cachedTokens, expected)
    assert.equal(cacheRate(result.usage!), expected === undefined ? null : expected)
  }
})


test('Agnes preserves public image URLs, native tools and cancellation, and parses tool-only thinking replies', async t => {
  const signal = new AbortController().signal
  const tools = [{ type: 'function' as const, function: { name: 'inspect', description: 'Inspect fixture', parameters: { type: 'object' as const, properties: {} } } }]
  const messages = [{ role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'https://fixture.invalid/image.png' } }] }]
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    assert.deepEqual(body.messages, messages)
    assert.deepEqual(body.tools, tools)
    assert.equal(init.signal, signal)
    return Response.json({ choices: [{ message: { content: null, reasoning_content: 'Inspect the image',
      tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'inspect', arguments: '{}' } }] } }] })
  })
  const provider = createProvider(ids[0], ConfigSchema.parse({ providers: { agnes: { apiKey: 'synthetic-key' } } }))
  const result = await provider.chat(messages, tools, { model: ids[0], signal })
  assert.equal(result.content, null)
  assert.equal(result.reasoningText, 'Inspect the image')
  assert.deepEqual(result.toolCalls, [{ id: 'call_fixture', name: 'inspect', arguments: {} }])
  assert.equal(result.usage, undefined)
})
