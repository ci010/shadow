import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { WebChannel } from '../../src/channels/web.ts'
import { Bus } from '../../src/bus/bus.ts'
import type { SessionManager } from '../../src/sessions/session-manager.ts'
import { registerGatewayRoutes } from '../../src/gateway/server.ts'
import { createChatHistorySnapshots } from './chat-history-snapshot.ts'

test('history revalidation works through gateway no-store without readable ETag headers', async () => {
  const app = new Hono()
  let content = 'Initial history'
  let exists = true
  const urls: string[] = []
  const wireBodies: string[] = []
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => exists ? { sessionId: 'web:cached' } : null,
    getContext: async () => ({ systemPrompt: 'Prompt', tools: [] }),
    getHistory: async () => ({ messages: [{ role: 'user', content }] }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  registerGatewayRoutes(app, [], { allowedOrigins: ['http://localhost:5273'], authorizeClient: () => true })
  // Model outer security middleware and the browser's CORS header filtering.
  app.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  await channel.start(app)
  const cache = createChatHistorySnapshots((async (url, init) => {
    urls.push(String(url))
    assert.equal(init?.cache, 'no-store')
    const response = await app.request(String(url), { ...init, headers: { Origin: 'http://localhost:5273' } })
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5273')
    const text = await response.text()
    wireBodies.push(text)
    return new Response(text, { status: response.status })
  }) as typeof fetch)
  const signal = new AbortController().signal
  const url = 'http://localhost/api/chat/session?chatId=cached'
  try {
    const first = await (await cache.read(url, signal)).json()
    const second = await (await cache.read(url, signal)).json()
    assert.deepEqual(second, first)
    assert.equal(new URL(urls[0]).searchParams.get('snapshot'), '')
    assert.match(new URL(urls[1]).searchParams.get('snapshot')!, /^[a-f0-9]{64}$/)
    assert.equal(JSON.parse(wireBodies[1]).unchanged, true)
    assert.ok(wireBodies[1].length < 110, 'unchanged response contains no history')
    content = 'Changed history'
    assert.notDeepEqual(await (await cache.read(url, signal)).json(), first)
    exists = false
    assert.equal((await cache.read(url, signal)).status, 404, 'deletion never reuses cached history')
    exists = true
    await cache.read(url, signal)
    assert.equal(new URL(urls.at(-1)!).searchParams.get('snapshot'), '', 'error evicts old history')
    cache.dispose()
    await assert.rejects(cache.read(url, signal), /disposed/)
  } finally { cache.dispose(); await channel.stop() }
})

const revision = 'a'.repeat(64)
test('snapshots are bounded, URL/project isolated and never used on network failures', async () => {
  const validators: string[] = []
  let fail = false
  const cache = createChatHistorySnapshots((async url => {
    if (fail) throw new Error('offline')
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return Response.json({ revision, data: { history: [] } })
  }) as typeof fetch, 1024, 1)
  const signal = new AbortController().signal
  await cache.read('http://main/projects/a/api/chat/session?chatId=x', signal)
  await cache.read('http://main/projects/b/api/chat/session?chatId=x', signal)
  await cache.read('http://main/projects/a/api/chat/session?chatId=x', signal)
  assert.deepEqual(validators, ['', '', ''], 'entry limit evicts other Project snapshot')
  fail = true
  await assert.rejects(cache.read('http://main/projects/a/api/chat/session?chatId=x', signal), /offline/)
  cache.dispose()
})

test('oversize snapshots and aborted reads never populate cache', async () => {
  const validators: string[] = []
  const controller = new AbortController()
  const cache = createChatHistorySnapshots((async url => {
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return Response.json({ revision, data: { history: ['large history'] } })
  }) as typeof fetch, 1)
  await cache.read('http://main/history', controller.signal)
  await cache.read('http://main/history', controller.signal)
  assert.deepEqual(validators, ['', ''])
  controller.abort()
  await assert.rejects(cache.read('http://main/history', controller.signal), /cancelled/)
  cache.dispose()
})

test('invalid envelopes and late responses cannot resurrect a disposed snapshot pool', async () => {
  const signal = new AbortController().signal
  const invalid = createChatHistorySnapshots((async () => Response.json({ revision, unchanged: true })) as typeof fetch)
  await assert.rejects(invalid.read('http://main/history', signal), /unavailable/)
  invalid.dispose()
  let finish!: (value: Response) => void
  const pending = createChatHistorySnapshots((() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch)
  const result = pending.read('http://main/history', signal)
  pending.dispose()
  finish(Response.json({ revision, data: { history: [] } }))
  await assert.rejects(result, /cancelled/)
})
