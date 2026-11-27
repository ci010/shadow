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
    assert.deepEqual(denied.resets, ['project-removed'], 'rejecting an entitled-looking topic also clears any observer baseline')
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

test('established socket opens a conversation in one command and fences a racing append', { timeout: 5000 }, async () => {
  const app = new Hono()
  const hub = new RealtimeHub()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const presence = Promise.withResolvers<string>()
  let reads = 0
  let version = 0
  const publisher = hub.registerProject('default', undefined, async sessionId => {
    const data = { sessionId, version }
    if (++reads === 1) { entered.resolve(); await release.promise }
    return { data }
  }, report => presence.resolve(report.clientId))
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  const commands: string[] = []
  let socket!: WebSocket
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/default`, {
    ticket: async () => [],
    socket: url => {
      socket = new WebSocket(url)
      return {
        addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send(data) { commands.push(JSON.parse(data).type); socket.send(data) },
        close() { socket.close() },
      }
    },
  })
  try {
    const sidebar = client.subscribe({ kind: 'projects' }, observe().observer)
    await sidebar.ready()
    const frames: unknown[] = []
    const sub = client.subscribe(chat('web:a'), {
      reset() {}, event: event => frames.push(event.payload), conversationSnapshot: snapshot => frames.push(snapshot),
    })
    await entered.promise
    version++
    publisher.chat('web:a', 'included-by-retry')
    release.resolve()
    await sub.ready()
    assert.deepEqual(frames, [{ sessionId: 'web:a', version: 1 }])
    assert.deepEqual(commands, ['subscribe', 'openConversation'])
    const live = once(socket, 'message')
    publisher.chat('web:a', 'after-snapshot')
    await live
    assert.deepEqual(frames, [{ sessionId: 'web:a', version: 1 }, 'after-snapshot'])
    const clientId = 'c41b1bb7-0b27-44e1-ae8a-b2adf85f7ce2'
    assert.equal(client.reportPresence('default', { clientId, visible: true, focused: true, interactionAgeMs: 0, system: null }), true)
    assert.equal(await presence.promise, clientId)
    assert.equal(commands.at(-1), 'presence')
  } finally {
    release.resolve()
    client.dispose()
    hub.close()
    await server.shutdown()
    await server.finished
  }
})

test('openConversation keeps parallel panes isolated and reopens after journal expiration', { timeout: 5000 }, async () => {
  const app = new Hono()
  const hub = new RealtimeHub({ journalCount: 2 })
  const slowEntered = Promise.withResolvers<void>()
  const slowRelease = Promise.withResolvers<void>()
  const scans: string[] = []
  const publisher = hub.registerProject('default', undefined, async id => {
    scans.push(id)
    if (id === 'web:slow') { slowEntered.resolve(); await slowRelease.promise }
    return { data: id }
  })
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  const sockets: WebSocket[] = []
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/default`, {
    ticket: async () => [],
    socket: url => {
      const socket = new WebSocket(url)
      sockets.push(socket)
      return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send: data => socket.send(data), close: () => socket.close() }
    },
  })
  try {
    await client.subscribe({ kind: 'projects' }, observe().observer).ready()
    const results: string[] = []
    const reopened = Promise.withResolvers<void>()
    const pane = (id: string) => client.subscribe(chat(id), {
      event() {}, reset() {}, conversationSnapshot(data) {
        results.push(`${id}=${data}`)
        if (results.filter(item => item === 'web:steady=web:steady').length === 2) reopened.resolve()
      },
    })
    const steady = pane('web:steady')
    const abandoned = pane('web:slow')
    await slowEntered.promise
    abandoned.close()
    const next = pane('web:next')
    slowRelease.resolve()
    await Promise.all([steady.ready(), next.ready()])
    assert.deepEqual(results, ['web:steady=web:steady', 'web:next=web:next'])
    assert.equal(sockets.length, 1)
    const closed = once(sockets[0], 'close')
    sockets[0]!.terminate()
    await closed
    for (let i = 0; i < 4; i++) publisher.chat('web:steady', { event: 'conversation_summary', data: i })
    await reopened.promise
    assert.equal(sockets.length, 2)
    assert.ok(scans.filter(id => id === 'web:steady').length >= 2)
    assert.ok(!results.some(item => item.startsWith('web:slow=')))
  } finally {
    slowRelease.resolve()
    client.dispose(); hub.close(); await server.shutdown(); await server.finished
  }
})

