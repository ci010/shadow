import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createLiveClient, type LiveEvent, type LiveStatus, type LiveResetReason } from './live-client.ts'
import type { RealtimeEnvelope, RealtimeTopic } from '../../src/realtime/protocol.ts'

const epoch = '00000000-0000-4000-8000-000000000000'
const cursor = (sequence: number) => `${epoch}:${sequence}`
const topic = (sessionId: string, projectId = 'default'): RealtimeTopic => ({ kind: 'chat', projectId, sessionId })
class FakeSource extends EventTarget {
  closed = false
  constructor(readonly url: string) { super() }
  close() { this.closed = true }
  send(value: RealtimeEnvelope) { this.dispatchEvent(new MessageEvent('realtime', { data: JSON.stringify(value) })) }
}
function harness(t: TestContext, heartbeatTimeoutMs = 1000) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sources: FakeSource[] = []
  const statuses: LiveStatus[] = []
  const client = createLiveClient('http://fixture.invalid/projects/default/', {
    source: url => { const source = new FakeSource(url); sources.push(source); return source },
    status: status => statuses.push(status), heartbeatTimeoutMs,
  })
  t.after(() => client.dispose())
  const events: LiveEvent[] = []
  const resets: LiveResetReason[] = []
  const subscribe = (value = topic('web:chat-one')) => client.subscribe(value, { event: event => events.push(event), reset: reason => resets.push(reason) })
  const open = (sequence = 0) => {
    t.mock.timers.tick(0)
    const source = sources.at(-1)!
    source.send({ type: 'ready', cursor: cursor(sequence) })
    return source
  }
  return { client, sources, statuses, events, resets, subscribe, open }
}

test('many topics share one physical connection and identical topics share its subscription', async t => {
  const h = harness(t)
  const subscriptions = Array.from({ length: 12 }, (_, index) => h.subscribe(topic(`web:chat-${index}`)))
  assert.equal(h.sources.length, 0, 'synchronous subscription changes are batched')
  const source = h.open()
  await Promise.all(subscriptions.map(subscription => subscription.ready()))
  assert.equal(h.sources.length, 1)
  const url = new URL(source.url)
  assert.equal(url.pathname, '/api/live')
  assert.equal(JSON.parse(url.searchParams.get('topics')!).length, 12)
  const duplicate = h.subscribe(topic('web:chat-0'))
  await duplicate.ready()
  assert.equal(h.sources.length, 1, 'another observer does not open another connection')
  duplicate.close()
  for (const subscription of subscriptions) subscription.close()
  assert.equal(source.closed, true)
  assert.equal(h.statuses.at(-1)?.phase, 'idle')
})

test('failed project topics reject readiness without disconnecting healthy projects and can recover', async t => {
  const h = harness(t)
  const healthy = h.subscribe(topic('web:chat', 'one'))
  const failedTopic = topic('web:chat', 'two')
  const failed = h.subscribe(failedTopic)
  const pending = assert.rejects(failed.ready(), /project is unavailable/)
  t.mock.timers.tick(0)
  const source = h.sources.at(-1)!
  source.send({ type: 'reset', reason: 'initial', cursor: cursor(0) })
  source.send({ type: 'unavailable', cursor: cursor(0), topics: [failedTopic] })
  source.send({ type: 'ready', cursor: cursor(0) })
  await pending
  await healthy.ready()
  await assert.rejects(failed.ready(), /project is unavailable/)
  assert.equal(source.closed, false)
  assert.equal(h.statuses.at(-1)?.phase, 'live')
  source.send({ type: 'event', cursor: cursor(1), topic: topic('web:chat', 'one'), payload: { content: 'healthy' } })
  assert.equal(h.events.length, 1)
  source.send({ type: 'reset', reason: 'project-restored', cursor: cursor(1) })
  source.send({ type: 'ready', cursor: cursor(1) })
  await failed.ready()
  assert.equal(h.sources.length, 1)
  source.send({ type: 'event', cursor: cursor(2), topic: failedTopic, payload: { content: 'recovered' } })
  assert.equal(h.events.length, 2)
  source.send({ type: 'reset', reason: 'project-removed', cursor: cursor(2) })
  source.send({ type: 'unavailable', cursor: cursor(2), topics: [failedTopic] })
  const betweenFrames = assert.rejects(failed.ready(), /project is unavailable/)
  source.send({ type: 'ready', cursor: cursor(2) })
  await betweenFrames
  await healthy.ready()
  assert.equal(source.closed, false)
})

