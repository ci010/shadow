import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { WebChannel } from '../../src/channels/web.ts'
import { Bus } from '../../src/bus/bus.ts'
import type { SessionManager } from '../../src/sessions/session-manager.ts'
import { registerGatewayRoutes } from '../../src/gateway/server.ts'
import { createChatHistorySnapshots, type ChatHistorySnapshotResult } from './chat-history-snapshot.ts'

function data(result: ChatHistorySnapshotResult): Record<string, unknown> {
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(`Unexpected history status ${result.status}`)
  return result.data
}

test('history revalidation works through gateway no-store without readable ETag headers', async () => {
  const app = new Hono()
  let content = 'Initial history'
  const appended: { role: string; content: string }[] = []
  let exists = true
  let authorized = true
  const urls: string[] = []
  const wireBodies: string[] = []
  const channel = new WebChannel(new Bus(), { authorize: () => true, sessionManager: {
    getSessionState: () => exists ? { sessionId: 'web:cached' } : null,
    getContext: async () => ({ systemPrompt: 'Prompt', tools: [] }),
    getHistory: async () => ({ messages: [{ role: 'user', content }, ...appended] }),
    getCommandResults: async () => [], getYieldRecords: async () => [],
  } as unknown as SessionManager })
  registerGatewayRoutes(app, [], {
    allowedOrigins: ['http://localhost:5273'],
    launchCredential: 'synthetic-snapshot-test-credential',
    authorizeClient: () => authorized,
  }, {})
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
    const first = data(await cache.read(url, signal))
    const second = data(await cache.read(url, signal))
    assert.deepEqual(second, first)
    assert.equal(new URL(urls[0]).searchParams.get('snapshot'), '')
    assert.match(new URL(urls[1]).searchParams.get('snapshot')!, /^[a-f0-9]{64}$/)
    assert.equal(JSON.parse(wireBodies[1]).unchanged, true)
    assert.ok(wireBodies[1].length < 110, 'unchanged response contains no history')
    content = 'Changed history'
    assert.notDeepEqual(data(await cache.read(url, signal)), first)
    appended.push({ role: 'system', content: 'context appended in history' }, { role: 'assistant', content: 'reply' })
    const merged = data(await cache.read(url, signal))
    assert.deepEqual(merged.history, [{ role: 'user', content }, ...appended])
    assert.deepEqual(JSON.parse(wireBodies.at(-1)!).delta.history, appended)
    assert.deepEqual(data(await cache.read(url, signal)), merged, 'merged revision supports next revalidation')
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
      assert.deepEqual(data(await cache.read('http://main/history', signal)), {
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
  const channel = new WebChannel(new Bus(), { authorize: () => true, sessionManager: {
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
  const read = async () => data(await cache.read('http://main/api/chat/session?chatId=metadata', new AbortController().signal))
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
  const read = async () => data(await cache.read('http://main/history', new AbortController().signal))
  assert.equal((await read()).obsolete, 'removed by next response')
  assert.equal('obsolete' in await read(), false)
  cache.dispose()
})


test('returned full, unchanged and delta bodies cannot mutate the private revision base', async () => {
  let calls = 0
  const cache = createChatHistorySnapshots((async () => {
    calls++
    if (calls === 1) return Response.json({ revision, data: {
      history: [{ role: 'user', content: { nested: ['original'] } }], tools: [{ name: 'read' }],
    } })
    if (calls === 3) return Response.json({ revision: 'b'.repeat(64), delta: {
      baseRevision: revision, baseCount: 1, count: 2, history: [{ role: 'assistant', content: 'next' }],
    } })
    return Response.json({ revision: calls > 3 ? 'b'.repeat(64) : revision, unchanged: true })
  }) as typeof fetch)
  const read = async () => data(await cache.read('http://main/history', new AbortController().signal))
  const expected = { history: [{ role: 'user', content: { nested: ['original'] } }], tools: [{ name: 'read' }] }
  const mutate = (body: Record<string, unknown>) => {
    const history = body.history as Array<{ content: { nested: string[] } }>
    history[0].content.nested[0] = 'polluted'
    history.pop()
    ;(body.tools as Array<{ name: string }>)[0].name = 'polluted'
  }
  mutate(await read())
  const unchanged = await read()
  assert.deepEqual(unchanged, expected)
  mutate(unchanged)
  const delta = await read()
  const merged = { ...expected, history: [...expected.history, { role: 'assistant', content: 'next' }] }
  assert.deepEqual(delta, merged)
  mutate(delta)
  assert.deepEqual(await read(), merged)
})

test('UTF-8 budget includes escaping, non-ASCII and lone surrogates, ignoring compressed length headers', async () => {
  for (const content of ['ascii', '中文😀', '\u0000\b\t\n\f\r"\\', '\ud800x\udfff', 'é'.repeat(128)]) {
    const body = { history: [{ role: 'user', content }], number: 1e30, bool: false, nil: null }
    const exact = Buffer.byteLength(JSON.stringify(body))
    for (const budget of [exact - 1, exact]) {
      const validators: string[] = []
      const cache = createChatHistorySnapshots((async url => {
        validators.push(new URL(String(url)).searchParams.get('snapshot')!)
        return Response.json({ revision, data: body }, { headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' } })
      }) as typeof fetch, budget)
      await cache.read('http://main/history', new AbortController().signal)
      await cache.read('http://main/history', new AbortController().signal)
      assert.equal(validators[1], budget === exact ? revision : '', `${JSON.stringify(content)} budget=${budget}`)
    }
  }
})

test('validated unchanged reads refresh LRU, access errors preserve the original non-2xx response', async () => {
  const validators: string[] = []
  const denied = new Response('denied', { status: 403 })
  let fail = false
  const cache = createChatHistorySnapshots((async url => {
    const validator = new URL(String(url)).searchParams.get('snapshot')!
    validators.push(validator)
    if (fail) return denied
    return Response.json(validator ? { revision, unchanged: true } : { revision, data: { history: [] } })
  }) as typeof fetch, 1024, 2)
  const read = (key: string) => cache.read(`http://main/${key}`, new AbortController().signal)
  await read('a'); await read('b'); await read('a'); await read('c'); await read('a'); await read('b')
  assert.deepEqual(validators, ['', '', revision, '', revision, ''])
  fail = true
  const result = await read('b')
  assert.equal(result.ok, false)
  if (result.ok) assert.fail('denied history must not be returned')
  assert.equal(result.response, denied)
  assert.equal(await result.response.text(), 'denied')
  fail = false
  await read('b')
  assert.equal(validators.at(-1), '')
})

test('18MiB parsed history bypasses cache without serialization, encoding or a second parse', async () => {
  let jsonCalls = 0
  let stringifyCalls = 0
  let encodeCalls = 0
  let contentReads = 0
  const content = 'x'.repeat(18 * 1024 * 1024)
  const body = { history: [{ role: 'user', get content() { contentReads++; return content } }] }
  const validators: string[] = []
  const cache = createChatHistorySnapshots((async url => {
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return { ok: true, status: 200, json: async () => { jsonCalls++; return { revision, data: body } } } as Response
  }) as typeof fetch)
  const stringify = JSON.stringify
  const encode = TextEncoder.prototype.encode
  try {
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { stringifyCalls++; return stringify(...args) }) as typeof JSON.stringify
    TextEncoder.prototype.encode = function (...args) { encodeCalls++; return encode.apply(this, args) }
    for (let i = 0; i < 2; i++) {
      const result = await cache.read('http://main/history', new AbortController().signal)
      assert.equal(data(result), body, 'uncached parsed object transfers directly without cloning')
    }
  } finally { JSON.stringify = stringify; TextEncoder.prototype.encode = encode }
  assert.deepEqual(validators, ['', ''], '18MiB must not bypass the 16MiB limit')
  assert.equal(jsonCalls, 2)
  assert.equal(contentReads, 2, 'one budget inspection per read, no walk/copy of huge string')
  assert.equal(stringifyCalls, 0)
  assert.equal(encodeCalls, 0)
})


test('aggregate UTF-8 bytes evict LRU even when each entry fits individually', async () => {
  const body = { history: [{ role: 'user', content: '中文😀'.repeat(10) }] }
  const validators: string[] = []
  const cache = createChatHistorySnapshots((async url => {
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return Response.json({ revision, data: body })
  }) as typeof fetch, Buffer.byteLength(JSON.stringify(body)) * 2 - 1, 8)
  for (const key of ['a', 'b', 'a']) await cache.read(`http://main/${key}`, new AbortController().signal)
  assert.deepEqual(validators, ['', '', ''], 'byte budget, not entry count, evicts the prior entry')
})


test('multi-image 17.86/18MiB trees fail the length-only screen before any content scan', async () => {
  for (const mib of [17.86, 18]) {
    const total = Math.floor(mib * 1024 * 1024)
    const imageSizes = [5, 4, 3, 2, 1].map(n => n * 1024 * 1024)
    const body = {
      history: imageSizes.map(size => ({ role: 'user', content: [{ type: 'image', data: 'a'.repeat(size) }] })),
      metadata: { prompt: 'p'.repeat(total - imageSizes.reduce((a, b) => a + b, 0)), tools: ['read'] },
    }
    const validators: string[] = []
    const cache = createChatHistorySnapshots((async url => {
      validators.push(new URL(String(url)).searchParams.get('snapshot')!)
      return { ok: true, status: 200, json: async () => ({ revision, data: body }) } as Response
    }) as typeof fetch)
    const charCodeAt = String.prototype.charCodeAt
    const stringify = JSON.stringify
    const encode = TextEncoder.prototype.encode
    const regexTest = RegExp.prototype.test
    let chars = 0, serializations = 0, encodings = 0, largeRegexScans = 0
    try {
      String.prototype.charCodeAt = function (i) { chars++; return charCodeAt.call(this, i) }
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { serializations++; return stringify(...args) }) as typeof JSON.stringify
      TextEncoder.prototype.encode = function (...args) { encodings++; return encode.apply(this, args) }
      RegExp.prototype.test = function (s) { if (s.length > 1024) largeRegexScans++; return regexTest.call(this, s) }
      for (let i = 0; i < 2; i++) assert.equal(data(await cache.read('http://main/history', new AbortController().signal)), body)
    } finally {
      String.prototype.charCodeAt = charCodeAt
      JSON.stringify = stringify
      TextEncoder.prototype.encode = encode
      RegExp.prototype.test = regexTest
      cache.dispose()
    }
    assert.deepEqual(validators, ['', ''], `${mib}MiB aggregate must not cache`)
    assert.deepEqual({ chars, serializations, encodings, largeRegexScans }, { chars: 0, serializations: 0, encodings: 0, largeRegexScans: 0 })
  }
})

test('large ASCII images fit exact boundary while escaped keys, emoji and deep objects remain safe', async () => {
  let deep: unknown = 'leaf'
  for (let i = 0; i < 105; i++) deep = { child: deep }
  for (const body of [
    { history: [1, 2, 3].map(() => ({ image: 'a'.repeat(1024 * 1024) })) },
    { 'escaped"\\\nkey': ['😀'.repeat(1024), '\ud800', '\u0000', '\\', '"'] },
    { deep },
  ]) {
    const exact = Buffer.byteLength(JSON.stringify(body))
    for (const budget of [exact - 1, exact]) {
      const validators: string[] = []
      const cache = createChatHistorySnapshots((async url => {
        validators.push(new URL(String(url)).searchParams.get('snapshot')!)
        return { ok: true, status: 200, json: async () => ({ revision, data: body }) } as Response
      }) as typeof fetch, budget)
      for (let i = 0; i < 2; i++) await cache.read('http://main/history', new AbortController().signal)
      assert.equal(validators[1], budget === exact && !('deep' in body) ? revision : '')
      cache.dispose()
    }
  }
})
