import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createSummaryResponder } from './summary-delta.ts'
import { createSessionSummaryLoader } from '../../app/src/session-summary-snapshot.ts'

test('summary deltas are reader-owned, project scoped, deletion/order safe and bounded', async () => {
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
  assert.equal(result[0]!.sessionId, 's99')
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
