import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createProjectLiveState, createSnapshot } from './project-live-state.ts'
import type { LiveObserver } from './live-client.ts'
import { realtimeTopicKey, type RealtimeTopic } from '../../src/realtime/protocol.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture(t: TestContext, manualReady = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const observers = new Map<string, LiveObserver>()
  const ready = new Map<string, () => void>()
  const requests: Array<{ path: string; signal: AbortSignal; finish: (value: unknown, status?: number) => void }> = []
  const store = createProjectLiveState({ client: () => ({
    subscribe(topic, observer) {
      const key = realtimeTopicKey(topic)
      assert.equal(observers.has(key), false, 'one subscription per shared resource')
      observers.set(key, observer)
      queueMicrotask(() => { if (observers.get(key) === observer) observer.reset('subscription') })
      const promise = new Promise<void>(resolve => { ready.set(key, resolve); if (!manualReady) resolve() })
      return { ready: () => promise, close() { observers.delete(key) } }
    },
  }) }, {
    request: async (url, init) => new Promise(resolve => requests.push({
      path: new URL(String(url)).pathname, signal: init!.signal!,
      finish: (value, status = 200) => resolve(Response.json(value, { status })),
    })),
  })
  t.after(() => store.dispose())
  async function tick() { await flush(); t.mock.timers.tick(50); await flush() }
  function event(topic: RealtimeTopic, payload: unknown = { event: 'invalidate' }) {
    observers.get(realtimeTopicKey(topic))!.event({ type: 'event', cursor: 'fixture:1', topic, payload })
  }
  return { store, observers, requests, tick, event, ready }
}
const graph = (name: string) => ({ sessions: [{ sessionId: 'web:one', title: name }], nodes: [] })
const emptyWork = { items: [], sessions: [], requests: [], effects: [] }

test('workbench overview shares one live reader and stops reading when the surface is hidden', async t => {
  const f = fixture(t)
  const sidebar = f.store.acquireProject('http://fixture', 'a')
  const first = f.store.acquireProject('http://fixture', 'a', undefined, true)
  const second = f.store.acquireProject('http://fixture', 'a', undefined, true)
  await f.tick()
  assert.equal(f.requests.length, 3)
  const work = f.requests.find(request => request.path.endsWith('/work'))!
  work.finish(emptyWork)
  f.requests.find(request => request.path.endsWith('/graph'))!.finish(graph('One'))
  f.requests.find(request => request.path.endsWith('/stages'))!.finish({ stages: {} })
  await flush()
  assert.equal(first.work.state.value, second.work.state.value)
  assert.equal(f.observers.size, 1)
  first.release(); second.release()
  f.event({ kind: 'sessions', projectId: 'a' })
  await f.tick()
  assert.equal(f.requests.filter(request => request.path.endsWith('/work')).length, 1)
  const reopened = f.store.acquireProject('http://fixture', 'a', undefined, true)
  await f.tick()
  assert.equal(f.requests.filter(request => request.path.endsWith('/work')).length, 2)
  const pending = f.requests.at(-1)!
  reopened.release()
  assert.equal(pending.signal.aborted, true, 'Hidden workbench reads are aborted without stopping shared sidebar state')
  sidebar.release()
})

test('chat, sidebar and sound consumers share snapshots and produce zero idle HTTP reads', async t => {
  const f = fixture(t)
  const catalogs = [f.store.acquireCatalog('http://fixture'), f.store.acquireCatalog('http://fixture/projects/a')]
  const leases = [
    f.store.acquireProject('http://fixture', 'a'),
    f.store.acquireProject('http://fixture/projects/a/', 'a'),
    f.store.acquireProject('http://fixture', 'a'),
  ]
  await f.tick()
  assert.equal(f.requests.length, 3)
  assert.equal(f.observers.size, 2)
  f.requests[0].finish({ projects: [{ id: 'a', name: 'A', createdAt: '' }] })
  f.requests[1].finish(graph('One'))
  f.requests[2].finish({ stages: { 'web:one': 'idle' } })
  await flush()
  assert.equal(leases[0].graph.state.value, leases[1].graph.state.value)
  assert.equal(catalogs[0].state.value, catalogs[1].state.value)
  t.mock.timers.tick(5 * 60_000)
  await flush()
  assert.equal(f.requests.length, 3, 'Five idle minutes cause no graph, stages or projects polling')

  f.event({ kind: 'sessions', projectId: 'a' }, { event: 'activity', sessionId: 'web:one' })
  await f.tick()
  assert.equal(f.requests.length, 4)
  assert.ok(f.requests[3].path.endsWith('/stages'), 'phase changes do not reread the graph')
  f.requests[3].finish({ stages: { 'web:one': 'tool' }, activeRequestIds: { 'web:one': 'request-2' } })
  await flush()
  assert.equal(leases[2].activity.state.value?.activeRequestIds['web:one'], 'request-2')
  leases[0].release()
  leases[1].release()
  assert.equal(f.observers.size, 2, 'sound monitoring remains when panes close')
  leases[2].release()
  for (const catalog of catalogs) catalog.release()
  assert.equal(f.observers.size, 0)
})

