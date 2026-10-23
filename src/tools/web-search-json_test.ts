import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from './context.ts'
import { ExaSearchTool } from './exa.ts'
import { TavilySearchTool } from './tavily.ts'
import { SessionTools, Tools } from './registry.ts'

function context(signal = new AbortController().signal): ExecutionContext {
  return {
    signal, channel: 'web', chatId: 'test', senderId: 'test', messageId: 'test',
    sessionId: 'web:test', physicalSessionId: 'physical-test',
    tools: new SessionTools(new Tools(process.cwd()), process.cwd()),
  }
}

const providers = [
  {
    name: 'Exa',
    Tool: ExaSearchTool,
    url: 'https://api.exa.ai/search',
    auth: 'x-api-key',
    credential: 'synthetic-key',
    limit: 100,
    body: { query: 'docs & examples', numResults: 2, contents: { highlights: true } },
    results: [
      { title: 'Example', url: 'https://example.com', highlights: ['First highlight.', 'Second highlight.'] },
      { url: 'https://example.org', highlights: [] },
      { title: 'Extra', url: 'https://example.net' },
    ],
    expected: '1. Example\n   https://example.com\n   First highlight. Second highlight.\n\n2. https://example.org\n   https://example.org',
    malformedResult: { title: 'Example', url: 'https://example.com', highlights: 'invalid' },
  },
  {
    name: 'Tavily',
    Tool: TavilySearchTool,
    url: 'https://api.tavily.com/search',
    auth: 'Authorization',
    credential: 'Bearer synthetic-key',
    limit: 20,
    body: { query: 'docs & examples', search_depth: 'basic', max_results: 2, include_answer: false },
    results: [
      { title: 'Example', url: 'https://example.com', content: 'Useful content.' },
      { title: null, url: 'https://example.org', content: '' },
      { title: 'Extra', url: 'https://example.net', content: 'Extra content.' },
    ],
    expected: '1. Example\n   https://example.com\n   Useful content.\n\n2. https://example.org\n   https://example.org',
    malformedResult: { title: 'Example', url: 'https://example.com', content: 42 },
  },
] as const

