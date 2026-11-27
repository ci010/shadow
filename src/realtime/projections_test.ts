import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { RealtimeHub } from './hub.ts'
import { isRealtimeTopic, realtimeTopicKey } from './protocol.ts'
import { parseRealtimeSubscription } from './subscription.ts'
import { projectionPayload, projectionRevision, type ProjectionReader, type ProjectionTopic } from './projections.ts'

class Socket extends EventEmitter {
  OPEN = 1
  readyState = 1
  bufferedAmount = 0
  frames: any[] = []
  send(text: string) { this.frames.push(JSON.parse(text)) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  subscribe(id: number, topics: ProjectionTopic[], snapshot = false, cursor?: string) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', id,
      subscriptions: topics.map(topic => ({ topic, ...(snapshot ? { snapshot: true } : {}), ...(cursor ? { cursor } : {}) })) })), false)
  }
  async frame() {
    for (let count = 0; count < 1000; count++) {
      if (this.frames.length) return this.frames.shift()
      await setImmediate()
    }
    throw new Error('No socket frame')
  }
}
const summary = { kind: 'session-summary', projectId: 'fixture', scope: 'navigation' } as const
const runs = { kind: 'io-runs', projectId: 'fixture' } as const
const nodes = { kind: 'nodes', projectId: 'fixture' } as const
function fixture(reader: ProjectionReader, options: ConstructorParameters<typeof RealtimeHub>[0] = {}) {
  const hub = new RealtimeHub({ heartbeatMs: 60_000, ...options })
  const publisher = hub.registerProject('fixture', undefined, undefined, undefined, reader)
  const open = (authorize: (topic: any) => boolean = () => true) => {
    const socket = new Socket()
    hub.connectSocket(socket as unknown as WebSocket, authorize)
    return socket
  }
  return { hub, publisher, open }
}

test('fixed scoped projection topics validate, isolate keys and reject arbitrary RPC', () => {
  assert.ok(isRealtimeTopic(summary))
  assert.notEqual(realtimeTopicKey(summary), realtimeTopicKey({ ...summary, scope: 'full' as const }))
  for (const topic of [{ ...summary, scope: 'other' }, { ...nodes, path: '/api/config' }, { kind: 'get', projectId: 'fixture' }]) {
    assert.equal(isRealtimeTopic(topic), false)
  }
  assert.equal(parseRealtimeSubscription(JSON.stringify({ type: 'subscribe', id: 1, subscriptions: [{ topic: summary, snapshot: true }] })).subscriptions[0].snapshot, true)
})

test('summary and io produce revisioned keyed upsert/remove; unchanged rows are omitted', () => {
  for (const topic of [summary, runs]) {
    const field = topic.kind === 'session-summary' ? 'sessions' : 'runs'
    const key = topic.kind === 'session-summary' ? 'sessionId' : 'id'
    const before = { [field]: [{ [key]: 'keep' }, { [key]: 'remove' }, { [key]: 'change', name: 'old' }] }
    const data = { [field]: [{ [key]: 'keep' }, { [key]: 'change', name: 'new' }, { [key]: 'add' }] }
    assert.deepEqual(projectionPayload(topic, data, { data: before, revision: 'base' }), {
      event: 'delta', base: 'base', revision: projectionRevision(data),
      upsert: [{ [key]: 'change', name: 'new' }, { [key]: 'add' }], removed: ['remove'],
    })
  }
})

test('subscribe ack contains authoritative snapshot, subsequent summary/io changes push delta without GET', async () => {
  let sessions = [{ sessionId: 'old' }]
  let io = [{ id: 'run' }]
  const f = fixture(topic => topic.kind === 'session-summary' ? { sessions } : { runs: io })
  try {
    const socket = f.open()
    socket.subscribe(1, [summary, runs])
    const ack = await socket.frame()
    assert.equal(ack.projections.length, 2)
    assert.deepEqual(ack.projections[0].snapshot.data, { sessions })
    const base = ack.projections[0].snapshot.revision
    sessions = [{ sessionId: 'new' }]
    f.publisher.invalidateSessions()
    const changed = await socket.frame()
    assert.equal(changed.payload.event, 'delta')
    assert.equal(changed.payload.base, base)
    assert.deepEqual(changed.payload.removed, ['old'])
    io = []
    f.publisher.invalidateIo!('run')
    assert.deepEqual((await socket.frame()).payload.removed, ['run'])
    // Explicit recovery does not require tearing down the shared connection.
    socket.subscribe(2, [summary, runs], true)
    assert.equal((await socket.frame()).projections[0].snapshot.event, 'snapshot')
  } finally { f.hub.close() }
})