test('bursts coalesce and changes during a read get one serialized follow-up', async t => {
  const f = fixture(t)
  const lease = f.store.acquireProject('http://fixture', 'a')
  await f.tick()
  f.requests[0].finish(graph('Before'))
  f.requests[1].finish({ stages: {} })
  await flush()
  for (let i = 0; i < 50; i++) f.event({ kind: 'sessions', projectId: 'a' })
  await f.tick()
  assert.equal(f.requests.length, 4)
  for (let i = 0; i < 50; i++) f.event({ kind: 'sessions', projectId: 'a' })
  await f.tick()
  assert.equal(f.requests.length, 4)
  f.requests[2].finish(graph('During'))
  f.requests[3].finish({ stages: { 'web:one': 'llm' } })
  await f.tick()
  assert.equal(f.requests.length, 6)
  f.requests[4].finish(graph('After'))
  f.requests[5].finish({ stages: { 'web:one': 'idle' } })
  await lease.graph.read()
  assert.equal(lease.graph.state.value?.[0].label, 'After')
})

test('reset aborts old snapshots, project scopes stay separate, and failures remain retryable', async t => {
  const f = fixture(t)
  const a = f.store.acquireProject('http://fixture', 'a')
  const b = f.store.acquireProject('http://fixture', 'b')
  await f.tick()
  f.observers.get(realtimeTopicKey({ kind: 'sessions', projectId: 'a' }))!.reset('epoch')
  assert.equal(f.requests[0].signal.aborted, true)
  assert.equal(f.requests[1].signal.aborted, true)
  await f.tick()
  f.requests[0].finish(graph('Stale A'))
  f.requests[1].finish({ stages: { 'web:one': 'tool' } })
  f.requests[2].finish(graph('B'))
  f.requests[3].finish({ stages: { 'web:one': 'waiting' }, waitingForCalls: { 'web:one': true } })
  f.requests[4].finish({}, 503)
  f.requests[5].finish({ stages: { 'web:one': 'invalid' } })
  await flush()
  assert.equal(a.graph.state.value, undefined)
  assert.match(a.graph.state.error, /503/)
  assert.match(a.activity.state.error, /activity/)
  assert.equal(b.graph.state.value?.[0].label, 'B')
  assert.equal(b.activity.state.value?.stages['web:one'], 'waiting-for-call')
  const retry = a.refresh()
  await f.tick()
  f.requests[6].finish(graph('Recovered'))
  f.requests[7].finish({ stages: { 'web:one': 'idle' }, recoveries: { 'web:one': { id: 'turn', reason: 'stopped' } } })
  await retry
  assert.equal(a.graph.state.error, '')
  assert.equal(a.activity.state.value?.recoveries['web:one'].id, 'turn')
  f.event({ kind: 'sessions', projectId: 'a' })
  await f.tick()
  a.release()
  assert.equal(f.requests[8].signal.aborted, true)
  f.requests[8].finish(graph('Disposed'))
  f.requests[9].finish({ stages: {} })
  await flush()
  assert.equal(a.graph.state.value?.[0].label, 'Recovered')
})

test('project creation and rename notifications refresh the shared catalog without polling', async t => {
  const f = fixture(t)
  const catalog = f.store.acquireCatalog('http://fixture')
  await f.tick()
  f.requests[0].finish({ projects: [] })
  await flush()
  f.event({ kind: 'projects' })
  await f.tick()
  f.requests[1].finish({ projects: [{ id: 'new', name: 'Created', createdAt: '' }] })
  await flush()
  assert.equal(catalog.state.value?.[0].name, 'Created')
  f.event({ kind: 'projects' })
  await f.tick()
  f.requests[2].finish({ projects: [{ id: 'new', name: 'Renamed', createdAt: '' }] })
  await flush()
  assert.equal(catalog.state.value?.[0].name, 'Renamed')
})

test('reconnection retries failed snapshots even when replay has no new invalidations', async t => {
  const f = fixture(t)
  let resets = 0
  const catalog = f.store.acquireCatalog('http://fixture')
  const lease = f.store.acquireProject('http://fixture', 'a', { reset: () => { resets++ } })
  await f.tick()
  for (const request of f.requests) request.finish({}, 503)
  await flush()
  assert.ok(catalog.state.error)
  assert.ok(lease.graph.state.error)
  const previousResets = resets
  for (const observer of f.observers.values()) observer.reconnected?.()
  await f.tick()
  assert.equal(resets, previousResets + 1)
  assert.equal(f.requests.length, 6)
  f.requests[3].finish({ projects: [{ id: 'a', name: 'A', createdAt: '' }] })
  f.requests[4].finish(graph('Recovered'))
  f.requests[5].finish({ stages: { 'web:one': 'idle' } })
  await lease.activity.read()
  assert.equal(catalog.state.error, '')
  assert.equal(lease.graph.state.error, '')
  assert.equal(lease.activity.state.error, '')
  assert.equal(lease.graph.state.value?.[0].label, 'Recovered')
})


