import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDeepSeekSearch } from '../config/deepseek-search.ts'
import { webSearchStatus, WebSearchPatchSchema } from '../config/web-search.ts'
import { DeepSeekSearchTool } from './deepseek-search.ts'
import { createLiveWebSearchTool, createWebSearchTool } from './web-provider.ts'
import type { ExecutionContext } from './context.ts'

const providers = { alias: { type: 'deepseek', apiKey: 'synthetic-alias' } }

test('DeepSeek reuses deterministic official provider instances, never third-party credentials', () => {
  assert.equal(resolveDeepSeekSearch(providers)?.providerId, 'alias')
  assert.equal(resolveDeepSeekSearch({ z: providers.alias, a: providers.alias })?.providerId, 'a')
  assert.equal(resolveDeepSeekSearch({ ...providers, deepseek: { apiKey: 'synthetic-canonical' } })?.providerId, 'deepseek')
  for (const baseUrl of ['https://third-party.invalid/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.invalid',
    'https://api.deepseek.com/proxy', 'https://user@api.deepseek.com', 'https://api.deepseek.com?token=private']) {
    assert.equal(resolveDeepSeekSearch({ deepseek: { apiKey: 'synthetic-custom', baseUrl } }), undefined)
  }
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1/']) {
    assert.ok(resolveDeepSeekSearch({ deepseek: { apiKey: 'synthetic', baseUrl } }))
  }
  assert.equal(resolveDeepSeekSearch({ alias: { apiKey: 'synthetic', type: 'openai' } }), undefined)
  assert.equal(WebSearchPatchSchema.safeParse({ apiKeys: { deepseek: 'duplicate' } }).success, false)
  assert.equal(webSearchStatus({}, providers).effectiveProvider, 'deepseek')
  assert.deepEqual(webSearchStatus({}, providers).deepseek, { ready: true, providerId: 'alias' })
  assert.ok(createWebSearchTool({}, providers) instanceof DeepSeekSearchTool)
  for (const field of ['firecrawlApiKey', 'braveApiKey', 'exaApiKey', 'tavilyApiKey']) {
    assert.notEqual(webSearchStatus({ [field]: 'synthetic' }, providers).effectiveProvider, 'deepseek')
  }
  assert.equal(webSearchStatus({ webSearchProvider: 'deepseek', exaApiKey: 'synthetic' }).ready, false)
})

test('DeepSeek request, Unicode bounds, result formatting and errors use mocked network only', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [
    { title: 'Docs', url: 'https://example.com', summary: 'Summary' },
  ] }))
  const tool = createWebSearchTool({ webSearchProvider: 'deepseek' }, providers)
  assert.equal(await tool.execute({ query: '😀'.repeat(128), count: '50' }, undefined!), '1. Docs\n   https://example.com\n   Summary')
  const [url, init] = request.mock.calls[0].arguments as unknown as [string, RequestInit]
  assert.equal(url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(init.method, 'POST')
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-alias')
  assert.deepEqual(JSON.parse(String(init.body)), { query: '😀'.repeat(128), count: 50, need_content: false })
  for (const args of [{ query: '😀'.repeat(129) }, { query: ' ' }, { query: 3 },
    { query: 'q', count: 51 }, { query: 'q', count: 0 }, { query: 'q', count: 1.5 }]) {
    assert.match(await tool.execute(args, undefined!), /^Error:/)
  }
  assert.equal(request.mock.callCount(), 1)
  for (const status of [401, 403, 429, 500]) {
    request.mock.mockImplementation(async () => new Response('synthetic-secret', { status }))
    const result = await tool.execute({ query: 'q' }, undefined!)
    assert.match(result, new RegExp(String(status)))
    assert.doesNotMatch(result, /synthetic-secret/)
  }
  request.mock.mockImplementation(async () => new Response('not json'))
  assert.match(await tool.execute({ query: 'q' }, undefined!), /invalid JSON/)
  request.mock.mockImplementation(async () => Response.json({ results: [{}] }))
  assert.match(await tool.execute({ query: 'q' }, undefined!), /invalid response/)
  request.mock.mockImplementation(async () => { throw new Error('synthetic-private') })
  assert.match(await tool.execute({ query: 'q' }, undefined!), /request failed/)
})

test('DeepSeek honors preflight and in-flight cancellation; live configuration updates do not fallback', async t => {
  let current = providers
  const live = createLiveWebSearchTool(() => ({ webSearchProvider: 'deepseek' }), () => current)
  const context = (signal: AbortSignal) => ({ signal }) as ExecutionContext
  const request = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })))
  await assert.rejects(live.execute({ query: 'q' }, context(AbortSignal.abort())), { name: 'AbortError' })
  assert.equal(request.mock.callCount(), 0)
  const controller = new AbortController()
  const pending = live.execute({ query: 'q' }, context(controller.signal))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  request.mock.mockImplementation(async () => Response.json({ results: [] }))
  current = { alias: { type: 'deepseek', apiKey: 'synthetic-new' } }
  assert.equal(await live.execute({ query: 'q' }, undefined!), 'No results found.')
  assert.equal(new Headers(request.mock.calls[1].arguments[1]?.headers).get('Authorization'), 'Bearer synthetic-new')
  current = { alias: { type: 'deepseek', apiKey: '' } }
  assert.match(await live.execute({ query: 'q' }, undefined!), /provider settings/)
  assert.equal(request.mock.callCount(), 2)
})

test('canonical instance uses the provider environment fallback but aliases do not inherit it', async () => {
  const { execFileSync } = await import('node:child_process')
  // An isolated environment avoids inspecting or mutating real provider credentials.
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { resolveDeepSeekSearch } from './src/config/deepseek-search.ts';
    console.log(JSON.stringify([
      resolveDeepSeekSearch({ deepseek: {} }),
      resolveDeepSeekSearch({ alias: { type: 'deepseek' } }),
      resolveDeepSeekSearch({ deepseek: { apiKey: 'synthetic-explicit' } }),
      resolveDeepSeekSearch({ deepseek: { baseUrl: 'https://custom.invalid' } }),
    ]));
  `], { cwd: process.cwd(), env: { DEEPSEEK_API_KEY: 'synthetic-env' }, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(output), [
    { providerId: 'deepseek', apiKey: 'synthetic-env' }, null,
    { providerId: 'deepseek', apiKey: 'synthetic-explicit' }, null,
  ])
})