test('reconnect replays in order, deduplicates cursors and never crosses projects', async t => {
  const h = harness(t)
  const subscription = h.subscribe(topic('web:chat-one', 'one'))
  assert.equal(h.client.isLive(), false)
  const source = h.open()
  await subscription.ready()
  assert.equal(h.client.isLive(), true)
  const event: LiveEvent = { type: 'event', cursor: cursor(1), topic: topic('web:chat-one', 'one'), payload: { content: 'a' } }
  source.send(event)
  source.dispatchEvent(new Event('error'))
  assert.equal(h.client.isLive(), false)
  assert.equal(source.closed, true)
  t.mock.timers.tick(500)
  const next = h.sources.at(-1)!
  assert.equal(new URL(next.url).searchParams.get('cursor'), cursor(1))
  next.send(event)
  next.send({ ...event, cursor: cursor(2), topic: topic('web:chat-one', 'two') })
  next.send({ ...event, cursor: cursor(3), payload: { content: 'b' } })
  assert.equal(h.client.isLive(), false, 'Replayed events are distinguishable from fresh notifications')
  next.send({ type: 'ready', cursor: cursor(3) })
  assert.equal(h.client.isLive(), true)
  assert.deepEqual(h.events.map(event => event.payload), [{ content: 'a' }, { content: 'b' }])
  source.send({ ...event, cursor: cursor(4) })
  assert.equal(h.events.length, 2, 'late callbacks from replaced connections are ignored')
})

test('topic changes close before reopening and snapshot only new topics on valid replay', async t => {
  const h = harness(t)
  h.subscribe()
  const old = h.open()
  assert.deepEqual(h.resets, ['subscription'])
  h.subscribe(topic('web:chat-two'))
  assert.equal(old.closed, false, 'keep the stream until the batched topic update')
  assert.equal(h.sources.filter(source => !source.closed).length, 1)
  h.open()
  assert.equal(old.closed, true, 'close the old stream before opening its replacement')
  assert.equal(h.sources.filter(source => !source.closed).length, 1)
  assert.deepEqual(h.resets, ['subscription', 'subscription'])
})

test('snapshot observers recover after a replayable disconnect but not ordinary topic changes', t => {
  const h = harness(t)
  let reconnects = 0
  h.client.subscribe({ kind: 'projects' }, { event() {}, reset() {}, reconnected() { reconnects++ } })
  const source = h.open()
  assert.equal(reconnects, 0)
  source.dispatchEvent(new Event('error'))
  t.mock.timers.tick(500)
  h.open()
  assert.equal(reconnects, 1)
  h.subscribe()
  const next = h.open()
  assert.equal(reconnects, 1)
  next.dispatchEvent(new Event('error'))
  t.mock.timers.tick(500)
  const resetSource = h.sources.at(-1)!
  resetSource.send({ type: 'reset', reason: 'expired', cursor: cursor(10) })
  resetSource.send({ type: 'ready', cursor: cursor(10) })
  assert.equal(reconnects, 1, 'an explicit reset already resynchronizes snapshots')
})

test('expired or restarted journals explicitly resynchronize every active observer', async t => {
  const h = harness(t)
  h.subscribe()
  const source = h.open(5)
  source.send({ type: 'reset', reason: 'expired', cursor: cursor(20) })
  source.send({ type: 'ready', cursor: cursor(20) })
  assert.deepEqual(h.resets, ['subscription', 'expired'])
  const restarted = '11111111-1111-4111-8111-111111111111:0'
  source.send({ type: 'reset', reason: 'epoch', cursor: restarted })
  source.send({ type: 'ready', cursor: restarted })
  assert.deepEqual(h.resets, ['subscription', 'expired', 'epoch'])
})

test('a newly subscribed topic snapshots rather than applying historical replay before readiness', async t => {
  const h = harness(t)
  h.subscribe()
  h.open(3)
  const newTopic = topic('web:chat-two')
  h.subscribe(newTopic)
  t.mock.timers.tick(0)
  const source = h.sources.at(-1)!
  source.send({ type: 'event', cursor: cursor(4), topic: newTopic, payload: { content: 'already saved' } })
  assert.equal(h.events.length, 0)
  source.send({ type: 'ready', cursor: cursor(4) })
  assert.equal(h.resets.at(-1), 'subscription')
  source.send({ type: 'event', cursor: cursor(5), topic: newTopic, payload: { content: 'new output' } })
  assert.deepEqual(h.events.map(event => event.payload), [{ content: 'new output' }])
})

test('observable heartbeat prevents false reconnects and silent connections trigger the watchdog', async t => {
  const h = harness(t)
  h.subscribe()
  const source = h.open()
  t.mock.timers.tick(900)
  source.send({ type: 'heartbeat', cursor: cursor(0) })
  t.mock.timers.tick(900)
  assert.equal(source.closed, false)
  t.mock.timers.tick(100)
  assert.equal(source.closed, true)
  assert.equal(h.statuses.at(-1)?.phase, 'reconnecting')
})

