import assert from 'node:assert/strict'
import { EventEmitter, on, once } from 'node:events'
import { test } from 'node:test'
import { Hono } from 'hono'
import WebSocket, { type RawData } from 'ws'
import { serveGateway } from '../gateway/server.ts'
import { normalizeGatewayUpgradeRequest } from '../gateway/websocket.ts'
import { RealtimeHub, registerRealtimeRoute } from './hub.ts'
import type { RealtimeTopic } from './protocol.ts'
import { parseRealtimeSubscription, REALTIME_SUBSCRIBE_BYTES } from './subscription.ts'

test('real live socket switches chat independently, authorizes each topic and resumes or requests a snapshot', { timeout: 5000 }, async () => {
  const hub = new RealtimeHub({ journalCount: 3, heartbeatMs: 60_000 })
  const project = hub.registerProject('main')
  const other = hub.registerProject('other')
  const app = new Hono()
  const authorize = (request: Request) => request.headers.get('authorization') === 'Bearer fixture'
  const sidebar = { kind: 'projects' } as const
  const first = { kind: 'chat', projectId: 'main', sessionId: 'first' } as const
  const next = { ...first, sessionId: 'next' }
  const denied = { ...first, projectId: 'other' }
  const checks: RealtimeTopic[] = []
  registerRealtimeRoute(app, hub, authorize, {
    authorize,
    authorizeTopic: (request, topic) => { checks.push(topic); return authorize(request) && topic.projectId !== 'other' },
  })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  let socket: WebSocket | undefined
  try {
    await server.ready
    const base = `127.0.0.1:${server.addr.port}`
    const path = '/api/live/ws'
    assert.equal((await fetch(`http://${base}${path}`)).status, 401)
    socket = new WebSocket(`ws://${base}${path}`, { headers: { authorization: 'Bearer fixture' } })
    const messages = on(socket, 'message', { signal: AbortSignal.timeout(3500) })
    const receive = async () => JSON.parse(((await messages.next()).value as [RawData])[0].toString())
    await once(socket, 'open')
    const subscribe = (id: number, subscriptions: Array<{ topic: RealtimeTopic; cursor?: string }>) =>
      socket!.send(JSON.stringify({ type: 'subscribe', id, subscriptions }))
    subscribe(1, [{ topic: sidebar }, { topic: first }, { topic: denied }])
    assert.deepEqual(await receive(), { type: 'subscribed', id: 1, cursor: hub.cursor,
      added: [{ topic: sidebar, reason: 'initial' }, { topic: first, reason: 'initial' }], removed: [], rejected: [denied] })
    const cursor = hub.cursor
    project.chat('first', 'old-active')
    project.chat('next', 'replay')
    other.chat('first', 'hidden')
    assert.equal((await receive()).payload, 'old-active')
    subscribe(2, [{ topic: sidebar, cursor: 'ignored-because-unchanged' }, { topic: next, cursor }])
    assert.equal((await receive()).payload, 'replay')
    assert.deepEqual(await receive(), { type: 'subscribed', id: 2, cursor: hub.cursor,
      added: [{ topic: next }], removed: [first], rejected: [] })
    project.chat('first', 'not-delivered')
    hub.invalidateProjects()
    project.chat('next', 'live')
    assert.deepEqual((await receive()).topic, sidebar)
    assert.equal((await receive()).payload, 'live')
    subscribe(3, [{ topic: sidebar }, { topic: first, cursor }])
    assert.deepEqual(await receive(), { type: 'subscribed', id: 3, cursor: hub.cursor,
      added: [{ topic: first, reason: 'expired' }], removed: [next], rejected: [] })
    project.close()
    assert.deepEqual(await receive(), { type: 'topic-reset', cursor: hub.cursor, topics: [first],
      reason: 'project-removed', unavailable: [first] })
    hub.invalidateProjects()
    assert.deepEqual((await receive()).topic, sidebar)
    assert.deepEqual(checks, [sidebar, first, denied, sidebar, next, sidebar, first])
    assert.equal(hub.stats.clients, 1)
    const closed = once(socket, 'close')
    subscribe(3, [])
    assert.equal((await closed)[0], 1008)
    assert.equal(hub.stats.clients, 0)
    await messages.return?.()
  } finally {
    socket?.terminate()
    hub.close()
    await server.shutdown()
    await server.finished
  }
})

test('subscription commands reject malformed input, duplicates and oversized frames', () => {
  const topic = { kind: 'projects' }
  assert.throws(() => parseRealtimeSubscription('x'.repeat(REALTIME_SUBSCRIBE_BYTES + 1)), /too large/)
  assert.throws(() => parseRealtimeSubscription(JSON.stringify({ type: 'subscribe', id: -1, subscriptions: [] })))
  assert.throws(() => parseRealtimeSubscription(JSON.stringify({ type: 'subscribe', id: 0, subscriptions: [{ topic }, { topic }] })), /Duplicate/)
  assert.throws(() => parseRealtimeSubscription(JSON.stringify({ type: 'subscribe', id: 0, subscriptions: [{ topic, cursor: 12 }] })))
})

