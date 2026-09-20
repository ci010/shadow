import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSearchTool } from './web-provider.ts'
import { detectSearXNG, FirecrawlSearchTool, SearXNGSearchTool, WebSearchTool } from './web.ts'
import { Tools, SessionTools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

function context(signal = new AbortController().signal): ExecutionContext {
  return {
    signal, channel: 'web', chatId: 'test', senderId: 'test', messageId: 'test',
    sessionId: 'web:test', physicalSessionId: 'physical-test',
    tools: new SessionTools(new Tools(process.cwd()), process.cwd()),
  }
}

test('configured search providers never probe the network at construction or discovery', async t => {
  const detect = t.mock.fn(async () => { throw new Error('Unexpected discovery') })
  assert.ok(createWebSearchTool({ firecrawlApiKey: 'synthetic', braveApiKey: 'synthetic' }, detect) instanceof FirecrawlSearchTool)
  assert.ok(createWebSearchTool({ braveApiKey: 'synthetic' }, detect) instanceof WebSearchTool)
  const tool = createWebSearchTool({}, detect)
  assert.equal(tool.name, 'web_search')
  assert.ok(tool.parameters)
  assert.equal(detect.mock.callCount(), 0)
})

test('local discovery runs on first search only and preserves SearXNG priority', async t => {
  const detect = t.mock.fn(async () => 'http://synthetic')
  const execute = t.mock.method(SearXNGSearchTool.prototype, 'execute', async () => 'local result')
  const tool = createWebSearchTool({}, detect)
  assert.equal(detect.mock.callCount(), 0)
  assert.equal(await tool.execute({ query: 'first' }, context()), 'local result')
  assert.equal(await tool.execute({ query: 'second' }, context()), 'local result')
  assert.equal(detect.mock.callCount(), 1)
  assert.equal(execute.mock.callCount(), 2)
})

test('no local search selects the existing keyless fallback without startup work', async t => {
  const detect = t.mock.fn(async () => null)
  t.mock.method(FirecrawlSearchTool.prototype, 'execute', async () => 'fallback result')
  const tool = createWebSearchTool({}, detect)
  assert.equal(detect.mock.callCount(), 0)
  assert.equal(await tool.execute({ query: 'first' }, context()), 'fallback result')
  assert.equal(await tool.execute({ query: 'second' }, context()), 'fallback result')
  assert.equal(detect.mock.callCount(), 1)
})

test('cancelled lazy discovery never sends search or caches a false fallback', async t => {
  const controller = new AbortController()
  let calls = 0
  const tool = createWebSearchTool({}, async signal => {
    calls++
    if (calls === 1) {
      assert.equal(signal, controller.signal)
      controller.abort()
    }
    return null
  })
  const execute = t.mock.method(FirecrawlSearchTool.prototype, 'execute', async () => 'ok')
  await assert.rejects(tool.execute({ query: 'cancelled' }, context(controller.signal)), { name: 'AbortError' })
  assert.equal(execute.mock.callCount(), 0)
  assert.equal(await tool.execute({ query: 'retry' }, context()), 'ok')
  assert.equal(calls, 2)
})

test('SearXNG discovery observes abort and releases probe response bodies', async t => {
  const before = process.env.SEARXNG_URL
  delete process.env.SEARXNG_URL
  t.after(() => { if (before === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = before })
  const cancelled = t.mock.fn()
  const request = t.mock.method(globalThis, 'fetch', async () =>
    new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }))
  assert.equal(await detectSearXNG(), 'http://localhost:8888')
  assert.equal(cancelled.mock.callCount(), 8)
  const signal = AbortSignal.abort()
  await assert.rejects(detectSearXNG(signal), { name: 'AbortError' })
  assert.equal(request.mock.callCount(), 8)
})

test('aborting in-flight discovery cancels every probe without starting HTML retries', async t => {
  const before = process.env.SEARXNG_URL
  delete process.env.SEARXNG_URL
  t.after(() => { if (before === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = before })
  let aborted = 0
  const request = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason) }, { once: true })
    }))
  const controller = new AbortController()
  const detecting = detectSearXNG(controller.signal)
  controller.abort()
  await assert.rejects(detecting, { name: 'AbortError' })
  assert.equal(request.mock.callCount(), 8)
  assert.equal(aborted, 8)
})