test('cancelled readiness and disposal do not submit work or leave reconnect timers', async t => {
  const h = harness(t)
  const subscription = h.subscribe()
  const controller = new AbortController()
  const pending = subscription.ready(controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  h.open()
  h.client.dispose()
  t.mock.timers.tick(100_000)
  assert.equal(h.sources.length, 1)
  assert.equal(h.sources[0].closed, true)
})

test('invalid envelopes terminate visibly and manual retry starts from a fresh snapshot', async t => {
  const h = harness(t)
  const subscription = h.subscribe()
  const source = h.open()
  source.dispatchEvent(new MessageEvent('realtime', { data: '{"type":"event","cursor":"invalid"}' }))
  assert.equal(source.closed, true)
  assert.equal(h.statuses.at(-1)?.phase, 'error')
  await assert.rejects(subscription.ready(), /Could not validate/)
  h.client.retry()
  const next = h.open()
  assert.equal(new URL(next.url).searchParams.has('cursor'), false)
  assert.equal(h.statuses.at(-1)?.phase, 'live')
})


test('transient topic changes keep the live stream when the final topic set is unchanged', async t => {
  const h = harness(t)
  const anchor = h.subscribe(topic('web:anchor'))
  const pane = h.subscribe(topic('web:pane'))
  const source = h.open()
  await Promise.all([anchor.ready(), pane.ready()])
  pane.close()
  assert.equal(source.closed, false, 'topic changes wait for the batched update')
  const replacement = h.subscribe(topic('web:pane'))
  await replacement.ready()
  t.mock.timers.tick(0)
  assert.equal(source.closed, false)
  assert.equal(h.sources.length, 1, 'same final topic set does not reconnect')
  replacement.close()
  t.mock.timers.tick(0)
  assert.equal(source.closed, false, 'a recently closed chat stays warm')
  assert.equal(h.sources.length, 1)
})


test('returning to a warm chat keeps the stream but snapshots and isolates observers', async t => {
  const h = harness(t, 100_000)
  h.client.subscribe({ kind: 'sessions', projectId: 'default' }, { event() {}, reset() {} })
  const first = h.subscribe(topic('web:first'))
  h.open()
  first.close()
  const second = h.subscribe(topic('web:second'))
  const source = h.open()
  assert.equal(h.sources.length, 2, 'a never requested topic still needs a new authorized URL')
  source.send({ type: 'event', cursor: cursor(1), topic: topic('web:first'), payload: 'closed' })
  assert.equal(h.events.length, 0)
  second.close()
  const returned = h.subscribe(topic('web:first'))
  await returned.ready()
  await Promise.resolve()
  t.mock.timers.tick(0)
  assert.equal(h.sources.length, 2)
  assert.deepEqual(h.resets, ['subscription', 'subscription', 'subscription'])
  source.send({ type: 'event', cursor: cursor(2), topic: topic('web:first'), payload: 'visible' })
  assert.deepEqual(h.events.map(event => event.payload), ['visible'])
  t.mock.timers.tick(30_000)
  assert.equal(source.closed, true, 'the other retained chat expires even while this chat stays active')
  const selected = JSON.parse(new URL(h.sources.at(-1)!.url).searchParams.get('topics')!)
  assert.deepEqual(selected.filter((value: RealtimeTopic) => value.kind === 'chat'), [topic('web:first')])
})

test('warm chats are bounded, cleared on project exit, and disposed without delayed reconnects', t => {
  const h = harness(t, 100_000)
  const anchor = h.client.subscribe({ kind: 'sessions', projectId: 'default' }, { event() {}, reset() {} })
  for (let index = 0; index < 8; index++) {
    const pane = h.subscribe(topic(`web:${index}`))
    const source = h.open(index)
    pane.close()
    t.mock.timers.tick(0)
    const selected = JSON.parse(new URL(h.sources.at(-1)!.url).searchParams.get('topics')!)
    assert.ok(selected.filter((value: RealtimeTopic) => value.kind === 'chat').length <= 4)
    assert.ok(source)
  }
  anchor.close()
  assert.equal(h.sources.at(-1)!.closed, true)
  const other = h.subscribe(topic('web:other', 'other'))
  const source = h.open(8)
  assert.deepEqual(JSON.parse(new URL(source.url).searchParams.get('topics')!), [topic('web:other', 'other')])
  other.close()
  const count = h.sources.length
  t.mock.timers.tick(200_000)
  assert.equal(h.sources.length, count)
})

test('warm topics yield the protocol topic-count budget to active subscriptions', t => {
  const h = harness(t)
  const warm = h.subscribe(topic('web:warm'))
  h.open()
  warm.close()
  // Closing the final observer drops all warm topics immediately. Keep an
  // anchor for the actual capacity test.
  const anchor = h.subscribe(topic('web:anchor'))
  const retained = h.subscribe(topic('web:retained'))
  h.open()
  retained.close()
  for (let index = 0; index < 127; index++) h.subscribe(topic(`web:active-${index}`))
  const source = h.open()
  const selected: RealtimeTopic[] = JSON.parse(new URL(source.url).searchParams.get('topics')!)
  assert.equal(selected.length, 128)
  assert.equal(selected.some(value => value.kind === 'chat' && value.sessionId === 'web:retained'), false)
  assert.ok(anchor)
})


test('staggered warm chats expire in one non-sliding cleanup batch', async t => {
  const h = harness(t, 100_000)
  const anchor = h.subscribe(topic('web:anchor'))
  const panes = Array.from({ length: 4 }, (_, index) => h.subscribe(topic(`web:pane-${index}`)))
  const source = h.open()
  await anchor.ready()
  panes[0].close()
  for (let index = 1; index < panes.length; index++) {
    t.mock.timers.tick(5_000)
    panes[index].close()
  }
  source.send({ type: 'event', cursor: cursor(1), topic: topic('web:pane-3'), payload: 'not observed' })
  assert.equal(h.events.length, 0)
  t.mock.timers.tick(14_999)
  assert.equal(h.sources.length, 1)
  t.mock.timers.tick(1)
  assert.equal(source.closed, true)
  assert.equal(h.sources.length, 2, 'one cleanup reconnect, not four staggered reconnects')
  const next = h.sources.at(-1)!
  assert.deepEqual(JSON.parse(new URL(next.url).searchParams.get('topics')!), [topic('web:anchor')])
  assert.equal(new URL(next.url).searchParams.get('cursor'), cursor(1))
  next.send({ type: 'event', cursor: cursor(2), topic: topic('web:anchor'), payload: 'replay' })
  next.send({ type: 'ready', cursor: cursor(2) })
  await anchor.ready()
  assert.deepEqual(h.events.map(event => event.payload), ['replay'])
  assert.equal(h.resets.length, 5, 'existing observers do not snapshot again on cleanup')
  t.mock.timers.tick(20_000)
  assert.equal(h.sources.length, 2, 'no remaining per-topic expiry timers')
})

for (const mode of ['disconnect', 'retry'] as const) {
  test(`necessary ${mode} consumes warm cleanup without a later expiry reconnect`, async t => {
    const h = harness(t, 100_000)
    const anchor = h.subscribe(topic('web:anchor'))
    const pane = h.subscribe(topic('web:pane'))
    const source = h.open(7)
    pane.close()
    t.mock.timers.tick(10_000)
    if (mode === 'disconnect') source.dispatchEvent(new Event('error'))
    else h.client.retry()
    t.mock.timers.tick(mode === 'disconnect' ? 500 : 0)
    assert.equal(h.sources.length, 2)
    const next = h.sources.at(-1)!
    assert.deepEqual(JSON.parse(new URL(next.url).searchParams.get('topics')!), [topic('web:anchor')])
    assert.equal(new URL(next.url).searchParams.get('cursor'), mode === 'disconnect' ? cursor(7) : null)
    next.send({ type: 'ready', cursor: cursor(7) })
    await anchor.ready()
    t.mock.timers.tick(30_000)
    assert.equal(h.sources.length, 2)
    assert.equal(next.closed, false)
  })
}

test('WS reconnect resends the current topic set once and records bounded failure metadata', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class FakeSocket extends EventTarget {
    sent: Array<{ id: number; subscriptions: Array<{ topic: RealtimeTopic }> }> = []
    send(text: string) { this.sent.push(JSON.parse(text)) }
    close() {}
    ack(index: number) {
      const command = this.sent[index]
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'subscribed', id: command.id,
        cursor: cursor(1), added: command.subscriptions.map(({ topic }) => ({ topic, reason: 'initial' })), removed: [], rejected: [] }) }))
    }
  }
  const sockets: FakeSocket[] = [], diagnostics: unknown[] = []
  const client = createLiveClient('https://private.test/projects/secret', {
    socket() { const socket = new FakeSocket(); sockets.push(socket); return socket },
    ticket: async () => ['fixture-private-proof'], diagnostic: value => diagnostics.push(value),
  })
  t.after(() => client.dispose())
  const observer = { event() {}, reset() {} }
  const first = client.subscribe(topic('one'), observer)
  const open = async (after: number) => {
    t.mock.timers.tick(after); await Promise.resolve(); await Promise.resolve()
    const socket = sockets.at(-1)!
    socket.dispatchEvent(new Event('open'))
    return socket
  }
  const failed = await open(0)
  assert.deepEqual(failed.sent[0].subscriptions.map(s => s.topic), [topic('one')])
  const second = client.subscribe(topic('two'), observer)
  t.mock.timers.tick(0); assert.equal(failed.sent.length, 1, 'never overlaps subscription commands')
  failed.dispatchEvent(new Event('error'))
  failed.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: 'private-frame-data' }))
  const recovered = await open(500)
  assert.notEqual(failed, recovered)
  assert.deepEqual(recovered.sent[0].subscriptions.map(s => s.topic), [topic('one'), topic('two')])
  recovered.ack(0); await Promise.all([first.ready(), second.ready()])
  t.mock.timers.tick(100)
  assert.equal(recovered.sent.length, 1)
  assert.deepEqual(diagnostics, [{ transport: 'ws', stage: 'subscribe', code: 'closed', closeCode: 1006, retryAttempt: 1, retryDelayMs: 500 }])
})

