import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveWebSearchTool, createWebSearchTool } from './web-provider.ts'
import type { WebSearchConfig } from '../config/web-search.ts'
import { ExaSearchTool } from './exa.ts'
import { TavilySearchTool } from './tavily.ts'
import { FirecrawlSearchTool, WebSearchTool } from './web.ts'
import { Tools, SessionTools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

function context(signal = new AbortController().signal): ExecutionContext {
  return {
    signal, channel: 'web', chatId: 'test', senderId: 'test', messageId: 'test',
    sessionId: 'web:test', physicalSessionId: 'physical-test',
    tools: new SessionTools(new Tools(process.cwd()), process.cwd()),
  }
}

test('provider selection prefers configured Firecrawl, then Brave, then keyless Firecrawl without network probes', t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request') })
  assert.ok(createWebSearchTool({ firecrawlApiKey: 'synthetic', braveApiKey: 'synthetic' }) instanceof FirecrawlSearchTool)
  assert.ok(createWebSearchTool({ braveApiKey: 'synthetic' }) instanceof WebSearchTool)
  assert.ok(createWebSearchTool({}) instanceof FirecrawlSearchTool)
  assert.equal(request.mock.callCount(), 0)
})

test('keyless search sends only the requested searches to Firecrawl without credentials', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({
    data: { web: [{ title: 'Example', url: 'https://example.com', description: 'Result' }] },
  }))
  const tool = createWebSearchTool({})
  for (const query of ['first', 'second']) {
    assert.equal(await tool.execute({ query }, context()), '1. Example\n   https://example.com\n   Result')
  }
  assert.equal(request.mock.callCount(), 2)
  for (const [index, call] of request.mock.calls.entries()) {
    const [url, init] = call.arguments
    assert.equal(url, 'https://api.firecrawl.dev/v2/search')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: index === 0 ? 'first' : 'second', limit: 5, sources: [{ type: 'web' }],
    })
  }
})

test('configured searches use the selected provider credentials and preserve result formatting', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({
    data: { web: [{ title: 'Firecrawl', url: 'https://example.com/firecrawl' }] },
    web: { results: [{ title: 'Brave', url: 'https://example.com/brave', description: 'Result' }] },
  }))
  const firecrawl = createWebSearchTool({ firecrawlApiKey: 'synthetic-firecrawl', braveApiKey: 'synthetic-brave' })
  assert.equal(await firecrawl.execute({ query: 'docs', count: 1 }, context()), '1. Firecrawl\n   https://example.com/firecrawl')
  const [firecrawlUrl, firecrawlInit] = request.mock.calls[0].arguments
  assert.equal(firecrawlUrl, 'https://api.firecrawl.dev/v2/search')
  assert.equal(new Headers(firecrawlInit?.headers).get('Authorization'), 'Bearer synthetic-firecrawl')
  const brave = createWebSearchTool({ braveApiKey: 'synthetic-brave' })
  assert.equal(await brave.execute({ query: 'docs & examples', count: 1 }, context()), '1. Brave\n   https://example.com/brave\n   Result')
  const [braveUrl, braveInit] = request.mock.calls[1].arguments
  assert.equal(braveUrl, 'https://api.search.brave.com/res/v1/web/search?q=docs%20%26%20examples&count=1')
  assert.equal(new Headers(braveInit?.headers).get('X-Subscription-Token'), 'synthetic-brave')
  assert.equal(request.mock.callCount(), 2)
})

for (const [name, config] of [
  ['keyless Firecrawl', {}],
  ['configured Firecrawl', { firecrawlApiKey: 'synthetic' }],
  ['Brave', { braveApiKey: 'synthetic' }],
] as const) {
  test(`${name} does not send cancelled searches`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request') })
    await assert.rejects(
      createWebSearchTool(config).execute({ query: 'cancelled' }, context(AbortSignal.abort())),
      { name: 'AbortError' },
    )
    assert.equal(request.mock.callCount(), 0)
  })

  test(`${name} cancels in-flight requests with the turn`, async t => {
    const controller = new AbortController()
    const request = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }))
    const result = createWebSearchTool(config).execute({ query: 'cancelled' }, context(controller.signal))
    controller.abort()
    await assert.rejects(result, { name: 'AbortError' })
    assert.equal(request.mock.callCount(), 1)
  })
}

test('provider rate limits stay visible without switching providers', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Synthetic limit' }, { status: 429 }))
  const result = await createWebSearchTool({}).execute({ query: 'docs' }, context())
  assert.match(result, /Firecrawl rate limit reached \(429\): Synthetic limit/)
  assert.equal(request.mock.callCount(), 1)
})

