import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { serveGateway } from '../../src/gateway/server.ts'
import { normalizeGatewayUpgradeRequest } from '../../src/gateway/websocket.ts'
import { RealtimeHub, registerRealtimeRoute } from '../../src/realtime/hub.ts'
import { createLiveClient, installMobileLiveSource } from './live-client.ts'

const chat = (sessionId: string) => ({ kind: 'chat', projectId: 'default', sessionId } as const)
const observe = () => {
  const events: unknown[] = [], resets: string[] = []
  let reconnected = 0
  return { events, resets, reconnects: () => reconnected, observer: {
    event: (value: { payload: unknown }) => { events.push(value.payload) },
    reset: (reason: string) => { resets.push(reason) }, reconnected: () => { reconnected++ },
  } }
}

test('client uses one real socket for rapid chat switches, then replays before live events after reconnect', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub({ journalCount: 4 })
  const publisher = hub.registerProject('default')
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: (_, topic) => topic.kind !== 'chat' || topic.sessionId !== 'denied' })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  const sockets: WebSocket[] = []
  const secondUpdateSent = Promise.withResolvers<void>()
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/default`, {
    socket: (url, offered) => {
      const socket = new WebSocket(url, offered)
      sockets.push(socket)
      return {
        addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send(data) {
          socket.send(data)
          if (socket === sockets[0] && JSON.parse(data).id === 2) secondUpdateSent.resolve()
        },
        close() { socket.close() },
      }
    },
  })
  try {
    const sidebar = observe(), a = observe(), b = observe(), c = observe(), denied = observe()
    const sidebarSub = client.subscribe({ kind: 'projects' }, sidebar.observer)
    const first = client.subscribe(chat('a'), a.observer)
    await first.ready()
    await sidebarSub.ready()
    assert.deepEqual(a.resets, ['initial'])
    first.close()
    const second = client.subscribe(chat('b'), b.observer)
    const waiting = assert.rejects(second.ready(), { name: 'AbortError' })
    // Let the first update leave the client before replacing its topic again.
    await secondUpdateSent.promise
    second.close()
    const third = client.subscribe(chat('c'), c.observer)
    const rejected = client.subscribe(chat('denied'), denied.observer)
    await Promise.all([third.ready(), waiting, assert.rejects(rejected.ready(), /not available/)])
    assert.equal(sockets.length, 1)
    assert.deepEqual(sidebar.resets, ['initial'])
    assert.deepEqual(b.resets, [])
    assert.deepEqual(denied.resets, [])
    const live = once(sockets[0], 'message')
    publisher.chat('a', 'removed')
    publisher.chat('denied', 'denied')
    publisher.chat('c', 'before')
    await live
    assert.deepEqual(c.events, ['before'])
    const closed = once(sockets[0], 'close')
    sockets[0].terminate()
    await closed
    publisher.chat('c', 'replay')
    await third.ready()
    assert.equal(sockets.length, 2)
    assert.equal(c.reconnects(), 1)
    assert.deepEqual(c.resets, ['initial'])
    assert.deepEqual(c.events, ['before', 'replay'])
    const after = once(sockets[1], 'message')
    publisher.chat('c', 'after')
    await after
    assert.deepEqual(c.events, ['before', 'replay', 'after'])
    const closedAgain = once(sockets[1], 'close')
    sockets[1].terminate()
    await closedAgain
    for (let i = 0; i < 6; i++) publisher.chat('c', `outside-window-${i}`)
    await third.ready()
    assert.equal(sockets.length, 3)
    assert.deepEqual(c.resets, ['initial', 'expired'])
    assert.deepEqual(c.events, ['before', 'replay', 'after'])
    assert.deepEqual(a.events, [])
    assert.deepEqual(denied.events, [])
  } finally {
    client.dispose()
    hub.close()
    await server.shutdown()
    await server.finished
  }
})

test('mobile uses its delegated SSE source without probing for a WebSocket', async () => {
  let seen = ''
  const restore = installMobileLiveSource(url => {
    seen = url
    return { close() {}, addEventListener(type, receive) {
      if (type === 'realtime') queueMicrotask(() => receive(new MessageEvent('realtime', { data: '{"type":"ready","cursor":"fixture:0"}' })))
    } }
  })
  const client = createLiveClient('https://mobile.example', {
    socket() { throw new Error('must not open a socket') }, ticket() { throw new Error('must not request a ticket') },
  })
  try {
    await client.subscribe(chat('a'), observe().observer).ready()
    assert.equal(new URL(seen).pathname, '/api/live')
  } finally { client.dispose(); restore() }
})

test('a delegated host that does not issue tickets stays on SSE', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  const urls: string[] = []
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    constructor(url: string) { urls.push(url) }
    close() {}
    addEventListener(type: string, receive: EventListener) {
      if (type === 'realtime') queueMicrotask(() => receive(new MessageEvent('realtime', { data: '{"type":"ready","cursor":"fixture:0"}' })))
    }
  } })
  let requests = 0
  const client = createLiveClient('https://delegated.example', {
    socket() { throw new Error('must not open a socket') }, async ticket() { requests++; return undefined },
  })
  try {
    const first = client.subscribe(chat('a'), observe().observer)
    await first.ready()
    const second = client.subscribe(chat('b'), observe().observer)
    await second.ready()
    assert.equal(requests, 1)
    assert.deepEqual(urls.map(url => new URL(url).pathname), ['/api/live', '/api/live'])
  } finally {
    client.dispose()
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor)
    else Reflect.deleteProperty(globalThis, 'EventSource')
  }
})
