import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createSummaryResponder } from './summary-delta.ts'
import { createSessionSummaryLoader } from '../../app/src/session-summary-snapshot.ts'

test('summary deltas are reader-owned, project scoped, set deletion safe and bounded', async () => {
  const app = new Hono()
  const respond = createSummaryResponder(1024 * 1024, 3)
  let rows = Array.from({ length: 100 }, (_, i) => ({ sessionId: `s${i}`, title: 'x'.repeat(200), lastActivityAt: '2026-01-01T00:00:00Z' }))
  app.get('/:project/api/sessions/summary', c => respond(c, c.req.param('project'), { sessions: rows }))
  const responses: Array<{ status: number; bytes: number; json?: any; etag: string | null }> = []
  const request: typeof fetch = async (input, init) => {
    const response = await app.request(String(input), init)
    const text = await response.clone().text()
    responses.push({ status: response.status, bytes: Buffer.byteLength(text), json: text ? JSON.parse(text) : undefined, etag: response.headers.get('ETag') })
    return response
  }
  const a = createSessionSummaryLoader('http://main/a', 'a', request)
  const slow = createSessionSummaryLoader('http://main/a', 'a', request)
  const load = (reader: typeof a) => reader.load(new AbortController().signal)
  await load(a); await load(slow)
  rows = rows.map((row, i) => i === 5 ? { ...row, lastActivityAt: '2026-01-02T00:00:00Z' } : row)
  await load(a)
  assert.equal(responses.at(-1)!.json.upsert.length, 1)
  assert.ok(responses.at(-1)!.bytes < responses[0]!.bytes / 10)
  assert.equal((await load(slow)).find(row => row.sessionId === 's5')!.lastActivityAt, '2026-01-02T00:00:00Z')
  rows = rows.slice(1).reverse()
  const result = await load(a)
  assert.equal(result.length, 99)
  assert.equal(result[0]!.sessionId, 's5')
  assert.deepEqual(responses.at(-1)!.json.removed, ['s0'])
  await load(a)
  assert.equal(responses.at(-1)!.status, 304)
  // Even a forged matching base from another Project cannot select its history.
  const cross = await app.request('http://main/b/api/sessions/summary', { headers: {
    'Accept': 'application/vnd.shadow.session-summary-delta+json', 'If-None-Match': responses[0]!.etag!,
  } })
  assert.ok((await cross.json()).sessions)
  // Legacy readers always receive a complete representation, not a patch.
  const legacy = await app.request('http://main/a/api/sessions/summary', { headers: { 'If-None-Match': responses[0]!.etag! } })
  assert.ok((await legacy.json()).sessions)
  a.clear(); await load(a)
  assert.ok(responses.at(-1)!.json.sessions)
  const tiny = createSummaryResponder(1)
  const tinyApp = new Hono()
  tinyApp.get('/tiny', c => tiny(c, 'a', { sessions: rows }))
  const first = await tinyApp.request('http://main/tiny')
  rows = rows.slice(1)
  const evicted = await tinyApp.request('http://main/tiny', { headers: { 'Accept': 'application/vnd.shadow.session-summary-delta+json', 'If-None-Match': first.headers.get('ETag')! } })
  assert.ok((await evicted.json()).sessions)
})


test('immutable summary transport skips serialization on 304 and serializes only changed rows', async () => {
  let encodes = 0
  const row = (sessionId: string, title: string) => ({ sessionId, title,
    toJSON() { encodes++; return { sessionId, title } } })
  let rows = [row('a', 'A'), row('b', 'B')]
  const app = new Hono(), respond = createSummaryResponder(undefined, undefined, true)
  app.get('/summary', c => respond(c, 'p', { sessions: rows }))
  const first = await app.request('/summary')
  assert.equal(encodes, 2)
  const same = await app.request('/summary', { headers: { 'If-None-Match': first.headers.get('ETag')! } })
  assert.equal(same.status, 304); assert.equal(encodes, 2)
  rows = [row('a', 'Changed'), rows[1]]
  const changed = await app.request('/summary')
  assert.equal(encodes, 3)
  assert.equal((await changed.json()).sessions[0].title, 'Changed')
})


test('canonical set validators and order-free 830-row responder/loader patches', async t => {
  for (const immutable of [false, true]) {
    const app = new Hono(), respond = createSummaryResponder(undefined, undefined, immutable)
    let rows = Array.from({ length: 830 }, (_, i) => ({
      sessionId: `web:chat-${String(i).padStart(36, '0')}`, title: 'Synthetic title '.repeat(20),
      lastActivityAt: '2026-01-01T00:00:00Z',
    }))
    app.get('/a/api/sessions/summary', c => respond(c, 'a', { sessions: rows }))
    let wire: any, wireBytes = 0, status = 0, etag: string | null = null
    const loader = createSessionSummaryLoader('http://main/a', 'a', async (input, init) => {
      const response = await app.request(String(input), init)
      const text = await response.clone().text()
      wire = text ? JSON.parse(text) : undefined; wireBytes = Buffer.byteLength(text)
      status = response.status; etag = response.headers.get('ETag')
      return response
    })
    const load = () => loader.load(new AbortController().signal)
    const first = await load(), firstTag = etag, fullBytes = wireBytes
    rows.reverse()
    assert.equal(await load(), first)
    assert.equal(status, 304); assert.equal(wireBytes, 0); assert.equal(etag, firstTag)
    const expected = () => [...rows].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)).map(row => row.sessionId)
    for (const change of [
      () => { rows = rows.map((row, i) => i === 5 ? { ...row, title: 'Updated', lastActivityAt: '2026-01-02T00:00:00Z' } : row) },
      () => { rows.splice(3, 0, { ...rows[0]!, sessionId: 'new' }) },
      () => { rows.splice(7, 1) },
    ]) {
      change()
      assert.deepEqual((await load()).map(row => row.sessionId), expected())
      assert.deepEqual(Object.keys(wire).sort(), ['base', 'delta', 'removed', 'upsert'])
      assert.equal(wire.delta, 1)
      const withOrderBytes = Buffer.byteLength(JSON.stringify({ ...wire, order: rows.map(row => row.sessionId) }))
      assert.ok(wireBytes < withOrderBytes / 20)
      t.diagnostic(`830-row fixture immutable=${immutable}: full=${fullBytes}, delta=${wireBytes}, hypothetical order-inclusive=${withOrderBytes} bytes`)
    }
    rows.reverse()
    await load(); assert.equal(status, 304)
    loader.clear()
    assert.deepEqual((await load()).map(row => row.sessionId), expected())
  }
})

test('history entry and total-byte budgets evict bases without affecting complete snapshots', async () => {
  for (const [maxBytes, maxEntries] of [[100000, 1], [2500, 8]]) {
    const app = new Hono(), respond = createSummaryResponder(maxBytes, maxEntries)
    let revision = 0
    app.get('/summary', c => respond(c, 'a', { sessions: Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i}`, title: 'x'.repeat(120), revision: i === 0 ? revision : 0 })) }))
    const first = await app.request('/summary')
    const base = first.headers.get('ETag')!
    const firstBytes = Buffer.byteLength(await first.text())
    assert.ok(firstBytes < maxBytes)
    revision++
    await app.request('/summary')
    revision++
    const response = await app.request('/summary', { headers: { Accept: 'application/vnd.shadow.session-summary-delta+json', 'If-None-Match': base } })
    const body = await response.json()
    assert.equal(body.delta, undefined)
    assert.equal(body.sessions.length, 10)
    assert.equal(body.sessions[0].revision, 2)
  }
})
