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
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sources: FakeSource[] = []
  const statuses: LiveStatus[] = []
  const client = createLiveClient('http://fixture.invalid/projects/default/', {
    source: url => { const source = new FakeSource(url); sources.push(source); return source },
    status: status => statuses.push(status), heartbeatTimeoutMs: 1000,
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
  assert.equal(old.closed, true)
  assert.equal(h.sources.filter(source => !source.closed).length, 0)
  h.open()
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