test('active conversation keeps append and completion while a refresh snapshot is in flight', { timeout: 5000 }, async () => {
  const app = new Hono()
  const hub = new RealtimeHub()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  let saved: string[] = []
  const publisher = hub.registerProject('default', undefined, async () => {
    const data = [...saved]
    if (++reads === 2) { entered.resolve(); await release.promise }
    if (reads === 5) return { error: 'conversation_unavailable' }
    return { data }
  })
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
  await server.ready
  let wire!: WebSocket
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/default`, {
    ticket: async () => [],
    socket: url => {
      const socket = wire = new WebSocket(url)
      return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send: data => socket.send(data), close: () => socket.close() }
    },
  })
  try {
    await client.subscribe({ kind: 'projects' }, observe().observer).ready()
    const pane = observe()
    const refreshed = Promise.withResolvers<unknown>()
    const refreshedAgain = Promise.withResolvers<unknown>()
    const failed = Promise.withResolvers<void>()
    const recovered = Promise.withResolvers<unknown>()
    let snapshots = 0
    const active = client.subscribe(chat('web:active'), { ...pane.observer,
      conversationRefreshFailed: () => failed.resolve(), conversationSnapshot(data) {
      if (++snapshots === 2) refreshed.resolve(data)
      if (snapshots === 3) refreshedAgain.resolve(data)
      if (snapshots === 4) recovered.resolve(data)
    } })
    await active.ready()
    assert.equal(active.refreshConversation?.(), true)
    await entered.promise
    // A refresh requested after dispatch must survive the older ACK.
    assert.equal(active.refreshConversation?.(), true)
    saved = ['synthetic answer']
    const delivered = once(wire, 'message')
    publisher.chat('web:active', { event: 'session_message' }, 'request')
    await delivered
    const completed = once(wire, 'message')
    publisher.chat('web:active', { event: 'turn_finished' }, 'request')
    await completed
    assert.deepEqual(pane.events, [{ event: 'session_message' }, { event: 'turn_finished' }])
    release.resolve()
    assert.deepEqual(await refreshed.promise, saved)
    assert.deepEqual(await refreshedAgain.promise, saved)
    assert.equal(reads, 4)
    assert.equal(active.refreshConversation?.(), true)
    await failed.promise
    // An ordinary subscription round trip proves there is no queued retry.
    await client.subscribe(chat('web:barrier'), observe().observer).ready()
    assert.equal(reads, 5)
    assert.deepEqual(pane.resets, [])
    const stillLive = once(wire, 'message')
    publisher.chat('web:active', { event: 'response', content: 'still live' })
    await stillLive
    assert.deepEqual(pane.events.at(-1), { event: 'response', content: 'still live' })
    assert.equal(active.refreshConversation?.(), true)
    assert.deepEqual(await recovered.promise, saved)
    assert.equal(reads, 6)
  } finally {
    release.resolve()
    client.dispose(); hub.close(); await server.shutdown(); await server.finished
  }
})

test('an authorized conversation restore clears revocation on both snapshot and fallback ACK', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub({ projectExists: id => id === 'default' })
  let publisher = hub.registerProject('default', undefined, async () => ({ data: 'initial' }))
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  let opened = 0
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}`, { socket(url, protocols) {
    opened++
    const socket = new WebSocket(url, protocols)
    return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) }, send(text) { socket.send(text) }, close() { socket.close() } }
  } })
  const view = observe()
  const snapshots: unknown[] = []
  let failures = 0
  const sidebar = client.subscribe({ kind: 'projects' }, observe().observer)
  async function until(check: () => boolean) {
    for (let i = 0; i < 160; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('Timed out waiting for authorized chat restore')
  }
  try {
    // Opening the conversation uses the capability negotiated on the host ACK.
    await sidebar.ready()
    const subscription = client.subscribe(chat('restored'), { ...view.observer,
      conversationSnapshot: value => snapshots.push(value), conversationRefreshFailed: () => { failures++ },
    })
    await subscription.ready()
    assert.deepEqual(snapshots, ['initial'])
    for (const result of ['snapshot', 'fallback'] as const) {
      publisher.close()
      await until(() => view.resets.filter(reason => reason === 'project-removed').length === (result === 'snapshot' ? 1 : 2))
      await assert.rejects(subscription.ready(), /unavailable/)
      publisher = hub.registerProject('default', undefined, async () => result === 'snapshot' ? { data: 'restored' } : { error: 'conversation_unavailable' })
      await until(() => result === 'snapshot' ? snapshots.length === 2 : failures === 1)
      await subscription.ready()
      publisher.chat('restored', result)
      await until(() => view.events.includes(result))
    }
    assert.equal(opened, 1)
    assert.deepEqual(snapshots, ['initial', 'restored'])
    assert.deepEqual(view.events, ['snapshot', 'fallback'])
  } finally { sidebar.close(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})

test('an old in-flight open ACK cannot release a replacement conversation topology', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub({ projectExists: id => id === 'default' })
  const enteredOld = Promise.withResolvers<void>(), finishOld = Promise.withResolvers<void>()
  const enteredNew = Promise.withResolvers<void>(), finishNew = Promise.withResolvers<void>()
  let oldReads = 0, newReads = 0
  const publisher = hub.registerProject('default', undefined, async () => {
    if (++oldReads === 1) return { data: 'initial' }
    enteredOld.resolve(); await finishOld.promise
    return { data: 'stale old runtime' }
  })
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  const commands: string[] = []
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}`, { socket(url, protocols) {
    const socket = new WebSocket(url, protocols)
    return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
      send(text) { commands.push(JSON.parse(text).type); socket.send(text) }, close() { socket.close() } }
  } })
  const view = observe()
  const snapshots: unknown[] = []
  let fallback = 0
  const sidebar = client.subscribe({ kind: 'projects' }, observe().observer)
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 160; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('Timed out waiting for topology transition')
  }
  try {
    await sidebar.ready()
    const sub = client.subscribe(chat('restored'), { ...view.observer, conversationSnapshot: value => snapshots.push(value), conversationRefreshFailed: () => { fallback++ } })
    await sub.ready(); assert.deepEqual(snapshots, ['initial'])
    assert.equal(sub.refreshConversation?.(), true)
    await enteredOld.promise
    publisher.close()
    await until(() => view.resets.includes('project-removed'))
    await assert.rejects(sub.ready(), /unavailable/)
    const replacement = hub.registerProject('default', undefined, async () => {
      newReads++; enteredNew.resolve(); await finishNew.promise
      return { data: 'replacement runtime' }
    })
    finishOld.resolve()
    await enteredNew.promise
    assert.equal(fallback, 0, 'old in-flight ACK must not become the authorized fallback')
    assert.deepEqual(snapshots, ['initial'], 'no old snapshot or speculative grant')
    let ready = false
    const restored = sub.ready().then(() => { ready = true })
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(ready, false, 'the current conversation snapshot still owns readiness')
    finishNew.resolve(); await restored
    assert.deepEqual(snapshots, ['initial', 'replacement runtime'])
    assert.equal(newReads, 1)
    assert.deepEqual(commands, ['subscribe', 'openConversation', 'openConversation', 'openConversation'])
    replacement.chat('restored', 'live again')
    await until(() => view.events.includes('live again'))
  } finally { finishOld.resolve(); finishNew.resolve(); sidebar.close(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})