test('upgrade tickets are single-use, origin-bound and revoked with their browser session', { timeout: 5000 }, async () => {
  const app = new Hono()
  const hub = new RealtimeHub()
  const owner = new AbortController()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  registerRealtimeRoute(app, hub, () => false, {
    authorize: request => request.headers.get('authorization') === 'Bearer fixture',
    ownerSignal: () => owner.signal, authorizeTopic: () => true,
  })
  const gateway = serveGateway(app, { host: '127.0.0.1', port: 0 })
  const sockets: WebSocket[] = []
  try {
    await gateway.ready
    const origin = `http://127.0.0.1:${gateway.addr.port}`
    const path = '/api/live/ws'
    assert.equal((await fetch(origin + path, { method: 'POST' })).status, 401)
    const issue = async () => {
      const response = await fetch(origin + path, { method: 'POST', headers: { origin, authorization: 'Bearer fixture' } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      const { protocol, proof } = await response.json()
      return [protocol, proof] as string[]
    }
    const open = (protocols: string[], clientOrigin = origin) => {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + path, protocols, { origin: clientOrigin, handshakeTimeout: 2000 })
      sockets.push(socket)
      return socket
    }
    const rejects = async (socket: WebSocket) => {
      const [, response] = await once(socket, 'unexpected-response', { signal: AbortSignal.timeout(2000) })
      assert.equal(response.statusCode, 401)
      response.resume()
      socket.on('error', () => {})
      socket.terminate()
    }
    const first = await issue()
    await rejects(open(first, 'https://other.invalid'))
    const socket = open(first)
    await once(socket, 'open')
    assert.equal(socket.protocol, 'shadow.live.v1')
    await rejects(open(first))
    const unused = await issue()
    const closed = once(socket, 'close')
    owner.abort()
    assert.equal((await closed)[0], 1008)
    await rejects(open(unused))
  } finally {
    for (const socket of sockets) socket.terminate()
    hub.close()
    await gateway.shutdown()
    await gateway.finished
  }
})

test('dirty projection churn degrades an active topic without dropping chat, then retries that topic', { timeout: 5000 }, async () => {
  const diagnostics: string[] = []
  const hub = new RealtimeHub({ diagnostic: reason => diagnostics.push(reason) })
  let churnBatch = false, churnActive = 0, id = 'initial'
  const publisher = hub.registerProject('main', undefined, undefined, undefined, () => {
    if (churnBatch) publisher.invalidateIo!('run') // same topic becomes dirty while batch is in progress
    else if (churnActive > 0) { churnActive--; hub.invalidateProjects() }
    return { runs: [{ id }] }
  })
  const app = new Hono()
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  let socket: WebSocket | undefined
  try {
    await server.ready
    socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/api/live/ws`)
    const messages = on(socket, 'message', { signal: AbortSignal.timeout(3500) })
    const receive = async () => JSON.parse(((await messages.next()).value as [RawData])[0].toString())
    await once(socket, 'open')
    const chat = { kind: 'chat', projectId: 'main', sessionId: 'fixture' }
    const projection = { kind: 'io-runs', projectId: 'main' }
    const subscribe = (id: number) => socket!.send(JSON.stringify({ type: 'subscribe', id, subscriptions: [{ topic: chat }, { topic: projection, snapshot: true }] }))
    subscribe(1)
    assert.deepEqual((await receive()).projections[0].snapshot.data, { runs: [{ id: 'initial' }] })
    // One real domain event and exactly three unrelated mutations during its
    // reads; no second domain event arrives to rescue a discarded dirty flag.
    id = 'only update'; churnActive = 3; publisher.invalidateIo!('run')
    const recovered = await receive()
    assert.deepEqual(recovered.topic, projection)
    assert.equal(recovered.payload.event, 'snapshot')
    assert.deepEqual(recovered.payload.data, { runs: [{ id: 'only update' }] })
    assert.deepEqual(diagnostics, ['projection-update-unstable'])
    // Refresh the already active projection, including its real dirty drain.
    id = 'after refresh'; churnBatch = true; subscribe(2)
    const ack = await receive()
    assert.equal(ack.type, 'subscribed')
    assert.deepEqual(ack.projections, [{ topic: projection, error: 'projection_unavailable' }])
    assert.deepEqual(diagnostics, ['projection-update-unstable', 'projection-batch-unstable'])
    publisher.chat('fixture', 'still live')
    assert.equal((await receive()).payload, 'still live')
    churnBatch = false
    const updated = await receive() // bounded retry succeeds without another domain event
    assert.deepEqual(updated.topic, projection)
    assert.equal(updated.payload.event, 'snapshot')
    assert.deepEqual(updated.payload.data, { runs: [{ id: 'after refresh' }] })
    assert.equal(hub.stats.clients, 1)
    await messages.return?.()
  } finally { socket?.terminate(); hub.close(); await server.shutdown(); await server.finished }
})

class DiagnosticSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  bufferedAmount = 0
  frames: string[] = []
  send(text: string) { this.frames.push(text) }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
  subscribe(conversation = false) {
    const topic = conversation
      ? { kind: 'chat', projectId: 'private-project', sessionId: 'private-session' }
      : { kind: 'folders', projectId: 'private-project' }
    this.emit('message', Buffer.from(JSON.stringify({ type: conversation ? 'openConversation' : 'subscribe', id: 1,
      subscriptions: [{ topic }], ...(conversation ? { conversations: [topic] } : {}) })), false)
  }
}
const flushDiagnostics = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('socket diagnostics classify failures without leaking errors and throttle across reconnects', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 })
  const diagnostics: string[] = []
  const hub = new RealtimeHub({ diagnostic: reason => diagnostics.push(reason) })
  hub.registerProject('private-project', undefined, async () => { throw new Error('secret ticket URL payload') }, undefined,
    async () => { throw new Error('secret projection') })
  const connect = (authorize = () => true) => {
    const socket = new DiagnosticSocket()
    hub.connectSocket(socket as unknown as WebSocket, authorize)
    return socket
  }
  try {
    for (let i = 0; i < 5; i++) {
      const socket = connect()
      socket.subscribe(true)
      await flushDiagnostics()
      socket.close()
      const projection = connect()
      projection.subscribe()
      await flushDiagnostics()
      projection.emit('error', new Error('secret socket URL'))
      projection.emit('error', new Error('late secret'))
      const fatal = connect(() => { throw new Error('secret authorization') })
      fatal.subscribe()
      await flushDiagnostics()
    }
    assert.deepEqual(diagnostics, ['subscription-conversation-failed', 'subscription-projection-failed', 'socket-error', 'subscription-failed'])
    assert.equal(hub.stats.clients, 0)
    t.mock.timers.tick(30_000)
    connect().emit('error', new Error('secret'))
    assert.equal(diagnostics.at(-1), 'socket-error')
    assert.equal(diagnostics.length, 5)
  } finally { hub.close() }
})

test('slow subscription diagnostics distinguish phases and clear on ACK, close and hub shutdown', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 })
  for (const phase of ['conversation', 'projection'] as const) {
    for (const ending of ['ack', 'close', 'hub'] as const) {
      const diagnostics: string[] = []
      const hub = new RealtimeHub({ diagnostic: reason => diagnostics.push(reason) })
      let resolve!: (value: unknown) => void
      const pending = new Promise<unknown>(done => { resolve = done })
      hub.registerProject('private-project', undefined, async () => await pending as { data: unknown }, undefined, () => pending)
      const socket = new DiagnosticSocket()
      hub.connectSocket(socket as unknown as WebSocket, () => true)
      socket.subscribe(phase === 'conversation')
      t.mock.timers.tick(1999)
      assert.deepEqual(diagnostics, [])
      if (ending === 'ack') {
        t.mock.timers.tick(1)
        assert.deepEqual(diagnostics, [`subscription-slow-${phase}`])
        t.mock.timers.tick(10_000)
        assert.equal(diagnostics.length, 1)
        resolve(phase === 'conversation' ? { data: {} } : [])
        await flushDiagnostics()
        assert.equal(JSON.parse(socket.frames.at(-1)!).type, 'subscribed')
      } else if (ending === 'close') socket.close()
      else hub.close()
      const count = diagnostics.length
      t.mock.timers.tick(60_000)
      assert.equal(diagnostics.length, count, 'no late slow warning after cleanup')
      if (ending !== 'ack') {
        resolve(phase === 'conversation' ? { data: {} } : [])
        await flushDiagnostics()
        assert.equal(socket.frames.filter(frame => JSON.parse(frame).type === 'subscribed').length, 0)
      }
      hub.close()
    }
  }
})

test('successful ACK clears slow timer and later projection push failure is diagnosed once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 })
  const diagnostics: string[] = []
  const hub = new RealtimeHub({ diagnostic: reason => diagnostics.push(reason) })
  let fail = false
  const publisher = hub.registerProject('private-project', undefined, undefined, undefined, async () => {
    if (fail) throw new Error('private payload URL ticket')
    return []
  })
  try {
    const socket = new DiagnosticSocket()
    hub.connectSocket(socket as unknown as WebSocket, () => true)
    socket.subscribe()
    await flushDiagnostics()
    assert.equal(JSON.parse(socket.frames.at(-1)!).type, 'subscribed')
    t.mock.timers.tick(2500)
    assert.deepEqual(diagnostics, [])
    fail = true
    publisher.invalidateResource!('folders')
    await flushDiagnostics()
    assert.deepEqual(diagnostics, ['projection-update-failed'])
    assert.equal(hub.stats.clients, 0)
    t.mock.timers.tick(60_000)
    assert.deepEqual(diagnostics, ['projection-update-failed'])
  } finally { hub.close() }
})
