import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createAutomationCatalog } from './automation-catalog.ts'
import type { AutomationSummary } from './automations.ts'
import type { LiveObserver, LiveStatus } from './live-client.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const job = (name: string): AutomationSummary => ({ id: 'ordinary-job', name, source: 'cron', session: 'fresh', schedule: 'daily', enabled: true })
const base = 'http://fixture/projects/a'

function fixture(t: TestContext, ready = true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const reads: Array<{ base: string; signal: AbortSignal; finish: (jobs: AutomationSummary[]) => void; fail: (error: Error) => void }> = []
  const subscriptions: Array<{ base: string; projectId: string; observer: LiveObserver; closes: number }> = []
  let statusObserver: ((status: LiveStatus) => void) | undefined
  const catalog = createAutomationCatalog({
    observeHost: (_base, observer) => { statusObserver = observer; observer({ phase: 'live' }); return () => {} },
    client: base => ({
      subscribe: (topic, observer) => {
        assert.equal(topic.kind, 'resources')
        const entry = { base, projectId: topic.projectId ?? '', observer, closes: 0 }
        subscriptions.push(entry)
        return { ready: () => ready ? Promise.resolve() : new Promise<void>(() => {}), close: () => { entry.closes++ } }
      },
    }),
  }, {
    load: (base, signal) => new Promise((finish, fail) => { reads.push({ base, signal, finish, fail }) }),
  })
  t.after(() => catalog.dispose())
  return { catalog, reads, subscriptions, status: (phase: LiveStatus['phase']) => statusObserver?.({ phase }) }
}

test('all concurrent consumers share initial fetch, invalidation bursts, reconnect and manual refresh', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  const sidebar = catalog.acquire(base)
  const detail = catalog.acquire(`${base}/?ignored=yes#fragment`)
  assert.equal(sidebar.state, detail.state)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].projectId, 'a')
  await flush()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 1)
  reads[0].finish([job('First')])
  await flush()
  assert.equal(sidebar.state.jobs[0].name, 'First')
  assert.equal(detail.state.loaded, true)
  for (let i = 0; i < 20; i++) {
    sidebar.refresh()
    detail.refresh()
  }
  await flush()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 2)
  assert.equal(detail.state.loading, true)
  reads[1].finish([job('Refreshed')])
  await flush()
  t.mock.timers.tick(60_000)
  assert.equal(reads.length, 2, 'No healthy recurring refresh')
  sidebar.refresh()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 3)
  sidebar.release()
  assert.equal(reads[2].signal.aborted, false)
  assert.equal(subscriptions[0].closes, 0)
  detail.release()
  assert.equal(reads[2].signal.aborted, true)
  assert.equal(subscriptions[0].closes, 1)
  sidebar.release()
  detail.release()
  reads[2].finish([job('Late')])
  await flush()
  t.mock.timers.tick(40_000)
  assert.equal(reads.length, 3)
  assert.equal(detail.state.jobs[0].name, 'Refreshed')
})

test('project boundaries, release and reacquisition reject late snapshots and observer calls', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  const a = catalog.acquire(base)
  const b = catalog.acquire('http://fixture/projects/b')
  await flush()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 2)
  a.release()
  const replacement = catalog.acquire(base)
  assert.notEqual(a.state, replacement.state)
  assert.equal(replacement.state.jobs.length, 0)
  assert.equal(reads[0].signal.aborted, true)
  reads[0].finish([job('Retired A')])
  reads[1].finish([job('B')])
  await flush()
  await flush()
  t.mock.timers.tick(100)
  reads[2].finish([job('Current A')])
  await flush()
  assert.equal(a.state.jobs.length, 0)
  assert.equal(replacement.state.jobs[0].name, 'Current A')
  assert.equal(b.state.jobs[0].name, 'B')
  const revision = a.state.revision
  subscriptions[0].observer.reset('subscription')
  a.refresh()
  await flush()
  t.mock.timers.tick(100)
  assert.equal(a.state.revision, revision)
  assert.equal(reads.length, 3)
  catalog.dispose()
  assert.ok(subscriptions.every(subscription => subscription.closes === 1))
  replacement.release()
  b.release()
  assert.ok(subscriptions.every(subscription => subscription.closes === 1), 'Disposal and lease cleanup are idempotent')
  assert.throws(() => catalog.acquire(base), /disposed/)
})

test('catalog failure is explicit for every consumer and retry keeps the last successful catalog', async t => {
  const { catalog, reads } = fixture(t)
  const sidebar = catalog.acquire(base)
  const detail = catalog.acquire(base)
  await flush()
  t.mock.timers.tick(100)
  reads[0].fail(new Error('Main is unavailable. Retry.'))
  await flush()
  assert.equal(sidebar.state.error, 'Main is unavailable. Retry.')
  assert.equal(detail.state.error, sidebar.state.error)
  assert.equal(detail.state.loading, false)
  assert.equal(detail.state.loaded, false)
  detail.refresh()
  await flush()
  t.mock.timers.tick(100)
  reads[1].finish([job('Saved')])
  await flush()
  assert.equal(sidebar.state.error, '')
  assert.equal(sidebar.state.loaded, true)
  sidebar.refresh()
  await flush()
  t.mock.timers.tick(100)
  reads[2].fail(new Error('Access denied.'))
  await flush()
  assert.equal(detail.state.error, 'Access denied.')
  assert.equal(detail.state.jobs[0].name, 'Saved')
})

test('session activity does not refresh the unrelated automation catalog', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  catalog.acquire(base)
  await flush()
  t.mock.timers.tick(100)
  reads[0].finish([])
  await flush()
  subscriptions[0].observer.event({
    type: 'event', cursor: 'fixture:1', topic: { kind: 'sessions', projectId: 'a' },
    payload: { event: 'activity', sessionId: 'web:one' },
  })
  await flush()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 1)
})

test('resource invalidation during a pending read queues a serialized follow-up; resets and reconnects recover', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  const lease = catalog.acquire(base)
  await flush()
  t.mock.timers.tick(100)
  const event = (resource: string) => subscriptions[0].observer.event({
    type: 'event', cursor: 'fixture:2', topic: { kind: 'resources', projectId: 'a' },
    payload: { event: 'invalidate', resource },
  })
  event('interactions')
  t.mock.timers.tick(100)
  reads[0].finish([job('Initial')])
  await flush()
  t.mock.timers.tick(100)
  assert.equal(reads.length, 1)
  event('automations')
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 2)
  for (let i = 0; i < 10; i++) event('automations')
  t.mock.timers.tick(50)
  assert.equal(reads.length, 2, 'Never run parallel snapshots')
  reads[1].finish([job('Before invalidation')])
  await flush()
  t.mock.timers.tick(50)
  assert.equal(reads.length, 3, 'Event received while reading is not lost')
  reads[2].finish([job('Current')])
  await flush()
  subscriptions[0].observer.reconnected?.()
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 4)
  reads[3].finish([job('Reconnected')])
  await flush()
  subscriptions[0].observer.reset('subscription')
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 5)
  assert.equal(lease.state.jobs[0].name, 'Reconnected')
})

test('initial ready gate has a bounded fallback and disconnected polling stops after recovery', async t => {
  const { catalog, reads, status } = fixture(t, false)
  const lease = catalog.acquire(base)
  t.mock.timers.tick(749)
  assert.equal(reads.length, 0)
  t.mock.timers.tick(1)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 1)
  reads[0].finish([])
  await flush()
  status('reconnecting')
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 2)
  reads[1].finish([])
  await flush()
  status('live')
  t.mock.timers.tick(90_000)
  assert.equal(reads.length, 2)
  lease.release()
})