test('legacy SSE removal followed by EOF without scope fails closed until availability is known', async t => {
  const h = harness(t)
  const one = h.subscribe(topic('one', 'a')), two = h.subscribe(topic('two', 'b'))
  const source = h.open(); await Promise.all([one.ready(), two.ready()])
  source.send({ type: 'reset', reason: 'project-removed', cursor: cursor(1) })
  source.dispatchEvent(new Event('error'))
  assert.deepEqual(h.resets.filter(reason => reason === 'project-removed'), ['project-removed', 'project-removed'])
  t.mock.timers.tick(500)
  h.sources.at(-1)!.send({ type: 'ready', cursor: cursor(1) })
  await Promise.all([one.ready(), two.ready()])
  assert.deepEqual(h.resets.filter(reason => reason === 'project-restored'), ['project-restored', 'project-restored'])
})

test('changing an SSE topic set before old-peer EOF still revokes unresolved data', async t => {
  const h = harness(t)
  const a = h.subscribe(topic('one', 'a'))
  const old = h.open(); await a.ready()
  old.send({ type: 'reset', reason: 'project-removed', cursor: cursor(1) })
  assert.equal(h.resets.filter(reason => reason === 'project-removed').length, 0)
  h.subscribe(topic('two', 'b'))
  t.mock.timers.tick(0)
  assert.equal(old.closed, true)
  assert.deepEqual(h.resets, ['subscription', 'project-removed'], 'only topics the old stream had subscribed can be revoked')
  old.dispatchEvent(new Event('error'))
  assert.equal(h.sources.length, 2, 'a stale EOF cannot supersede the replacement connection')
})

