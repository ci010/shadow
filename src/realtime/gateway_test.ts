import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { GATEWAY_MAX_HEADER_BYTES, serveGateway } from '../gateway/server.ts'
import { RealtimeHub, registerRealtimeRoute } from './hub.ts'
import { REALTIME_MAX_TOPICS, REALTIME_MAX_TOPICS_BYTES, parseRealtimeTopics } from './protocol.ts'

test('real Node gateway accepts 128 topics at the 32 KiB JSON boundary with worst-case percent encoding', async () => {
  const topics = Array.from({ length: REALTIME_MAX_TOPICS }, (_, index) => ({
    kind: 'chat' as const, projectId: 'fixture', sessionId: `web:${index}`,
  }))
  let padding = REALTIME_MAX_TOPICS_BYTES - Buffer.byteLength(JSON.stringify(topics))
  for (const topic of topics) {
    const count = Math.min(padding, 512 - topic.sessionId.length)
    topic.sessionId += '!'.repeat(count)
    padding -= count
  }
  assert.equal(padding, 0)
  const json = JSON.stringify(topics)
  assert.equal(Buffer.byteLength(json), REALTIME_MAX_TOPICS_BYTES)
  assert.equal(parseRealtimeTopics(json).length, REALTIME_MAX_TOPICS)
  const encodeEveryByte = (value: string) => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')
  const encoded = encodeEveryByte(json)
  assert.equal(encoded.length, 3 * REALTIME_MAX_TOPICS_BYTES)
  assert.ok(encoded.length > 16 * 1024, 'This fixture must exceed the default Node parser limit')
  assert.ok(encoded.length + 4096 < GATEWAY_MAX_HEADER_BYTES)

  const hub = new RealtimeHub()
  hub.registerProject('fixture')
  const app = new Hono()
  registerRealtimeRoute(app, hub, request => request.headers.get('authorization') === 'Bearer synthetic-fixture')
  const gateway = serveGateway(app, { host: '127.0.0.1', port: 0 })
  try {
    await gateway.ready
    const base = `http://127.0.0.1:${gateway.addr.port}`
    const headers = { authorization: 'Bearer synthetic-fixture', 'x-fixture': 'x'.repeat(1024) }
    const abort = new AbortController()
    const response = await fetch(`${base}/api/live?topics=${encoded}&cursor=${encodeURIComponent(hub.cursor)}`, {
      headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    try {
      const frame = new TextDecoder().decode((await reader.read()).value)
      assert.match(frame, /event: realtime/)
      assert.match(frame, /"type":"ready"/)
    } finally {
      await reader.cancel()
      abort.abort()
    }
    for (const invalid of [json + ' ', JSON.stringify([...topics, { kind: 'sessions', projectId: 'fixture' }])]) {
      const rejected = await fetch(`${base}/api/live?topics=${encodeEveryByte(invalid)}`, {
        headers, signal: AbortSignal.timeout(5000),
      })
      assert.equal(rejected.status, 400)
      assert.deepEqual(await rejected.json(), { error: 'Invalid realtime topics' })
    }
    const tooLarge = await fetch(`${base}/api/live?topics=${'x'.repeat(GATEWAY_MAX_HEADER_BYTES)}`, {
      headers, signal: AbortSignal.timeout(5000),
    })
    assert.equal(tooLarge.status, 431)
    await tooLarge.body?.cancel()
  } finally {
    hub.close()
    await gateway.shutdown()
    await gateway.finished
  }
})