test('project initialization waits for ready; activation reuses shared applied graph/activity without a trailing read', async t => {
  const f = fixture(t, true)
  const first = f.store.acquireProject('http://fixture', 'a')
  const reading = first.read()
  assert.equal(first.graph.state.loading, true)
  assert.equal(first.activity.state.loading, true)
  await f.tick()
  assert.equal(f.requests.length, 0)
  f.ready.get(realtimeTopicKey({ kind: 'sessions', projectId: 'a' }))!()
  await f.tick()
  assert.equal(f.requests.length, 2)
  f.requests[0].finish(graph('Initial'))
  f.requests[1].finish({ stages: { 'web:one': 'idle' } })
  await reading
  const activated = f.store.acquireProject('http://fixture', 'a')
  await activated.read()
  await f.tick()
  t.mock.timers.tick(1000); await flush()
  assert.equal(f.requests.length, 2)
  f.event({ kind: 'sessions', projectId: 'a' }, { event: 'activity', sessionId: 'web:one' })
  await f.tick()
  assert.equal(f.requests.length, 3)
  f.event({ kind: 'sessions', projectId: 'a' }, { event: 'activity', sessionId: 'web:one' })
  f.requests[2].finish({ stages: { 'web:one': 'tool' } })
  await f.tick()
  assert.equal(f.requests.length, 4, 'real inflight invalidations are not swallowed')
  f.requests[3].finish({ stages: { 'web:one': 'idle' } })
  await flush()
  first.release(); activated.release()
  assert.equal(f.observers.size, 0)
})

test('fallback snapshot is repaired on late ready, and released scopes never read', async t => {
  const f = fixture(t, true)
  const a = f.store.acquireProject('http://fixture', 'a')
  const b = f.store.acquireProject('http://fixture', 'b')
  b.release()
  t.mock.timers.tick(750); await flush(); await f.tick()
  assert.equal(f.requests.length, 2)
  f.requests[0].finish(graph('Fallback'))
  f.requests[1].finish({ stages: {} })
  await flush()
  f.ready.get(realtimeTopicKey({ kind: 'sessions', projectId: 'a' }))!()
  f.ready.get(realtimeTopicKey({ kind: 'sessions', projectId: 'b' }))!()
  await f.tick()
  assert.equal(f.requests.length, 4)
  assert.ok(f.requests.every(request => request.path.includes('/projects/a/')))
  a.release()
  assert.ok(f.requests.slice(2).every(request => request.signal.aborted))
})


test('gated initial loading has no early HTTP and dispose settles readers', async t => {
  const f = fixture(t, true)
  const catalog = f.store.acquireCatalog('http://fixture')
  const project = f.store.acquireProject('http://fixture', 'a')
  const readers = [catalog.read(), project.graph.read(), project.activity.read()]
  assert.equal(catalog.state.loading, true)
  assert.equal(project.graph.state.loading, true)
  assert.equal(project.activity.state.loading, true)
  await f.tick()
  assert.equal(f.requests.length, 0)
  catalog.release(); project.release()
  await Promise.all(readers)
  assert.equal(catalog.state.loading, false)
  assert.equal(project.graph.state.loading, false)
  assert.equal(project.activity.state.loading, false)
  t.mock.timers.tick(1000); await flush()
  assert.equal(f.requests.length, 0)
})

test('snapshot initialLoading is opt-in and external-gate disposal settles a direct waiter', async () => {
  let requests = 0
  const load = async () => { requests++; return 'value' }
  const ordinary = createSnapshot(load, 0)
  assert.equal(ordinary.state.loading, false)
  await ordinary.read()
  assert.equal(requests, 1)
  ordinary.dispose()
  const gated = createSnapshot(load, 0, { initialLoading: true })
  const waiting = gated.read()
  assert.equal(gated.state.loading, true)
  assert.equal(requests, 1)
  gated.dispose()
  await waiting
  assert.equal(gated.state.loading, false)
})


test('history hints do not refresh Work overview; actual activity and Work changes still do', async t => {
  const f = fixture(t)
  const lease = f.store.acquireProject('http://fixture', 'a', undefined, true)
  await f.tick()
  for (const request of f.requests) request.finish(request.path.endsWith('/work') ? emptyWork : request.path.endsWith('/graph') ? graph('One') : { stages: {} })
  await flush()
  f.event({ kind: 'sessions', projectId: 'a' }, { event: 'invalidate', sessionId: 'web:one', changes: ['history'] })
  await f.tick()
  assert.equal(f.requests.filter(request => request.path.endsWith('/work')).length, 1)
  f.event({ kind: 'sessions', projectId: 'a' }, { event: 'activity', sessionId: 'web:one' })
  await f.tick()
  assert.equal(f.requests.filter(request => request.path.endsWith('/work')).length, 2, 'overview retains live execution activity')
  lease.release()
})