for (const provider of providers) {
  test(`${provider.name} authenticates one POST and maps validated results without extra summaries`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({
      results: provider.results,
      answer: 'Must not be included',
      requestId: 'synthetic-request',
    }))
    const tool = new provider.Tool('synthetic-key')
    assert.equal(tool.name, 'web_search')
    assert.equal(tool.readonly, true)
    assert.equal(await tool.execute({ query: 'docs & examples', count: '2' }, context()), provider.expected)
    assert.equal(request.mock.callCount(), 1)
    const [url, init] = request.mock.calls[0].arguments
    assert.equal(url, provider.url)
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get(provider.auth), provider.credential)
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json')
    assert.deepEqual(JSON.parse(String(init?.body)), provider.body)
    assert.equal(tool.getChatTextDisplay({ query: 'docs' }), '🕵️ docs')
  })

  test(`${provider.name} returns empty results and uses the default count`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [] }))
    assert.equal(await new provider.Tool('synthetic').execute({ query: 'docs' }), 'No results found.')
    const body = JSON.parse(String(request.mock.calls[0].arguments[1]?.body))
    assert.equal(body.numResults ?? body.max_results, 5)
  })

  test(`${provider.name} rejects invalid JSON without echoing response content`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => new Response('private-supplier-detail'))
    assert.equal(await new provider.Tool('synthetic').execute({ query: 'docs' }),
      `Error: ${provider.name} search returned invalid JSON.`)
    assert.equal(request.mock.callCount(), 1)
  })

  test(`${provider.name} rejects malformed response structures rather than reporting no results`, async t => {
    const fixtures = [
      null, {}, [], { results: null }, { results: {} },
      { error: 'private-supplier-detail' },
      { results: [{}] },
      { results: [{ url: 42 }] },
      { results: [{ url: 'not-a-url' }] },
      { results: [provider.malformedResult] },
    ]
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json(fixtures.shift()))
    const total = fixtures.length
    for (let i = 0; i < total; i++) {
      assert.equal(await new provider.Tool('synthetic').execute({ query: 'docs' }),
        `Error: ${provider.name} search returned an invalid response structure.`)
    }
    assert.equal(request.mock.callCount(), total)
  })

  for (const status of [401, 403, 429, 500]) {
    test(`${provider.name} reports HTTP ${status} without exposing supplier errors or retrying`, async t => {
      const response = Response.json({ error: 'private-supplier-detail synthetic-key' }, { status })
      const cancel = t.mock.method(response.body!, 'cancel')
      const request = t.mock.method(globalThis, 'fetch', async () => response)
      const result = await new provider.Tool('synthetic-key').execute({ query: 'docs' })
      assert.match(result, new RegExp(`^Error: ${provider.name} .*${status}`))
      assert.doesNotMatch(result, /private-supplier-detail|synthetic-key/)
      if (status === 429) assert.match(result, /rate limit reached/)
      if (status === 401 || status === 403) assert.match(result, /rejected the API key/)
      assert.equal(request.mock.callCount(), 1)
      assert.equal(cancel.mock.callCount(), 1)
    })
  }

  test(`${provider.name} sanitizes network errors without retrying`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('private-supplier-detail synthetic-key')
    })
    assert.equal(await new provider.Tool('synthetic-key').execute({ query: 'docs' }),
      `Error: ${provider.name} search request failed.`)
    assert.equal(request.mock.callCount(), 1)
  })

  test(`${provider.name} validates count, query, and missing credentials before requesting`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request') })
    const tool = new provider.Tool('synthetic-key')
    for (const count of [0, -1, 1.5, provider.limit + 1, NaN, Infinity, 'invalid', '', ' ', null, true, [], {}]) {
      assert.equal(await tool.execute({ query: 'docs', count }),
        `Error: ${provider.name} result count must be an integer between 1 and ${provider.limit}.`)
    }
    for (const query of [undefined, null, '', '  ', 123, {}]) {
      assert.match(await tool.execute({ query }), /query must be a non-empty string/)
    }
    for (const key of ['', '  ']) {
      assert.match(await new provider.Tool(key).execute({ query: 'docs' }), /requires an API key/)
    }
    assert.equal(request.mock.callCount(), 0)
  })

  test(`${provider.name} accepts minimum and maximum counts`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [] }))
    for (const count of [1, provider.limit]) {
      assert.equal(await new provider.Tool('synthetic').execute({ query: 'docs', count }), 'No results found.')
      const body = JSON.parse(String(request.mock.calls.at(-1)!.arguments[1]?.body))
      assert.equal(body.numResults ?? body.max_results, count)
    }
    assert.equal(request.mock.callCount(), 2)
  })

  test(`${provider.name} rejects pre-cancelled searches without a request`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request') })
    await assert.rejects(new provider.Tool('synthetic').execute({ query: 'docs' }, context(AbortSignal.abort())),
      { name: 'AbortError' })
    assert.equal(request.mock.callCount(), 0)
  })

  test(`${provider.name} propagates in-flight cancellation`, async t => {
    const controller = new AbortController()
    const request = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }))
    const pending = new provider.Tool('synthetic').execute({ query: 'docs' }, context(controller.signal))
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(request.mock.callCount(), 1)
  })

  test(`${provider.name} preserves cancellation while reading response bodies`, async t => {
    const controller = new AbortController()
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const response = new Response()
      t.mock.method(response, 'json', () => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        started()
      }))
      return response
    })
    const pending = new provider.Tool('synthetic').execute({ query: 'docs' }, context(controller.signal))
    await reading
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
  })

  test(`${provider.name} times out after 60 seconds with and without a turn signal`, async t => {
    const deadline = new AbortController()
    const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
    const request = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }))
    const tool = new provider.Tool('synthetic')
    const withContext = tool.execute({ query: 'docs' }, context())
    const withoutContext = tool.execute({ query: 'docs' })
    deadline.abort(new DOMException('Search timed out', 'TimeoutError'))
    await assert.rejects(withContext, { name: 'TimeoutError' })
    await assert.rejects(withoutContext, { name: 'TimeoutError' })
    assert.equal(request.mock.callCount(), 2)
    assert.deepEqual(timeout.mock.calls.map(call => call.arguments), [[60_000], [60_000]])
  })
}
