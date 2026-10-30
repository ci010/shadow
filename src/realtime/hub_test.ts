import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { RealtimeHub, registerRealtimeRoute } from './hub.ts'
import { isRealtimeEnvelope, parseRealtimeTopics, type RealtimeEnvelope, type RealtimeTopic } from './protocol.ts'
import { authorizeMainNodeInventory } from '../runtime/node-inventory.ts'
import { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'

const chat = (projectId = 'one'): RealtimeTopic => ({ kind: 'chat', projectId, sessionId: 'web:chat' })
function read(response: Response) {
  const reader = response.body!.getReader()
  return {
    async next(): Promise<RealtimeEnvelope> {
      const result = await reader.read()
      assert.equal(result.done, false)
      const text = new TextDecoder().decode(result.value)
      const value: unknown = JSON.parse(text.match(/^data: (.+)$/m)![1])
      assert.ok(isRealtimeEnvelope(value), text)
      if (value.type === 'event') assert.ok(text.startsWith(`id: ${value.cursor}\n`))
      else assert.ok(!text.startsWith('id:'))
      return value
    },
    cancel: () => reader.cancel(),
    reader,
  }
}

test('topics and envelopes enforce bounded runtime wire validation', () => {
  assert.deepEqual(parseRealtimeTopics(JSON.stringify([chat(), chat()])), [chat()])
  for (const value of [
    undefined, '{}', 'null', 'bad', JSON.stringify([{ ...chat(), forged: true }]),
    JSON.stringify([{ ...chat(), sessionId: '' }]), JSON.stringify([{ kind: 'nodes', projectId: 'one' }]),
    JSON.stringify(Array.from({ length: 129 }, () => chat())),
    JSON.stringify([{ ...chat(), sessionId: 'a'.repeat(513) }]), ' '.repeat(32769),
    JSON.stringify([{ ...chat(), projectId: 'bad\nid' }]),
  ]) assert.throws(() => parseRealtimeTopics(value))
  assert.equal(isRealtimeEnvelope({ type: 'ready', cursor: 'bad' }), false)
  assert.equal(isRealtimeEnvelope({ type: 'event', cursor: 'epoch:1', topic: chat(), payload: {}, requestId: 5 }), false)
})

test('shared route authorizes before revealing projects and rejects unknown/duplicate queries', async () => {
  const hub = new RealtimeHub()
  hub.registerProject('one')
  const app = new Hono()
  const addresses = new GatewayClientAddressRegistry()
  registerRealtimeRoute(app, hub, request => authorizeMainNodeInventory(request, 'fixture-token', addresses))
  const url = `/api/live?topics=${encodeURIComponent(JSON.stringify([chat()]))}`
  try {
    assert.equal((await app.request(url)).status, 401)
    assert.equal((await app.request(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    const headers = { Authorization: 'Bearer fixture-token' }
    for (const suffix of ['&topics=[]', '&cursor=a&cursor=b']) {
      assert.equal((await app.request(url + suffix, { headers })).status, 400)
    }
    assert.equal((await app.request('/api/live?topics=bad', { headers })).status, 400)
    assert.equal((await app.request(`/api/live?topics=${encodeURIComponent(JSON.stringify([chat('unknown')]))}`, { headers })).status, 404)
    const response = await app.request(url, { headers })
    assert.equal(response.status, 200)
    const stream = read(response)
    assert.equal((await stream.next()).type, 'reset')
    assert.equal((await stream.next()).type, 'ready')
    await stream.cancel()
    assert.equal(hub.stats.clients, 0)
  } finally { hub.close() }
})

test('session invalidations optionally carry a completed turn identity without changing ordinary refresh events', async () => {
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('one')
  const stream = read(hub.connect([{ kind: 'sessions', projectId: 'one' }], new AbortController().signal))
  try {
    await stream.next()
    await stream.next()
    publisher.invalidateSessions('web:chat', 'completed-turn')
    const finished = await stream.next()
    assert.equal(finished.type, 'event')
    if (finished.type !== 'event') throw new Error('Expected session event')
    assert.deepEqual(finished.payload, { event: 'invalidate', sessionId: 'web:chat', completedTurnId: 'completed-turn' })
    publisher.invalidateSessions('web:chat')
    const ordinary = await stream.next()
    if (ordinary.type !== 'event') throw new Error('Expected session event')
    assert.deepEqual(ordinary.payload, { event: 'invalidate', sessionId: 'web:chat' })
    publisher.invalidateActivity('web:chat')
    const activity = await stream.next()
    assert(activity.type === 'event')
    assert.deepEqual(activity.payload, { event: 'activity', sessionId: 'web:chat' })
  } finally { await stream.cancel(); hub.close() }
})

test('integration invalidations reuse the authenticated Project feed and reveal no configuration bodies', async () => {
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('one')
  const topic: RealtimeTopic = { kind: 'integrations', projectId: 'one' }
  const stream = read(hub.connect([topic], new AbortController().signal))
  try {
    await stream.next(); await stream.next()
    publisher.invalidateIntegrations!()
    const event = await stream.next()
    assert(event.type === 'event')
    assert.deepEqual(event.topic, topic)
    assert.deepEqual(event.payload, { event: 'invalidate' })
    assert.deepEqual(parseRealtimeTopics(JSON.stringify([topic])), [topic])
  } finally { await stream.cancel(); hub.close() }
})

test('host catalog topic is available without a project runtime and replays changes', async () => {
  const hub = new RealtimeHub()
  const topic: RealtimeTopic = { kind: 'projects' }
  const stream = read(hub.connect([topic], new AbortController().signal))
  try {
    assert.equal((await stream.next()).type, 'reset')
    assert.equal((await stream.next()).type, 'ready')
    const cursor = hub.cursor
    hub.invalidateProjects()
    const event = await stream.next()
    assert(event.type === 'event')
    assert.deepEqual(event.topic, topic)
    assert.deepEqual(event.payload, { event: 'invalidate' })
    const replay = read(hub.connect([topic], new AbortController().signal, cursor))
    assert.deepEqual(await replay.next(), event)
    assert.equal((await replay.next()).type, 'ready')
    await replay.cancel()
    assert.throws(() => parseRealtimeTopics(JSON.stringify([{ kind: 'projects', projectId: 'one' }])))
  } finally { await stream.cancel(); hub.close() }
})

test('published runtime readiness refreshes snapshots after the HTTP gateway becomes available', async () => {
  const hub = new RealtimeHub()
  hub.registerProject('one')
  const stream = read(hub.connect([{ kind: 'sessions', projectId: 'one' }, { kind: 'projects' }], new AbortController().signal))
  try {
    await stream.next()
    await stream.next()
    hub.projectReady('one')
    assert.deepEqual(await stream.next(), { type: 'reset', reason: 'project-restored', cursor: hub.cursor })
    assert.equal((await stream.next()).type, 'ready')
  } finally { await stream.cancel(); hub.close() }
})

test('ordered replay excludes already consumed cursor and isolates projects', async () => {
  const hub = new RealtimeHub()
  const one = hub.registerProject('one')
  const two = hub.registerProject('two')
  const cursor = hub.cursor
  one.chat('web:chat', { content: 'a' }, 'request-a')
  const first = hub.cursor
  two.chat('web:chat', { content: 'foreign' })
  one.chat('web:chat', { content: 'b' }, 'request-b')
  try {
    const replay = read(hub.connect([chat()], new AbortController().signal, cursor))
    const a = await replay.next()
    const b = await replay.next()
    assert.equal(a.type, 'event')
    assert.equal(b.type, 'event')
    if (a.type !== 'event' || b.type !== 'event') throw new Error('Expected events')
    assert.equal(a.requestId, 'request-a')
    assert.equal(b.requestId, 'request-b')
    assert.deepEqual(b.payload, { content: 'b' })
    assert.equal((await replay.next()).type, 'ready')
    await replay.cancel()
    const duplicate = read(hub.connect([chat()], new AbortController().signal, first))
    assert.deepEqual(await duplicate.next(), b)
    assert.equal((await duplicate.next()).type, 'ready')
    await duplicate.cancel()
  } finally { hub.close() }
})

test('unavailable catalog projects do not break healthy topics and recover on the same feed', async () => {
  const hub = new RealtimeHub({ projectExists: id => ['one', 'two'].includes(id), telemetryMs: 5 })
  const one = hub.registerProject('one')
  const selected: RealtimeTopic[] = [chat('one'), chat('two'), { kind: 'logs', projectId: 'two' }]
  const response = hub.connect(selected, new AbortController().signal)
  assert.equal(response.status, 200)
  const stream = read(response)
  try {
    assert.equal((await stream.next()).type, 'reset')
    assert.deepEqual(await stream.next(), { type: 'unavailable', cursor: hub.cursor, topics: selected.slice(1) })
    assert.equal((await stream.next()).type, 'ready')
    one.chat('web:chat', { content: 'healthy' })
    const healthy = await stream.next()
    assert.equal(healthy.type, 'event')
    assert(healthy.type === 'event' && healthy.topic.projectId === 'one')
    let latest = 0
    const two = hub.registerProject('two', {
      latest: () => latest,
      query: (_kind, after) => latest > after ? [{ id: latest }] : [],
    })
    assert.deepEqual(await stream.next(), { type: 'reset', cursor: hub.cursor, reason: 'project-restored' })
    assert.equal((await stream.next()).type, 'ready')
    two.chat('web:chat', { content: 'recovered' })
    const recovered = await stream.next()
    assert(recovered.type === 'event' && recovered.topic.projectId === 'two')
    latest++
    const log = await Promise.race([stream.next(), delay(1000).then(() => { throw new Error('Restored telemetry did not start') })])
    assert(log.type === 'event' && log.topic.kind === 'logs')
    two.close()
    assert.deepEqual(await stream.next(), { type: 'reset', cursor: hub.cursor, reason: 'project-removed' })
    assert.deepEqual(await stream.next(), { type: 'unavailable', cursor: hub.cursor, topics: selected.slice(1) })
    assert.equal((await stream.next()).type, 'ready')
    one.chat('web:chat', { content: 'still healthy' })
    assert.equal((await stream.next()).type, 'event')
    assert.equal(hub.stats.clients, 1)
    assert.equal(hub.connect([chat('unknown')], new AbortController().signal).status, 404)
  } finally { await stream.cancel(); hub.close() }
})

test('I/O uses a project-scoped invalidation topic without media or chat delivery', async () => {
  const hub = new RealtimeHub()
  const one = hub.registerProject('one')
  const two = hub.registerProject('two')
  const cursor = hub.cursor
  one.invalidateIo?.('run-one')
  two.invalidateIo?.('run-two')
  const stream = read(hub.connect([{ kind: 'io', projectId: 'one' }], new AbortController().signal, cursor))
  try {
    const event = await stream.next()
    assert.equal(event.type, 'event')
    if (event.type !== 'event') throw new Error('Expected I/O event')
    assert.deepEqual(event.topic, { kind: 'io', projectId: 'one' })
    assert.deepEqual(event.payload, { event: 'invalidate', runId: 'run-one' })
    assert.equal((await stream.next()).type, 'ready')
    const chatStream = read(hub.connect([chat('one')], new AbortController().signal, cursor))
    assert.equal((await chatStream.next()).type, 'ready')
    await chatStream.cancel()
  } finally { await stream.cancel(); hub.close() }
})

test('expired, restarted, absent and invalid cursors explicitly reset before ready', async () => {
  const hub = new RealtimeHub({ journalCount: 2 })
  const publisher = hub.registerProject('one')
  const old = hub.cursor
  for (let i = 0; i < 5; i++) publisher.chat('web:chat', { i })
  try {
    assert.equal(hub.stats.journalCount, 2)
    for (const [cursor, reason] of [[old, 'expired'], ['restart:0', 'epoch'], [undefined, 'initial'], ['bad', 'invalid'], [hub.cursor.replace(/:\d+$/, ':999'), 'invalid']] as const) {
      const stream = read(hub.connect([chat()], new AbortController().signal, cursor))
      assert.deepEqual(await stream.next(), { type: 'reset', cursor: hub.cursor, reason })
      assert.deepEqual(await stream.next(), { type: 'ready', cursor: hub.cursor })
      await stream.cancel()
    }
  } finally { hub.close() }
})

test('journal bounds both count and encoded bytes, including oversized individual events', () => {
  const hub = new RealtimeHub({ journalBytes: 450, journalCount: 3 })
  const publisher = hub.registerProject('one')
  for (let i = 0; i < 10; i++) publisher.chat('web:chat', { i, text: '界'.repeat(40) })
  assert.ok(hub.stats.journalBytes <= 450)
  assert.ok(hub.stats.journalCount <= 3)
  publisher.chat('web:chat', { text: 'x'.repeat(1000) })
  assert.equal(hub.stats.journalBytes, 0)
  assert.equal(hub.stats.journalCount, 0)
  hub.close()
})

test('abort, cancellation, shutdown and slow consumers release connections', async () => {
  const diagnostics: string[] = []
  const hub = new RealtimeHub({ clientBytes: 1024, diagnostic: value => diagnostics.push(value) })
  const publisher = hub.registerProject('one')
  const abort = new AbortController()
  const response = hub.connect([chat()], abort.signal)
  assert.equal(hub.stats.clients, 1)
  abort.abort()
  assert.equal(hub.stats.clients, 0)
  await response.body!.cancel()
  const slow = hub.connect([chat()], new AbortController().signal)
  for (let i = 0; i < 20; i++) publisher.chat('web:chat', { text: 'x'.repeat(200) })
  assert.equal(hub.stats.clients, 0)
  assert.deepEqual(diagnostics, ['slow-client-disconnected'])
  await assert.rejects(slow.body!.getReader().read(), /bounded queue/)
  const already = new AbortController()
  already.abort()
  await hub.connect([chat()], already.signal).body!.cancel()
  assert.equal(hub.stats.clients, 0)
  const stream = read(hub.connect([chat()], new AbortController().signal))
  await stream.next()
  await stream.next()
  hub.close()
  assert.equal((await stream.reader.read()).done, true)
  assert.equal(hub.stats.clients, 0)
})

test('removed project leases cannot publish late events or contaminate replacement runtimes', async () => {
  const hub = new RealtimeHub()
  const old = hub.registerProject('one')
  const two = hub.registerProject('two')
  const removed = read(hub.connect([chat()], new AbortController().signal))
  await removed.next()
  await removed.next()
  old.chat('web:chat', { content: 'before' })
  await removed.next()
  old.close()
  assert.deepEqual(await removed.next(), { type: 'reset', cursor: hub.cursor, reason: 'project-removed' })
  assert.equal((await removed.reader.read()).done, true)
  const replacement = hub.registerProject('one')
  const cursor = hub.cursor
  old.chat('web:chat', { content: 'late' })
  old.close()
  assert.equal(hub.cursor, cursor)
  replacement.chat('web:chat', { content: 'new' })
  two.chat('web:chat', { content: 'two' })
  const stream = read(hub.connect([chat()], new AbortController().signal, cursor))
  const event = await stream.next()
  assert.equal(event.type, 'event')
  if (event.type === 'event') assert.deepEqual(event.payload, { content: 'new' })
  assert.equal((await stream.next()).type, 'ready')
  await stream.cancel()
  hub.close()
})

test('telemetry tails only requested kinds, share polling, and stop after final unsubscribe', async () => {
  const hub = new RealtimeHub({ telemetryMs: 5 })
  let queries = 0
  let latest = 1
  hub.registerProject('one', {
    latest: kind => { assert.equal(kind, 'logs'); return latest },
    query: (kind, afterId) => {
      assert.equal(kind, 'logs')
      queries++
      return afterId < latest ? [{ id: latest }] : []
    },
  })
  await delay(20)
  assert.equal(queries, 0)
  const topic: RealtimeTopic = { kind: 'logs', projectId: 'one' }
  const a = read(hub.connect([topic], new AbortController().signal))
  const b = read(hub.connect([topic], new AbortController().signal))
  await a.next(); await a.next(); await b.next(); await b.next()
  latest = 2
  const [eventA, eventB] = await Promise.all([a.next(), b.next(), delay(20)])
  assert.deepEqual(eventA, eventB)
  assert.equal(hub.stats.journalCount, 1)
  await a.cancel()
  await b.cancel()
  const stoppedAt = queries
  await delay(20)
  assert.equal(queries, stoppedAt)
  hub.close()
})

test('telemetry query failures disconnect affected subscribers and recover with an explicit reset', async () => {
  const diagnostics: string[] = []
  const hub = new RealtimeHub({ telemetryMs: 5, diagnostic: reason => diagnostics.push(reason) })
  let fail = false
  let latest = 0
  hub.registerProject('one', {
    latest: () => latest,
    query: (_kind, afterId) => {
      if (fail) throw new Error('Synthetic store failure')
      return latest > afterId ? [{ id: latest }] : []
    },
  })
  const logs: RealtimeTopic = { kind: 'logs', projectId: 'one' }
  const a = read(hub.connect([logs], new AbortController().signal))
  const b = read(hub.connect([logs], new AbortController().signal))
  const unaffected = read(hub.connect([chat()], new AbortController().signal))
  try {
    for (const stream of [a, b, unaffected]) { await stream.next(); await stream.next() }
    const cursor = hub.cursor
    fail = true
    await Promise.all([
      assert.rejects(a.reader.read(), /telemetry query failed/),
      assert.rejects(b.reader.read(), /telemetry query failed/),
      delay(20),
    ])
    assert.equal(hub.stats.clients, 1, 'Unrelated chat-only connection remains open')
    assert.deepEqual(diagnostics, ['telemetry-query-failed'], 'Failed tail stops instead of logging forever')
    fail = false
    latest = 1
    const recovered = read(hub.connect([logs], new AbortController().signal, cursor))
    try {
      assert.deepEqual(await recovered.next(), { type: 'reset', reason: 'expired', cursor })
      assert.equal((await recovered.next()).type, 'ready')
      latest = 2
      const [event] = await Promise.all([recovered.next(), delay(20)])
      assert.equal(event.type, 'event')
      if (event.type === 'event') assert.deepEqual(event.payload, { id: 2 })
    } finally { await recovered.cancel() }
  } finally { await unaffected.cancel(); hub.close() }
})

test('invalid internal publication topics throw rather than silently losing events', () => {
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('one')
  const cursor = hub.cursor
  assert.throws(() => publisher.chat('', { content: 'invalid' }), /Invalid realtime publication topic/)
  assert.throws(() => publisher.chat('x'.repeat(513), {}), /Invalid realtime publication topic/)
  assert.equal(hub.cursor, cursor)
  assert.equal(hub.stats.journalCount, 0)
  hub.close()
})

test('admission-only send delivers chat output once with no legacy connection and preserves request correlation', async () => {
  const bus = new Bus()
  const hub = new RealtimeHub()
  const realtime = hub.registerProject('one')
  const channel = new WebChannel(bus, { workspace: '.', realtime })
  const app = new Hono()
  channel.setReceiver(async message => {
    bus.emit('message.outbound', {
      channel: 'web', chatId: message.chatId, replyTo: message.messageId,
      event: 'response', content: 'accepted output', done: true,
    })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })

  await channel.start(app)
  const stream = read(hub.connect([chat()], new AbortController().signal))
  try {
    await stream.next()
    await stream.next()
    const response = await app.request('/api/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'chat', content: 'fixture', stream: false }),
    })
    assert.equal(response.status, 200)
    const admitted = await response.json() as { requestId: string; chatId: string }
    const event = await stream.next()
    assert.equal(event.type, 'event')
    if (event.type !== 'event') throw new Error('Expected output')
    assert.equal(event.requestId, admitted.requestId)
    assert.deepEqual(event.payload, { event: 'response', content: 'accepted output', done: true })
    assert.equal(hub.stats.journalCount, 1)
    bus.emit('session.message.appended', {
      sessionId: 'web:chat', physicalSessionId: 'physical',
      message: { role: 'user', content: '<event type="background" />' },
    })
    const background = await stream.next()
    assert.equal(background.type, 'event')
    if (background.type === 'event') assert.equal((background.payload as { event: string }).event, 'session_message')
  } finally {
    await stream.cancel()
    await channel.stop()
    hub.close()
    bus.stopAll()
  }
})

test('observable heartbeat follows readiness without advancing replay sequence', async () => {
  const hub = new RealtimeHub({ heartbeatMs: 5 })
  hub.registerProject('one')
  const abort = new AbortController()
  const stream = read(hub.connect([chat()], abort.signal))
  try {
    await stream.next()
    assert.equal((await stream.next()).type, 'ready')
    const cursor = hub.cursor
    const [heartbeat] = await Promise.all([stream.next(), delay(10)])
    assert.deepEqual(heartbeat, { type: 'heartbeat', cursor })
    assert.equal(hub.cursor, cursor)
    assert.equal(hub.stats.journalCount, 0)
    abort.abort()
    assert.equal(hub.stats.clients, 0)
  } finally { await stream.cancel(); hub.close() }
})

test('explicit completed, failed and cancelled terminal facts retain input correlation and stop on channel cleanup', async () => {
  const hub = new RealtimeHub()
  const bus = new Bus()
  const channel = new WebChannel(bus, { realtime: hub.registerProject('one') })
  const stream = read(hub.connect([chat()], new AbortController().signal))
  try {
    await stream.next(); await stream.next()
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const fact = {
        sessionId: 'web:chat', turnId: `turn-${status}`, inputId: `request-${status}`,
        source: { kind: 'user' as const, sender: { channel: 'web', senderId: 'fixture', chatId: 'chat', messageId: `request-${status}` } },
        status, content: 'Persisted content is intentionally not streamed again',
      }
      bus.emit('session.turn.finished', { ...fact, sessionId: 'other:chat' })
      bus.emit('session.turn.finished', fact)
      const event = await stream.next()
      assert.equal(event.type, 'event')
      if (event.type !== 'event') throw new Error('Expected terminal event')
      assert.equal(event.requestId, fact.inputId)
      assert.deepEqual(event.payload, { event: 'turn_finished', done: true, status, turnId: fact.turnId })
    }
    await channel.stop()
    const cursor = hub.cursor
    bus.emit('session.turn.finished', {
      sessionId: 'web:chat', turnId: 'late', inputId: 'late',
      source: { kind: 'user', sender: { channel: 'web', senderId: 'fixture', chatId: 'chat', messageId: 'late' } },
      status: 'completed', content: '',
    })
    assert.equal(hub.cursor, cursor)
  } finally { await channel.stop(); await stream.cancel(); hub.close(); bus.stopAll() }
})

test('HTTP cursor overrides Last-Event-ID and valid header reconnect starts after consumed events', async () => {
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('one')
  const app = new Hono()
  registerRealtimeRoute(app, hub, () => true)
  const before = hub.cursor
  publisher.chat('web:chat', { content: 'once' })
  const url = `/api/live?topics=${encodeURIComponent(JSON.stringify([chat()]))}`
  try {
    const header = read(await app.request(url, { headers: { 'Last-Event-ID': hub.cursor } }))
    assert.equal((await header.next()).type, 'ready')
    await header.cancel()
    const query = read(await app.request(`${url}&cursor=${encodeURIComponent(before)}`, { headers: { 'Last-Event-ID': hub.cursor } }))
    assert.equal((await query.next()).type, 'event')
    assert.equal((await query.next()).type, 'ready')
    await query.cancel()
  } finally { hub.close() }
})

test('retired chat streams return an explicit error and background output only uses the hub', async () => {
  const hub = new RealtimeHub()
  const bus = new Bus()
  const channel = new WebChannel(bus, { realtime: hub.registerProject('one') })
  const app = new Hono()
  await channel.start(app)
  const legacy = await app.request('/api/chat/events?chatId=chat')
  assert.equal(legacy.status, 410)
  assert.equal((await legacy.json()).error, 'stream_retired')
  assert.equal(hub.stats.clients, 0)
  const stream = read(hub.connect([chat()], new AbortController().signal))
  try {
    await stream.next(); await stream.next()
    bus.emit('message.outbound', { channel: 'web', chatId: 'other', event: 'response', content: 'not subscribed', done: true })
    bus.emit('message.outbound', { channel: 'web', chatId: 'chat', event: 'response', content: 'shared', done: true })
    const event = await stream.next()
    assert.equal(event.type, 'event')
    if (event.type === 'event') assert.equal((event.payload as { content: string }).content, 'shared')
    assert.equal(hub.stats.journalCount, 2)
  } finally {
    await stream.cancel()
    await channel.stop()
    hub.close()
  }
})

test('resource invalidations are minimal, project isolated, replayable and lease scoped', async () => {
  const hub = new RealtimeHub()
  const one = hub.registerProject('one'), two = hub.registerProject('two')
  const topic: RealtimeTopic = { kind: 'resources', projectId: 'one' }
  assert.deepEqual(parseRealtimeTopics(JSON.stringify([topic, topic])), [topic])
  const cursor = hub.cursor
  two.invalidateResource!('interactions')
  one.invalidateResource!('interactions')
  one.invalidateResource!('service-groups')
  const stream = read(hub.connect([topic], new AbortController().signal, cursor))
  try {
    for (const resource of ['interactions', 'service-groups']) {
      const event = await stream.next()
      assert.equal(event.type, 'event')
      if (event.type !== 'event') throw new Error('Expected event')
      assert.deepEqual(event.topic, topic)
      assert.deepEqual(event.payload, { event: 'invalidate', resource })
    }
    assert.equal((await stream.next()).type, 'ready')
    one.close()
    const closedCursor = hub.cursor
    one.invalidateResource!('interactions')
    assert.equal(hub.cursor, closedCursor)
  } finally { await stream.cancel(); hub.close() }
})