test('late WS subscriptions inherit rejected and unavailable bootstrap topics', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const socket = Object.assign(new EventTarget(), { close() {}, send() {} })
  const client = createLiveClient('https://ws-denial.test', { ticket: async () => ['fixture'], socket: () => socket })
  t.after(() => client.dispose())
  const observer = { event() {}, reset() {} }
  const rejected = { kind: 'resources', projectId: 'a' } as const
  const unavailable = { kind: 'resources', projectId: 'b' } as const
  client.subscribe(rejected, observer); client.subscribe(unavailable, observer)
  t.mock.timers.tick(0); await Promise.resolve(); await Promise.resolve()
  socket.dispatchEvent(new Event('open'))
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'subscribed', id: 1,
    cursor: cursor(1), added: [{ topic: unavailable, unavailable: true }], removed: [], rejected: [rejected] }) }))
  const seen: Array<[string, LiveResetReason]> = []
  const a = client.subscribe(rejected, { event() {}, reset: reason => seen.push(['a', reason]) })
  const b = client.subscribe({ kind: 'folders', projectId: 'b' }, { event() {}, reset: reason => seen.push(['b', reason]),
    projectionUnavailable() { assert.fail('known denial must not fall back to HTTP') },
  })
  await Promise.all([assert.rejects(a.ready(), /not available/), assert.rejects(b.ready(), /unavailable/)])
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'topic-reset', reason: 'project-restored',
    cursor: cursor(2), topics: [unavailable], unavailable: [unavailable] }) }))
  await assert.rejects(b.ready(), /unavailable/, 'a restoration marker alone does not grant access')
  assert.deepEqual(seen, [['a', 'project-removed'], ['b', 'project-removed']])
})
