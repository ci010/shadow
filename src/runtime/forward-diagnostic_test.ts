import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import { createForwardDiagnostics } from './forward-diagnostic.ts'

const id = '12345678-1234-4123-8123-123456789abc'
function fixture(side: 'main' | 'child' = 'main') {
  const logs: string[] = []
  let time = 0
  const create = createForwardDiagnostics(side, text => logs.push(text), () => time)
  return { logs, create, advance(ms: number) { time += ms }, rows: () => logs.map(text => JSON.parse(text.slice('API forward '.length))) }
}

test('forward diagnostics separate headers and delayed EOF without eagerly reading; fixed correlation and bytes', async () => {
  const f = fixture('child')
  const d = f.create('/projects/secret/api/sessions/summary?proof=secret')!
  f.advance(10); d.proofReady(); f.advance(20)
  let pulls = 0
  let source!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { source = c }, pull() { pulls++ } }, { highWaterMark: 0 })
  const signal = new AbortController().signal
  const response = d.response(new Response(body, { headers: { 'X-Shadow-Request-Id': id, ETag: 'fixture' } }), signal)
  assert.equal(pulls, 0)
  assert.equal(f.rows().length, 1)
  assert.equal(response.headers.get('ETag'), 'fixture')
  const result = response.text()
  source.enqueue(new TextEncoder().encode('abc'))
  f.advance(100)
  assert.equal(f.rows().length, 1)
  source.close()
  assert.equal(await result, 'abc')
  const rows = f.rows()
  assert.equal(rows[0].stage, 'headers'); assert.equal(rows[0].headersMs, 30); assert.equal(rows[0].proofMs, 10)
  assert.equal(rows[1].completion, 'eof'); assert.equal(rows[1].bytes, 3); assert.equal(rows[1].id, id)
  assert.equal(rows[1].elapsedMs, 130); assert.equal(rows[1].side, 'child')
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  assert.ok(!f.logs.join('').includes('secret'))
})

test('cancel propagates reason; abort and later read failure log only one terminal and remove listeners', async () => {
  const f = fixture()
  const controller = new AbortController()
  let reason: unknown
  const response = f.create('/api/sessions/summary')!.response(new Response(new ReadableStream({ cancel(value) { reason = value } })), controller.signal)
  const cancellation = { private: 'do-not-log' }
  await response.body!.cancel(cancellation)
  assert.equal(reason, cancellation)
  controller.abort()
  assert.equal(f.rows().filter(row => row.stage === 'terminal').length, 1)
  assert.equal(f.rows()[1].completion, 'cancel')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

  const g = fixture()
  const aborter = new AbortController()
  let source!: ReadableStreamDefaultController<Uint8Array>
  const error = new Error('private upstream error')
  const stream = g.create('/api/sessions/summary')!.response(new Response(new ReadableStream({ start(c) { source = c } })), aborter.signal)
  const reading = stream.text()
  aborter.abort(); source.error(error)
  await assert.rejects(reading, value => value === error)
  assert.equal(g.rows().filter(row => row.stage === 'terminal').length, 1)
  assert.equal(g.rows()[1].completion, 'abort')
  assert.equal(getEventListeners(aborter.signal, 'abort').length, 0)
  assert.ok(!g.logs.join('').includes('private'))
})

test('stream rejection identity, invalid ID, bodyless, failure and instance rate bounds', async () => {
  const f = fixture()
  const error = new Error('credential-secret')
  const signal = new AbortController().signal
  const response = f.create('/api/sessions/summary')!.response(new Response(new ReadableStream({ start(c) { c.error(error) } }), { headers: { 'X-Shadow-Request-Id': 'secret' } }), signal)
  await assert.rejects(response.text(), value => value === error)
  assert.equal(f.rows()[1].completion, 'error'); assert.equal(f.rows()[1].id, undefined)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  f.create('/api/sessions/summary')!.response(new Response(null, { status: 304 }), signal)
  assert.equal(f.rows().at(-1).completion, 'bodyless')
  const failed = f.create('/api/sessions/summary')!
  failed.fail(signal); failed.fail(signal)
  assert.equal(f.rows().at(-1).completion, 'error')
  assert.equal(f.create('/api/live'), undefined)
  for (let i = 3; i < 60; i++) assert.ok(f.create('/api/sessions/summary'))
  assert.equal(f.create('/api/sessions/summary'), undefined)
  f.advance(60_000); assert.ok(f.create('/api/sessions/summary'))
  assert.ok(!f.logs.join('').includes('secret'))
})
