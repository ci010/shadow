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
const defaultMetadata = { chatId: 'x', currentPhysicalId: 'web:x', previousPhysicalId: null, segmentIndex: 0,
  systemPrompt: '', tools: [], commandResults: [], decisionRecords: [] }
const full = (body: Record<string, unknown>) => ({ revision, historyRevision: revision,
  metadataVersions: { systemPrompt: revision, tools: revision, commandResults: revision, decisionRecords: revision }, data: body })
test('snapshots are bounded, URL/project isolated and never used on network failures', async () => {
  const validators: string[] = []
  let fail = false
  const cache = createChatHistorySnapshots((async url => {
    if (fail) throw new Error('offline')
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return Response.json(full({ ...defaultMetadata, history: [] }))
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
    return Response.json(full({ ...defaultMetadata, history: [{ role: 'user', content: 'large history' }] }))
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
  finish(Response.json(full({ ...defaultMetadata, history: [] })))
  await assert.rejects(result, /cancelled/)
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
      assert.deepEqual(wire.delta.metadataPatch, {})
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
    assert.ok(JSON.parse(wires.at(-1)!).delta.metadataPatch, 'metadata-only removal is sent')
    history[1] = { role: 'user', content: 'rewritten' }
    assert.deepEqual((await read()).history, history)
    assert.ok(JSON.parse(wires.at(-1)!).data, 'rewritten middle falls back to full')
    segmentIndex++
    assert.equal((await read()).segmentIndex, 1)
    assert.ok(JSON.parse(wires.at(-1)!).data, 'identical history across segments must not splice')
  } finally { cache.dispose(); await channel.stop() }
})

test('UTF-8 budget includes escaping, non-ASCII and lone surrogates, ignoring compressed length headers', async () => {
  for (const content of ['ascii', '中文😀', '\u0000\b\t\n\f\r"\\', '\ud800x\udfff', 'é'.repeat(128)]) {
    const body = { ...defaultMetadata, history: [{ role: 'user', content }], number: 1e30, bool: false, nil: null }
    const exact = Buffer.byteLength(JSON.stringify(body))
    for (const budget of [exact - 1, exact]) {
      const validators: string[] = []
      const cache = createChatHistorySnapshots((async url => {
        validators.push(new URL(String(url)).searchParams.get('snapshot')!)
        return Response.json(full(body), { headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' } })
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
    return Response.json(validator ? { revision, unchanged: true } : full({ ...defaultMetadata, history: [] }))
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
  const body = { ...defaultMetadata, history: [{ role: 'user', get content() { contentReads++; return content } }] }
  const validators: string[] = []
  const cache = createChatHistorySnapshots((async url => {
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return { ok: true, status: 200, json: async () => { jsonCalls++; return full(body) } } as Response
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
  const body = { ...defaultMetadata, history: [{ role: 'user', content: '中文😀'.repeat(10) }] }
  const validators: string[] = []
  const cache = createChatHistorySnapshots((async url => {
    validators.push(new URL(String(url)).searchParams.get('snapshot')!)
    return Response.json(full(body))
  }) as typeof fetch, Buffer.byteLength(JSON.stringify(body)) * 2 - 1, 8)
  for (const key of ['a', 'b', 'a']) await cache.read(`http://main/${key}`, new AbortController().signal)
  assert.deepEqual(validators, ['', '', ''], 'byte budget, not entry count, evicts the prior entry')
})


test('multi-image 17.86/18MiB trees fail the length-only screen before any content scan', async () => {
  for (const mib of [17.86, 18]) {
    const total = Math.floor(mib * 1024 * 1024)
    const imageSizes = [5, 4, 3, 2, 1].map(n => n * 1024 * 1024)
    const body = { ...defaultMetadata,
      history: imageSizes.map(size => ({ role: 'user', content: [{ type: 'image', data: 'a'.repeat(size) }] })),
      metadata: { prompt: 'p'.repeat(total - imageSizes.reduce((a, b) => a + b, 0)), tools: ['read'] },
    }
    const validators: string[] = []
    const cache = createChatHistorySnapshots((async url => {
      validators.push(new URL(String(url)).searchParams.get('snapshot')!)
      return { ok: true, status: 200, json: async () => (full(body)) } as Response
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
    { ...defaultMetadata, history: [1, 2, 3].map(() => ({ role: 'user', image: 'a'.repeat(1024 * 1024) })) },
    { ...defaultMetadata, history: [], 'escaped"\\\nkey': ['😀'.repeat(1024), '\ud800', '\u0000', '\\', '"'] },
    { ...defaultMetadata, history: [], deep },
  ]) {
    const exact = Buffer.byteLength(JSON.stringify(body))
    for (const budget of [exact - 1, exact]) {
      const validators: string[] = []
      const cache = createChatHistorySnapshots((async url => {
        validators.push(new URL(String(url)).searchParams.get('snapshot')!)
        return { ok: true, status: 200, json: async () => (full(body)) } as Response
      }) as typeof fetch, budget)
      for (let i = 0; i < 2; i++) await cache.read('http://main/history', new AbortController().signal)
      assert.equal(validators[1], budget === exact && !('deep' in body) ? revision : '')
      cache.dispose()
    }
  }
})

/** Real responder + loader fixture; all payloads are synthetic. */
async function fixture() {
  const app = new Hono()
  const state = { segmentIndex: 0, systemPrompt: 'prompt'.repeat(4000),
    tools: [{ name: 'synthetic', description: 'large description '.repeat(12000), schema: { type: 'object' } }],
    commandResults: [] as unknown[], decisionRecords: [] as unknown[], history: [{ role: 'user', content: 'hello' }] }
  let rolloverDuringRead = false
  const channel = new WebChannel(new Bus(), { authorize: () => true, sessionManager: {
    getSessionState: () => ({ sessionId: 'web:x', segmentIndex: state.segmentIndex }),
    getContext: async () => { if (rolloverDuringRead) state.segmentIndex++; return { systemPrompt: state.systemPrompt, tools: state.tools } },
    getHistory: async () => ({ messages: state.history }),
    getCommandResults: async () => state.commandResults, getYieldRecords: async () => state.decisionRecords,
  } as unknown as SessionManager })
  await channel.start(app)
  const wires: any[] = [], urls: string[] = []
  let corrupt: ((wire: any) => void) | undefined
  let delay = false
  const held: (() => void)[] = []
  const cache = createChatHistorySnapshots((async (url, init) => {
    urls.push(String(url))
    const response = await app.request(String(url), init)
    const wire = await response.json()
    corrupt?.(wire)
    wires.push(wire)
    if (delay) await new Promise<void>(resolve => held.push(resolve))
    return Response.json(wire, { status: response.status })
  }) as typeof fetch)
  const url = 'http://main/api/chat/session?chatId=x'
  const read = (signal = new AbortController().signal) => cache.read(url, signal)
  return { app, state, wires, urls, cache, read, held,
    corrupt: (fn?: (wire: any) => void) => { corrupt = fn }, delay: (value: boolean) => { delay = value },
    rollover: () => { rolloverDuringRead = true }, close: async () => { cache.dispose(); await channel.stop() } }
}

test('field patches replace receipts, decisions, schemas and prompt independently, including empty fields', async t => {
  const f = await fixture()
  try {
    await f.read()
    for (const [field, value] of [
      ['commandResults', [{ id: 'receipt' }]], ['decisionRecords', [{ id: 'decision' }]],
      ['tools', [{ ...f.state.tools[0], schema: { type: 'string' } }]], ['systemPrompt', 'changed'],
      ['commandResults', []], ['decisionRecords', []], ['tools', []], ['systemPrompt', ''],
    ] as const) {
      Object.assign(f.state, { [field]: value })
      const body = data(await f.read())
      assert.deepEqual(body[field], value)
      const wire = f.wires.at(-1)
      assert.deepEqual(Object.keys(wire.delta.metadataPatch), [field])
      assert.deepEqual(wire.delta.history, [])
      assert.ok(f.urls.at(-1)!.length < 650, 'bounded request contains only six hashes and count')
      if (field === 'commandResults' && value.length) {
        const { history: _, ...metadata } = body
        // Same history delta with the previous whole-metadata representation.
        const { metadataPatch: __, identity: ___, ...oldDelta } = wire.delta
        const { metadataVersions: ____, ...oldEnvelope } = wire
        const oldBytes = Buffer.byteLength(JSON.stringify({ ...oldEnvelope, metadataRevision: revision, delta: { ...oldDelta, metadata } }))
        const newBytes = Buffer.byteLength(JSON.stringify(wire))
        t.diagnostic(`synthetic receipt-only JSON bytes: whole-metadata=${oldBytes}, field-patch=${newBytes}, saved=${oldBytes - newBytes} (${((1 - newBytes / oldBytes) * 100).toFixed(2)}%)`)
        assert.ok(newBytes < oldBytes / 100)
      }
    }
    // Empty history is also a legitimate exact base, including metadata-only updates.
    f.state.history = []
    await f.read()
    f.state.decisionRecords = ['new']
    assert.deepEqual(data(await f.read()).decisionRecords, ['new'])
    assert.equal(f.wires.at(-1).delta.baseCount, 0)
    f.state.segmentIndex++
    assert.equal(data(await f.read()).segmentIndex, 1)
    assert.ok(f.wires.at(-1).data)
    f.rollover()
    assert.equal((await f.read()).status, 409, 'mid-read rollover never labels old context as new segment')
  } finally { await f.close() }
})

test('invalid response versions, omitted changed fields and identity changes fail closed and evict', async () => {
  for (const corrupt of [
    (w: any) => { delete w.metadataVersions.tools },
    (w: any) => { w.metadataVersions.tools = 'bad' },
    (w: any) => { w.metadataVersions.extra = revision },
    (w: any) => { delete w.delta.metadataPatch.decisionRecords },
    (w: any) => { w.delta.identity.chatId = 'other' },
    (w: any) => { w.delta.identity.currentPhysicalId = 'other' },
    (w: any) => { w.delta.identity.segmentIndex++ },
    (w: any) => { w.delta.metadataPatch.tools = null },
    (w: any) => { w.delta.metadataPatch.history = [] },
    (w: any) => { w.delta.baseRevision = revision },
    (w: any) => { w.delta.baseHistoryRevision = revision },
    (w: any) => { w.delta.baseCount = 99 },
    (w: any) => { w.delta.historyOffset = 1 },
    (w: any) => { w.delta.leadingHistory = [null] },
  ]) {
    const f = await fixture()
    try {
      await f.read()
      f.state.decisionRecords = ['changed']
      f.corrupt(corrupt)
      await assert.rejects(f.read(), /Invalid/)
      f.corrupt()
      assert.deepEqual(data(await f.read()).decisionRecords, ['changed'])
      assert.equal(new URL(f.urls.at(-1)!).searchParams.get('snapshot'), '')
    } finally { await f.close() }
  }
})

test('concurrent and aborted real responses use captured bases without regressing cache or leaking caller mutations', async () => {
  const f = await fixture()
  const waitHeld = async (n: number) => { for (let i = 0; f.held.length < n && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(f.held.length, n) }
  try {
    const first = data(await f.read())
    ;(first.tools as any[])[0].schema.type = 'polluted'
    f.delay(true)
    f.state.decisionRecords = ['older']
    const old = f.read()
    await waitHeld(1)
    f.state.decisionRecords = ['newer']
    f.state.tools[0].schema.type = 'number'
    const newer = f.read()
    await waitHeld(2)
    f.held[1]()
    const latest = data(await newer)
    assert.deepEqual(latest.decisionRecords, ['newer'])
    const latestRevision = f.wires.at(-1).revision
    f.held[0]()
    assert.deepEqual(data(await old).decisionRecords, ['older'])
    f.delay(false)
    ;(latest.tools as any[])[0].schema.type = 'polluted again'
    assert.equal((data(await f.read()).tools as any[])[0].schema.type, 'number')
    assert.equal(new URL(f.urls.at(-1)!).searchParams.get('snapshot'), latestRevision)
    assert.equal(f.wires.at(-1).unchanged, true)
    f.delay(true)
    const controller = new AbortController()
    f.state.commandResults = ['aborted']
    const aborted = f.read(controller.signal)
    await waitHeld(3)
    controller.abort(); f.held[2]()
    await assert.rejects(aborted, /cancelled/)
    f.delay(false)
    assert.deepEqual(data(await f.read()).commandResults, ['aborted'])
    assert.equal(new URL(f.urls.at(-1)!).searchParams.get('snapshot'), latestRevision)
  } finally { await f.close() }
})
