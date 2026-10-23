import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { LiveFixture } from './fixtures/live-fixture.ts'

test('fixture output persists paired tools and correlates terminal events with admission', async () => {
  const live = new LiveFixture()
  const sessionId = 'web:fixture-chat'
  const response = live.hub.connect([
    { kind: 'chat', projectId: 'default', sessionId },
    { kind: 'sessions', projectId: 'default' },
  ], new AbortController().signal, live.hub.cursor)
  const reader = response.body!.getReader()
  const next = async () => {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    return JSON.parse(new TextDecoder().decode(chunk.value).match(/^data: (.+)$/m)![1])
  }
  try {
    assert.equal((await next()).type, 'ready')
    const admission = live.admit('fixture-chat')
    assert.deepEqual(Object.keys(admission), ['requestId', 'chatId'])
    assert.equal((await next()).topic.kind, 'sessions')
    live.chat(sessionId, { event: 'response', content: 'Before tool.' })
    live.chat(sessionId, { event: 'tool_call', toolCall: { name: 'read', arguments: { path: 'fixture.txt' } } })
    live.chat(sessionId, { event: 'tool_result', content: 'Synthetic contents' })
    live.chat(sessionId, { event: 'response', content: 'Partial answer.' })
    live.finish(sessionId, 'failed')
    const events = []
    for (let index = 0; index < 7; index++) events.push(await next())
    const terminal = events.find(event => event.payload.event === 'turn_finished')
    assert.equal(terminal.payload.status, 'failed')
    assert.equal(terminal.requestId, admission.requestId)
    assert.ok(events.filter(event => event.topic.kind === 'chat').every(event => event.requestId === admission.requestId))
    assert.equal(events.at(-1).topic.kind, 'sessions')
    assert.equal(live.activeRequests.size, 0)
    const history = live.history(sessionId)
    assert.equal(history[0].content, 'Before tool.')
    const calls = history[1].tool_calls as Array<{ id: string; function: { name: string } }>
    assert.equal(calls[0].id, history[2].tool_call_id)
    assert.equal(calls[0].function.name, 'read')
    assert.equal(history[3].content, 'Partial answer.')
    assert.ok(history.every(message => Number.isFinite(Date.parse(String(message.timestamp)))))
  } finally {
    await reader.cancel()
    live.close()
  }
  assert.equal(live.hub.stats.clients, 0)
})

test('fixture serves only shared realtime and releases HTTP subscribers on abort and shutdown', async () => {
  const live = new LiveFixture()
  const server = createServer((request, response) => {
    if (!live.handle(request, response)) response.writeHead(404).end()
  })
  const controller = new AbortController()
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    for (const route of ['/api/chat/events', '/v1/stream/spans', '/v1/stream/logs']) {
      assert.equal((await fetch(base + route)).status, 404)
    }
    const topics = encodeURIComponent(JSON.stringify([{ kind: 'sessions', projectId: 'default' }]))
    const response = await fetch(`${base}/api/live?topics=${topics}`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/event-stream/)
    assert.equal(live.hub.stats.clients, 1)
    controller.abort()
    for (let attempt = 0; attempt < 100 && live.hub.stats.clients; attempt++) await delay(10)
    assert.equal(live.hub.stats.clients, 0)
    assert.equal(live.responses.size, 0)
    assert.ok(live.connections.every(connection => connection.closed))
  } finally {
    controller.abort()
    live.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