test('snapshot races retry at a mutation watermark and reconnect always resnapshots even after journal expiry', async () => {
  let sessions = [{ sessionId: 'before' }]
  let release!: () => void
  let first = true
  const f = fixture(async () => {
    const captured = structuredClone({ sessions })
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
    return captured
  }, { journalCount: 1 })
  try {
    const socket = f.open()
    socket.subscribe(1, [summary])
    sessions = [{ sessionId: 'after' }]
    f.publisher.invalidateSessions()
    release()
    const ack = await socket.frame()
    assert.deepEqual(ack.projections[0].snapshot.data, { sessions })
    socket.close()
    sessions = [{ sessionId: 'reconnected' }]
    f.publisher.invalidateSessions(); f.publisher.invalidateSessions()
    const resumed = f.open()
    resumed.subscribe(1, [summary], false, ack.cursor)
    const next = await resumed.frame()
    assert.deepEqual(next.projections[0].snapshot.data, { sessions })
    assert.equal(next.projections[0].snapshot.event, 'snapshot')
  } finally { f.hub.close() }
})

test('authorization is checked again after async inventory reads; revoked viewer receives no body', async () => {
  let release!: () => void
  let allowed = true
  const f = fixture(async () => { await new Promise<void>(resolve => { release = resolve }); return { secret: 'private' } })
  try {
    const socket = f.open(() => allowed)
    socket.subscribe(1, [nodes])
    allowed = false
    release()
    const ack = await socket.frame()
    assert.equal(JSON.stringify(ack).includes('private'), false)
    assert.deepEqual(ack.rejected, [nodes])
    assert.deepEqual(ack.projections, [])
    assert.equal(JSON.stringify(ack).includes('snapshot'), false)
  } finally { f.hub.close() }
})

test('denied inventory never reads or publishes; per-client baselines do not cross viewer boundaries', async () => {
  let reads = 0
  const f = fixture(() => { reads++; return { version: 1, nodes: [] } })
  try {
    const denied = f.open(() => false)
    denied.subscribe(1, [nodes])
    assert.deepEqual((await denied.frame()).rejected, [nodes])
    assert.equal(reads, 0)
    const allowed = f.open()
    allowed.subscribe(1, [nodes])
    assert.ok((await allowed.frame()).projections[0].snapshot)
    const another = f.open()
    another.subscribe(1, [nodes])
    assert.ok((await another.frame()).projections[0].snapshot)
    assert.equal(denied.frames.length, 0)
  } finally { f.hub.close() }
})

test('closing a project lease during a read never sends stale inventory under its replacement', async () => {
  let release!: () => void
  const f = fixture(async () => { await new Promise<void>(resolve => { release = resolve }); return { stale: 'private' } })
  try {
    const socket = f.open()
    socket.subscribe(1, [nodes])
    f.publisher.close()
    f.hub.registerProject('fixture', undefined, undefined, undefined, () => ({ fresh: true }))
    release()
    const ack = await socket.frame()
    assert.equal(JSON.stringify(ack).includes('private'), false)
  } finally { f.hub.close() }
})

test('projection snapshots use the existing bounded slow-client disconnect policy', async () => {
  const f = fixture(() => ({ sessions: [{ sessionId: 'x'.repeat(1000) }] }), { clientBytes: 512, diagnostic: () => {} })
  try {
    const socket = f.open()
    socket.subscribe(1, [summary])
    for (let count = 0; count < 100 && socket.readyState === 1; count++) await setImmediate()
    assert.equal(socket.readyState, 3)
    assert.equal(socket.frames.length, 0)
  } finally { f.hub.close() }
})