test('auto selection keeps existing priority before Exa and Tavily, then keyless Firecrawl', t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request') })
  const keys = { firecrawlApiKey: 'f', braveApiKey: 'b', exaApiKey: 'e', tavilyApiKey: 't' }
  assert.ok(createWebSearchTool({ ...keys, webSearchProvider: 'auto' }) instanceof FirecrawlSearchTool)
  assert.ok(createWebSearchTool({ ...keys, firecrawlApiKey: '', webSearchProvider: 'auto' }) instanceof WebSearchTool)
  assert.ok(createWebSearchTool({ exaApiKey: 'e', tavilyApiKey: 't' }) instanceof ExaSearchTool)
  assert.ok(createWebSearchTool({ tavilyApiKey: 't' }) instanceof TavilySearchTool)
  assert.ok(createWebSearchTool({ webSearchProvider: 'auto' }) instanceof FirecrawlSearchTool)
  assert.equal(request.mock.callCount(), 0)
})

test('explicit provider selection overrides key priority without probing', t => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request') })
  const keys = { firecrawlApiKey: 'f', braveApiKey: 'b', exaApiKey: 'e', tavilyApiKey: 't' }
  for (const [webSearchProvider, Provider] of [
    ['firecrawl', FirecrawlSearchTool], ['brave', WebSearchTool], ['exa', ExaSearchTool], ['tavily', TavilySearchTool],
  ] as const) {
    assert.ok(createWebSearchTool({ ...keys, webSearchProvider }) instanceof Provider)
  }
  assert.ok(createWebSearchTool({ webSearchProvider: 'firecrawl', braveApiKey: 'b' }) instanceof FirecrawlSearchTool)
  assert.equal(request.mock.callCount(), 0)
})

for (const webSearchProvider of ['brave', 'exa', 'tavily'] as const) {
  test(`explicit ${webSearchProvider} without a key returns an error at execution without fallback`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request') })
    const config = { webSearchProvider, firecrawlApiKey: 'synthetic-firecrawl' }
    const tool = createWebSearchTool(config)
    assert.match(await tool.execute({ query: 'docs' }, context()), /requires an API key/)
    await assert.rejects(tool.execute({ query: 'docs' }, context(AbortSignal.abort())), { name: 'AbortError' })
    assert.equal(request.mock.callCount(), 0)
  })
}

for (const webSearchProvider of ['exa', 'tavily'] as const) {
  for (const selection of ['auto', webSearchProvider] as const) {
    test(`${selection} ${webSearchProvider} errors never fall back or retry`, async t => {
      const request = t.mock.method(globalThis, 'fetch', async () => Response.json({
        error: 'private-supplier-detail',
      }, { status: 429 }))
      const config: WebSearchConfig = webSearchProvider === 'exa'
        ? { exaApiKey: 'synthetic-exa', tavilyApiKey: 'synthetic-tavily' }
        : { tavilyApiKey: 'synthetic-tavily' }
      const tool = createWebSearchTool({ ...config, webSearchProvider: selection })
      assert.match(await tool.execute({ query: 'docs' }, context()), /rate limit reached \(429\)/)
      assert.equal(request.mock.callCount(), 1)
      assert.equal(request.mock.calls[0].arguments[0],
        webSearchProvider === 'exa' ? 'https://api.exa.ai/search' : 'https://api.tavily.com/search')
    })
  }
}

test('live search reads current backend and credentials on every execution', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [], data: { web: [] } }))
  let config: WebSearchConfig = { webSearchProvider: 'exa', exaApiKey: 'first-key' }
  let reads = 0
  const tool = createLiveWebSearchTool(() => { reads++; return config })
  assert.equal(reads, 0)
  await tool.execute({ query: 'one' }, context())
  config = { ...config, exaApiKey: 'second-key' }
  await tool.execute({ query: 'two' }, context())
  config = { webSearchProvider: 'tavily', tavilyApiKey: 'third-key' }
  await tool.execute({ query: 'three' }, context())
  config = { webSearchProvider: 'tavily', firecrawlApiKey: 'should-not-fallback' }
  assert.match(await tool.execute({ query: 'four' }, context()), /Tavily search requires an API key/)
  config = {}
  await tool.execute({ query: 'five' }, context())
  assert.equal(reads, 5)
  assert.equal(request.mock.callCount(), 4)
  const calls = request.mock.calls.map(call => call.arguments)
  assert.equal(new Headers(calls[0][1]?.headers).get('x-api-key'), 'first-key')
  assert.equal(new Headers(calls[1][1]?.headers).get('x-api-key'), 'second-key')
  assert.equal(calls[2][0], 'https://api.tavily.com/search')
  assert.equal(new Headers(calls[2][1]?.headers).get('Authorization'), 'Bearer third-key')
  assert.equal(calls[3][0], 'https://api.firecrawl.dev/v2/search')
  assert.equal(new Headers(calls[3][1]?.headers).has('Authorization'), false)
})
