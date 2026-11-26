import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { serveGateway } from '../../src/gateway/server.ts'
import { normalizeGatewayUpgradeRequest } from '../../src/gateway/websocket.ts'
import { RealtimeHub, registerRealtimeRoute } from '../../src/realtime/hub.ts'
import { createLiveClient, type LiveObserver } from './live-client.ts'
import { createLiveProjection } from './live-projection.ts'
import { createProjectLiveState } from './project-live-state.ts'
import { createCatalogResources } from './stores/catalog.ts'
import { createBotResources } from './stores/bots.ts'

const topic = { kind: 'io-runs', projectId: 'fixture' } as const
const flush = async () => { await setImmediate(); await setImmediate() }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('Timed out waiting for projection') }

test('projection pushes supersede HTTP, apply keyed removals and recover a mismatched base over WS', async () => {
  let observer!: LiveObserver, legacy!: LiveObserver, refreshes = 0, reads = 0
  let finish!: (value: { runs: { id: string }[] }) => void
  let signal!: AbortSignal
  const projection = createLiveProjection({ client: () => ({ subscribe(t, next) {
    if (t.kind === 'io-runs') observer = next; else legacy = next
    return { ready: () => Promise.resolve(), close() {}, refreshProjection() { refreshes++; return true } }
  } }) }, { base: 'http://fixture', topic, key: 'id', field: 'runs', parse: value => value as { runs: { id: string }[] },
    load: s => { signal = s; reads++; return new Promise(resolve => { finish = resolve }) },
  })
  try {
    observer.projectionUnavailable!()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(reads, 1)
    observer.projectionSnapshot!({ event: 'snapshot', revision: 'one', data: { runs: [{ id: 'a' }, { id: 'b' }] } })
    assert.equal(signal.aborted, true)
    finish({ runs: [{ id: 'stale' }] }); await flush()
    assert.deepEqual(projection.state.value?.runs, [{ id: 'a' }, { id: 'b' }])
    observer.event({ type: 'event', cursor: 'fixture:1', topic, payload: { event: 'delta', base: 'one', revision: 'two', removed: ['a'], upsert: [{ id: 'c' }] } })
    assert.deepEqual(projection.state.value?.runs, [{ id: 'b' }, { id: 'c' }])
    observer.event({ type: 'event', cursor: 'fixture:2', topic, payload: { event: 'delta', base: 'wrong', revision: 'three', removed: [], upsert: [] } })
    assert.equal(refreshes, 1)
    assert.equal(reads, 1, 'normal version recovery requests snapshot:true instead of GET')
    observer.projectionSnapshot!({ event: 'snapshot', revision: 'four', data: { runs: [] } })
    legacy.event({ type: 'event', cursor: 'fixture:3', topic: { kind: 'io', projectId: 'fixture' }, payload: { event: 'invalidate' } })
    assert.equal(reads, 1)
  } finally { projection.dispose() }
  assert.equal(projection.state.value, undefined)
})

test('one real socket negotiates before fixed topics, initial/delta/refresh need no HTTP', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub()
  let runs = [{ id: 'a' }]
  const publisher = hub.registerProject('fixture', undefined, undefined, undefined, () => ({ runs }))
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  const sent: any[] = []; let sockets = 0, reads = 0
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/fixture`, {
    socket(url, protocols) {
      sockets++; const socket = new WebSocket(url, protocols)
      return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send(text) { sent.push(JSON.parse(text)); socket.send(text) }, close() { socket.close() } }
    },
  })
  const projection = createLiveProjection({ client: () => client }, { base: '', topic, key: 'id', field: 'runs', parse: value => value as { runs: { id: string }[] },
    load: async () => { reads++; return { runs: [] } },
  })
  try {
    await projection.read()
    assert.equal(reads, 0)
    assert.deepEqual(projection.state.value?.runs, [{ id: 'a' }])
    assert.ok(sent[0].subscriptions.every((entry: any) => entry.topic.kind === 'resources' || entry.topic.kind === 'io'))
    assert.ok(sent.some(command => command.subscriptions.some((entry: any) => entry.topic.kind === 'io-runs')))
    runs = [{ id: 'b' }]; publisher.invalidateIo!('b')
    await until(() => projection.state.value?.runs[0]?.id === 'b')
    projection.invalidate()
    await until(() => sent.some(command => command.subscriptions.some((entry: any) => entry.topic.kind === 'io-runs' && entry.snapshot)))
    assert.equal(sockets, 1); assert.equal(reads, 0)
  } finally { projection.dispose(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})

test('an older server is never sent unknown fixed topics and uses bounded HTTP fallback', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub({ projectExists: () => true }); const publisher = hub.registerProject('fixture')
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  const sent: any[] = []; let reads = 0
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/fixture`, {
    socket(url, protocols) {
      const socket = new WebSocket(url, protocols)
      return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
        send(text) { sent.push(JSON.parse(text)); socket.send(text) }, close() { socket.close() } }
    },
  })
  const projection = createLiveProjection({ client: () => client }, { base: '', topic, fallbackMs: 30,
    parse: value => value as { runs: unknown[] }, load: async () => { reads++; return { runs: [] } },
  })
  try {
    await projection.read()
    assert.equal(reads, 1)
    assert.ok(sent.length > 0)
    assert.ok(sent.every(command => command.subscriptions.every((entry: any) => entry.topic.kind === 'resources' || entry.topic.kind === 'io')))
    publisher.close()
    await until(() => projection.state.status === 'forbidden')
    assert.equal(projection.state.value, undefined, 'Legacy topology reset immediately hides protected state')
    hub.registerProject('fixture')
    await until(() => projection.state.value !== undefined)
    assert.equal(reads, 2, 'Legacy restoration performs authorized HTTP recovery')
  } finally { projection.dispose(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})

