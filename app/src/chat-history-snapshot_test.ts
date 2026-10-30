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
  const appended: { role: string; content: string }[] = []
  let exists = true
  let authorized = true
  const urls: string[] = []
  const wireBodies: string[] = []
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => exists ? { sessionId: 'web:cached' } : null,
    getContext: async () => ({ systemPrompt: 'Prompt', tools: [] }),
    getHistory: async () => ({ messages: [{ role: 'user', content }, ...appended] }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  registerGatewayRoutes(app, [], { allowedOrigins: ['http://localhost:5273'], authorizeClient: () => authorized })
  // Model outer security middleware and the browser's CORS header filtering.
  app.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
  await channel.start(app)
  const cache = createChatHistorySnapshots((async (url, init) => {
    urls.push(String(url))
    assert.equal(init?.cache, 'no-store')
    const response = await app.request(String(url), { ...init, headers: { Origin: 'http://localhost:5273' } })
    if (response.ok) assert.equal(response.headers.get('Cache-Control'), 'no-store')
    if (response.ok) assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5273')
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
    appended.push({ role: 'system', content: 'context appended in history' }, { role: 'assistant', content: 'reply' })
    const merged = await (await cache.read(url, signal)).json()
    assert.deepEqual(merged.history, [{ role: 'user', content }, ...appended])
    assert.deepEqual(JSON.parse(wireBodies.at(-1)!).delta.history, appended)
    assert.deepEqual(await (await cache.read(url, signal)).json(), merged, 'merged revision supports next revalidation')
    assert.equal(JSON.parse(wireBodies.at(-1)!).unchanged, true)
    exists = false
    assert.equal((await cache.read(url, signal)).status, 404, 'deletion never reuses cached history')
    exists = true
    await cache.read(url, signal)
    assert.equal(new URL(urls.at(-1)!).searchParams.get('snapshot'), '', 'error evicts old history')
    authorized = false
    const denied = await cache.read(url, signal)
    assert.equal(denied.status, 401, 'snapshot cannot bypass gateway authentication')
    authorized = true
    await cache.read(url, signal)
    assert.equal(new URL(urls.at(-1)!).searchParams.get('snapshot'), '', 'auth error evicts cached history')
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
  fail = false
  await cache.read('http://main/projects/a/api/chat/session?chatId=x', signal)
  assert.equal(validators.at(-1), '', 'network failures evict the cached base')
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


test('append merges system and tool messages exactly; malformed bases evict without stitching', async () => {
  const base = [{ role: 'user', content: 'hello' }]
  const suffix = [
    { role: 'system', content: 'context event' },
    { role: 'assistant', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'result' },
  ]
  for (const invalid of [null, { baseRevision: 'b'.repeat(64) }, { baseCount: 0 }, { count: 99 }, { history: {} }]) {
    let calls = 0
    const cache = createChatHistorySnapshots((async url => {
      calls++
      if (calls === 1 || calls === 3) {
        assert.equal(new URL(String(url)).searchParams.get('snapshot'), '')
        return Response.json({ revision, data: { history: base, systemPrompt: 'prompt' } })
      }
      assert.equal(new URL(String(url)).searchParams.get('historyCount'), '1')
      return Response.json({ revision: 'c'.repeat(64), delta: {
        baseRevision: revision, baseCount: 1, count: 4, history: suffix, ...invalid,
      } })
    }) as typeof fetch)
    const signal = new AbortController().signal
    await cache.read('http://main/history', signal)
    if (invalid) {
      await assert.rejects(cache.read('http://main/history', signal), /Invalid history delta/)
      await cache.read('http://main/history', signal)
    } else {
      assert.deepEqual(await (await cache.read('http://main/history', signal)).json(), {
        history: [...base, ...suffix], systemPrompt: 'prompt',
      })
    }
    cache.dispose()
  }
})


test('aborted late append never replaces the validated cached base', async () => {
  let finish!: (response: Response) => void
  let calls = 0
  const cache = createChatHistorySnapshots((async url => {
    calls++
    if (calls === 2) return new Promise<Response>(resolve => { finish = resolve })
    if (calls === 3) assert.equal(new URL(String(url)).searchParams.get('snapshot'), revision)
    return Response.json({ revision, data: { history: [{ role: 'user', content: 'base' }] } })
  }) as typeof fetch)
  const abort = new AbortController()
  await cache.read('http://main/history', abort.signal)
  const pending = cache.read('http://main/history', abort.signal)
  abort.abort()
  finish(Response.json({ revision: 'd'.repeat(64), delta: {
    baseRevision: revision, baseCount: 1, count: 2, history: [{ role: 'assistant', content: 'late' }],
  } }))
  await assert.rejects(pending, /cancelled/)
  await cache.read('http://main/history', new AbortController().signal)
  cache.dispose()
})

test('history block reuse updates metadata with append, prepend and metadata alone; rejects rewrites and rollover', async () => {
  const app = new Hono()
  let segmentIndex = 0
  let systemPrompt = 'old'.repeat(16_000)
  let tools: unknown[] = []
  let decisions: string[] = []
  const history = [{ role: 'user', content: 'x'.repeat(100_000) }]
  const channel = new WebChannel(new Bus(), { sessionManager: {
    getSessionState: () => ({ sessionId: 'web:metadata', segmentIndex }),
    getContext: async () => ({ systemPrompt, tools }),
    getHistory: async () => ({ messages: history }),
    getCommandResults: async () => [], getYieldRecords: async () => decisions,
  } as unknown as SessionManager })
  await channel.start(app)
  const wires: string[] = []
  const cache = createChatHistorySnapshots((async (url, init) => {
    const response = await app.request(String(url), init)
    const text = await response.text()
    wires.push(text)
    return new Response(text, { status: response.status })
  }) as typeof fetch)
  const read = async () => (await cache.read('http://main/api/chat/session?chatId=metadata', new AbortController().signal)).json()
  try {
    await read()
    for (let i = 0; i < 3; i++) {
      history.push({ role: 'assistant', content: `constant context ${i}` })
      const body = await read()
      const wire = JSON.parse(wires.at(-1)!)
      assert.deepEqual(body.history, history)
      assert.equal(body.systemPrompt, systemPrompt)
      assert.equal('metadata' in wire.delta, false)
      assert.equal(wire.delta.baseMetadataRevision, wire.metadataRevision)
      assert.ok(wires.at(-1)!.length < 1000, '48KB metadata is not repeated')
    }
    systemPrompt = 'new'; tools = [{ name: 'read' }]; decisions = ['decision']
    history.push({ role: 'assistant', content: 'answer' })
    const appended = await read()
    assert.deepEqual(appended.history, history)
    assert.equal(appended.systemPrompt, systemPrompt)
    assert.deepEqual(appended.tools, tools)
    assert.deepEqual(appended.decisionRecords, decisions)
    assert.equal(JSON.parse(wires.at(-1)!).delta.history.length, 1)
    assert.ok(wires.at(-1)!.length < 2000, 'metadata change does not replay 100KB prefix')
    history.unshift({ role: 'system', content: 'prepended context' })
    history.push({ role: 'assistant', content: 'another answer' })
    systemPrompt = 'prepended'
    assert.deepEqual((await read()).history, history)
    assert.equal(JSON.parse(wires.at(-1)!).delta.historyOffset, 1)
    assert.ok(wires.at(-1)!.length < 2000)
    systemPrompt = 'metadata only'
    assert.equal((await read()).systemPrompt, systemPrompt)
    assert.deepEqual(JSON.parse(wires.at(-1)!).delta.history, [])
    tools = []; decisions = []; systemPrompt = ''
    const cleared = await read()
    assert.deepEqual(cleared.tools, [])
    assert.deepEqual(cleared.decisionRecords, [])
    assert.equal(cleared.systemPrompt, '')
    assert.ok(JSON.parse(wires.at(-1)!).delta.metadata, 'metadata-only removal is sent')
    history[1] = { role: 'user', content: 'rewritten' }
    assert.deepEqual((await read()).history, history)
    assert.ok(JSON.parse(wires.at(-1)!).data, 'rewritten middle falls back to full')
    segmentIndex++
    assert.equal((await read()).segmentIndex, 1)
    assert.ok(JSON.parse(wires.at(-1)!).data, 'identical history across segments must not splice')
  } finally { cache.dispose(); await channel.stop() }
})

test('malformed block deltas evict rather than splice', async () => {
  const metadata = { chatId: 'x', currentPhysicalId: 'web:x', segmentIndex: 0,
    previousPhysicalId: null, systemPrompt: 'prompt', tools: [], commandResults: [], decisionRecords: [] }
  for (const patch of [
    { baseHistoryRevision: 'b'.repeat(64) }, { metadata: { ...metadata, currentPhysicalId: 'other' } },
    { metadata: { ...metadata, segmentIndex: 1 } }, { metadata: { ...metadata, chatId: 'other' } },
    { metadata: { ...metadata, history: [] } },
    { metadata: {} }, { count: 99 }, { historyOffset: 1 }, { leadingHistory: [null] },
  ]) {
    let calls = 0
    const cache = createChatHistorySnapshots((async url => {
      calls++
      if (calls !== 2) {
        assert.equal(new URL(String(url)).searchParams.get('snapshot'), '')
        return Response.json({ revision, historyRevision: revision, data: { ...metadata, history: [{ role: 'user' }] } })
      }
      assert.equal(new URL(String(url)).searchParams.get('historyRevision'), revision)
      return Response.json({ revision: 'c'.repeat(64), historyRevision: revision, delta: {
        baseRevision: revision, baseHistoryRevision: revision, baseCount: 1, count: 1,
        history: [], leadingHistory: [], historyOffset: 0, metadata, ...patch,
      } })
    }) as typeof fetch)
    const read = () => cache.read('http://main/history', new AbortController().signal)
    await read()
    await assert.rejects(read(), /Invalid history delta/)
    await read()
    cache.dispose()
  }
})

test('metadata references require an exact cached base and reject ambiguous shapes', async () => {
  const metadata = { chatId: 'x', currentPhysicalId: 'web:x', segmentIndex: 0,
    previousPhysicalId: null, systemPrompt: 'prompt', tools: [], commandResults: [], decisionRecords: [] }
  for (const patch of [
    { baseMetadataRevision: null }, { baseMetadataRevision: 'b'.repeat(64) },
    { metadata }, { baseMetadataRevision: undefined },
    { metadata: { ...metadata, chatId: 'other' } },
  ]) {
    let calls = 0
    const cache = createChatHistorySnapshots((async url => {
      calls++
      if (calls !== 2) {
        assert.equal(new URL(String(url)).searchParams.get('snapshot'), '')
        return Response.json({ revision, historyRevision: revision, metadataRevision: revision,
          data: { ...metadata, history: [{ role: 'user' }] } })
      }
      assert.equal(new URL(String(url)).searchParams.get('metadataRevision'), revision)
      return Response.json({ revision: 'c'.repeat(64), historyRevision: revision, metadataRevision: revision, delta: {
        baseRevision: revision, baseHistoryRevision: revision, baseCount: 1, count: 1,
        history: [], leadingHistory: [], historyOffset: 0, baseMetadataRevision: revision, ...patch,
      } })
    }) as typeof fetch)
    const read = () => cache.read('http://main/history', new AbortController().signal)
    await read()
    await assert.rejects(read(), /Invalid history delta/)
    await read()
    cache.dispose()
  }
})

test('metadata reference cannot bootstrap a missing validator or disagree with response revision', async () => {
  const metadata = { chatId: 'x', currentPhysicalId: 'web:x', segmentIndex: 0,
    previousPhysicalId: null, systemPrompt: 'prompt', tools: [], commandResults: [], decisionRecords: [] }
  for (const [baseMetadataRevision, nextMetadataRevision] of [
    [undefined, revision], [revision, 'b'.repeat(64)], [revision, 'malformed'],
  ]) {
    let calls = 0
    const cache = createChatHistorySnapshots((async url => {
      calls++
      if (calls !== 2) {
        assert.equal(new URL(String(url)).searchParams.get('snapshot'), '')
        return Response.json({ revision, historyRevision: revision, metadataRevision: baseMetadataRevision,
          data: { ...metadata, obsolete: true, history: [{ role: 'user' }] } })
      }
      return Response.json({ revision: 'c'.repeat(64), historyRevision: revision, metadataRevision: nextMetadataRevision,
        delta: { baseRevision: revision, baseHistoryRevision: revision, baseCount: 1, count: 1,
          history: [], leadingHistory: [], historyOffset: 0, baseMetadataRevision: revision } })
    }) as typeof fetch)
    const read = () => cache.read('http://main/history', new AbortController().signal)
    await read()
    await assert.rejects(read(), /Invalid/)
    await read()
    cache.dispose()
  }
})

test('complete changed metadata replaces rather than overlays removed fields', async () => {
  const metadata = { chatId: 'x', currentPhysicalId: 'web:x', segmentIndex: 0,
    previousPhysicalId: null, systemPrompt: '', tools: [], commandResults: [], decisionRecords: [] }
  let calls = 0
  const cache = createChatHistorySnapshots((async () => Response.json(++calls === 1
    ? { revision, historyRevision: revision, metadataRevision: revision,
      data: { ...metadata, obsolete: 'removed by next response', history: [{ role: 'user' }] } }
    : { revision: 'c'.repeat(64), historyRevision: revision, metadataRevision: 'b'.repeat(64), delta: {
      baseRevision: revision, baseHistoryRevision: revision, baseCount: 1, count: 1,
      history: [], leadingHistory: [], historyOffset: 0, metadata,
    } })) as typeof fetch)
  const read = async () => (await cache.read('http://main/history', new AbortController().signal)).json()
  assert.equal((await read()).obsolete, 'removed by next response')
  assert.equal('obsolete' in await read(), false)
  cache.dispose()
})
