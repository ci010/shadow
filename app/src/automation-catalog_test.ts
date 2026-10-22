import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createAutomationCatalog } from './automation-catalog.ts'
import type { AutomationSummary } from './automations.ts'
import type { LiveObserver } from './live-client.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const job = (name: string): AutomationSummary => ({ id: 'ordinary-job', name, source: 'cron', session: 'fresh', schedule: 'daily', enabled: true })
const base = 'http://fixture/projects/a'

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const reads: Array<{ base: string; signal: AbortSignal; finish: (jobs: AutomationSummary[]) => void; fail: (error: Error) => void }> = []
  const subscriptions: Array<{ base: string; projectId: string; observer: LiveObserver; closes: number }> = []
  const catalog = createAutomationCatalog({
    client: base => ({
      subscribe: (topic, observer) => {
        assert.equal(topic.kind, 'sessions')
        const entry = { base, projectId: topic.projectId ?? '', observer, closes: 0 }
        subscriptions.push(entry)
        return { ready: async () => {}, close: () => { entry.closes++ } }
      },
    }),
  }, {
    load: (base, signal) => new Promise((finish, fail) => { reads.push({ base, signal, finish, fail }) }),
  })
  t.after(() => catalog.dispose())
  return { catalog, reads, subscriptions }
}

test('all concurrent consumers share initial fetch, invalidation bursts, reconnect and manual refresh', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  const sidebar = catalog.acquire(base)
  const detail = catalog.acquire(`${base}/?ignored=yes#fragment`)
  assert.equal(sidebar.state, detail.state)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].projectId, 'a')
  t.mock.timers.tick(50)
  assert.equal(reads.length, 1)
  reads[0].finish([job('First')])
  await flush()
  assert.equal(sidebar.state.jobs[0].name, 'First')
  assert.equal(detail.state.loaded, true)
  for (let i = 0; i < 20; i++) {
    sidebar.refresh()
    detail.refresh()
    subscriptions[0].observer.reset('subscription')
  }
  t.mock.timers.tick(50)
  assert.equal(reads.length, 2)
  assert.equal(detail.state.loading, true)
  reads[1].finish([job('Refreshed')])
  await flush()
  t.mock.timers.tick(19_900)
  t.mock.timers.tick(50)
  assert.equal(reads.length, 3, 'Only one periodic catalog refresh')
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
  t.mock.timers.tick(50)
  assert.equal(reads.length, 2)
  a.release()
  const replacement = catalog.acquire(base)
  assert.notEqual(a.state, replacement.state)
  assert.equal(replacement.state.jobs.length, 0)
  assert.equal(reads[0].signal.aborted, true)
  reads[0].finish([job('Retired A')])
  reads[1].finish([job('B')])
  await flush()
  t.mock.timers.tick(50)
  reads[2].finish([job('Current A')])
  await flush()
  assert.equal(a.state.jobs.length, 0)
  assert.equal(replacement.state.jobs[0].name, 'Current A')
  assert.equal(b.state.jobs[0].name, 'B')
  const revision = a.state.revision
  subscriptions[0].observer.reset('subscription')
  a.refresh()
  t.mock.timers.tick(50)
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
  t.mock.timers.tick(50)
  reads[0].fail(new Error('Main is unavailable. Retry.'))
  await flush()
  assert.equal(sidebar.state.error, 'Main is unavailable. Retry.')
  assert.equal(detail.state.error, sidebar.state.error)
  assert.equal(detail.state.loading, false)
  assert.equal(detail.state.loaded, false)
  detail.refresh()
  t.mock.timers.tick(50)
  reads[1].finish([job('Saved')])
  await flush()
  assert.equal(sidebar.state.error, '')
  assert.equal(sidebar.state.loaded, true)
  sidebar.refresh()
  t.mock.timers.tick(50)
  reads[2].fail(new Error('Access denied.'))
  await flush()
  assert.equal(detail.state.error, 'Access denied.')
  assert.equal(detail.state.jobs[0].name, 'Saved')
})

test('session activity does not refresh the unrelated automation catalog', async t => {
  const { catalog, reads, subscriptions } = fixture(t)
  catalog.acquire(base)
  t.mock.timers.tick(50)
  reads[0].finish([])
  await flush()
  subscriptions[0].observer.event({
    type: 'event', cursor: 'fixture:1', topic: { kind: 'sessions', projectId: 'a' },
    payload: { event: 'activity', sessionId: 'web:one' },
  })
  t.mock.timers.tick(50)
  assert.equal(reads.length, 1)
})