test('scoped summary/stages and shared explorer/picker catalogs consume authorized push without inventory GET', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub()
  let sessions = [{ sessionId: 'web:one', title: 'One' }]
  let folders = [{ id: 'one', name: 'One', path: '/synthetic', createdAt: '' }]
  let devices = [{ nodeId: 'main', name: 'Main', role: 'main', online: true, supported: true }]
  const publisher = hub.registerProject('fixture', undefined, undefined, undefined, projection => {
    if (projection.kind === 'session-summary') return { sessions }
    if (projection.kind === 'session-stages') return { activity: {} }
    if (projection.kind === 'folders') return { folders }
    if (projection.kind === 'folder-devices') return { devices }
    throw new Error('Unsupported fixture projection')
  })
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: () => true })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  const base = `http://127.0.0.1:${server.addr.port}`
  let sockets = 0, requests = 0
  const client = createLiveClient(base, { socket(url, protocols) {
    sockets++; const socket = new WebSocket(url, protocols)
    return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) }, send(text) { socket.send(text) }, close() { socket.close() } }
  } })
  const pool = { client: () => client }
  const request = async () => { requests++; throw new Error('Unexpected HTTP inventory read') }
  const state = createProjectLiveState(pool, { request })
  const catalog = createCatalogResources(request)
  const navigation = state.acquireProject(base, 'fixture')
  const full = state.acquireProject(base, 'fixture', undefined, false, 'full')
  const first = catalog.folders(base, 'fixture', pool), second = catalog.folders(base, 'fixture', pool)
  const picker = catalog.pickerDevices(base, 'fixture', pool)
  try {
    await Promise.all([navigation.read(), full.read(), first.read(), second.read(), picker.read()])
    assert.equal(requests, 0); assert.equal(sockets, 1)
    assert.equal(first.state.value, second.state.value)
    assert.equal(navigation.sessions.state.value?.[0]?.label, 'One')
    assert.equal(navigation.activity.state.value?.stages['web:one'], 'inactive')
    sessions = [{ sessionId: 'web:two', title: 'Two' }]; publisher.invalidateSessions()
    await until(() => navigation.sessions.state.value?.[0]?.sessionId === 'web:two' && full.sessions.state.value?.[0]?.sessionId === 'web:two')
    publisher.invalidateActivity('web:two', { stage: 'tool', waitingForCall: false, activeRequestId: 'active', recovery: null })
    await until(() => navigation.activity.state.value?.activeRequestIds['web:two'] === 'active')
    folders = []; devices = []; publisher.invalidateResource!('folders'); publisher.invalidateResource!('nodes')
    await until(() => first.state.value.value?.length === 0 && picker.state.value.value?.length === 0)
    assert.equal(requests, 0)
    first.release()
    assert.equal(second.state.value.value?.length, 0)
  } finally { first.release(); second.release(); picker.release(); navigation.release(); full.release(); catalog.dispose(); state.dispose(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})

test('disconnected projections fall back and authorization errors clear protected state; disposal cancels recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let observer!: LiveObserver, host!: (status: { phase: 'live' | 'reconnecting' }) => void, reads = 0
  let live = true
  const projection = createLiveProjection({
    client: () => ({ subscribe(t, next) {
      if (t.kind === 'io-runs') observer = next
      return { ready: () => new Promise<void>(() => {}), close() {}, refreshProjection: () => live }
    } }),
    observeHost(_base, next) { host = next; return () => {} },
  }, { base: '', topic, parse: value => value as { runs: unknown[] }, load: async () => { reads++; throw Object.assign(new Error('Denied'), { status: 403 }) } })
  observer.projectionSnapshot!({ event: 'snapshot', revision: 'one', data: { runs: [{ id: 'private' }] } })
  host({ phase: 'live' }); t.mock.timers.tick(30_000); await flush()
  assert.equal(reads, 0)
  live = false; host({ phase: 'reconnecting' }); t.mock.timers.tick(10_000); t.mock.timers.tick(0); await flush()
  assert.equal(reads, 1)
  assert.equal(projection.state.value, undefined)
  assert.equal(projection.state.status, 'forbidden')
  projection.dispose(); t.mock.timers.tick(60_000); await flush()
  assert.equal(reads, 1)
})

test('an unavailable projection ACK falls back once instead of a snapshot retry loop', async () => {
  let observer!: LiveObserver, reads = 0, refreshes = 0
  let acknowledge!: () => void
  const projection = createLiveProjection({ client: () => ({ subscribe(t, next) {
    if (t.kind === 'io-runs') observer = next
    return { close() {}, ready: () => new Promise<void>(resolve => { acknowledge = resolve }), refreshProjection() { refreshes++; return true } }
  } }) }, { base: '', topic, legacy: false, parse: value => value as { runs: unknown[] }, load: async () => { reads++; return { runs: [] } } })
  try {
    observer.projectionUnavailable!(); acknowledge()
    await new Promise(resolve => setTimeout(resolve, 5)); await projection.read()
    assert.equal(reads, 1); assert.equal(refreshes, 0)
  } finally { projection.dispose() }
})

// A subscription acknowledgement is not proof that its snapshot is absent.
test('slow healthy negotiated snapshot and ready do not race a 750ms HTTP read', async () => {
  let observer!: LiveObserver, reads = 0
  const projection = createLiveProjection({ client: () => ({ subscribe(t, next) {
    if (t.kind === 'io-runs') observer = next
    return { ready: () => Promise.resolve(), close() {}, refreshProjection: () => true }
  } }) }, { base: '', topic, parse: value => value as { runs: unknown[] }, load: async () => { reads++; return { runs: [] } } })
  try {
    await new Promise(resolve => setTimeout(resolve, 820))
    assert.equal(reads, 0)
    observer.projectionSnapshot!({ event: 'snapshot', revision: 'slow', data: { runs: [] } })
    await projection.read()
    assert.equal(reads, 0)
  } finally { projection.dispose() }
})

test('shared sidebar catalogs use one authorized socket for initial and changed data without HTTP', { timeout: 5000 }, async () => {
  const app = new Hono()
  app.use('*', async (c, next) => { normalizeGatewayUpgradeRequest(c); await next() })
  const hub = new RealtimeHub()
  let name = 'First'
  const publisher = hub.registerProject('fixture', undefined, undefined, undefined, topic => {
    if (topic.kind === 'channels') return { channels: [{ id: 'bot', projectId: 'fixture', platform: 'qq', displayName: name }] }
    if (topic.kind === 'service-groups') return { revision: name, agents: [], groups: [] }
    throw new Error('Unsupported')
  })
  registerRealtimeRoute(app, hub, () => true, { authorize: () => true, authorizeTopic: (_request, topic) => topic.projectId === 'fixture' })
  const server = serveGateway(app, { host: '127.0.0.1', port: 0 }); await server.ready
  let sockets = 0, reads = 0
  const client = createLiveClient(`http://127.0.0.1:${server.addr.port}/projects/fixture`, { socket(url, protocols) {
    sockets++; const socket = new WebSocket(url, protocols)
    return { addEventListener(type, receive) { (socket as unknown as globalThis.WebSocket).addEventListener(type, receive) },
      send(text) { socket.send(text) }, close() { socket.close() } }
  } })
  const resources = createBotResources(async () => { reads++; throw new Error('Unexpected HTTP') })
  const pool = { client: () => client }
  const first = resources.catalog('', 'fixture', pool), second = resources.catalog('', 'fixture', pool)
  const groups = resources.groups({ apiBase: '', projectId: 'fixture', active: true }, pool)
  try {
    await Promise.all([first.read(), second.read(), groups.read()])
    assert.equal(first.state.value.value, second.state.value.value)
    assert.equal(first.state.value.value?.[0]?.displayName, 'First')
    name = 'Changed'; publisher.invalidateResource!('channels')
    await until(() => first.state.value.value?.[0]?.displayName === 'Changed' && groups.state.value.value?.revision === 'Changed')
    assert.equal(reads, 0); assert.equal(sockets, 1)
    publisher.close()
    await until(() => first.state.value.value === undefined)
    assert.equal(first.state.value.status, 'forbidden')
    assert.equal(groups.state.value.value, undefined)
  } finally { first.release(); second.release(); groups.release(); resources.dispose(); client.dispose(); hub.close(); await server.shutdown(); await server.finished }
})
