import test from 'node:test'
import assert from 'node:assert/strict'
import { createLiveResourceRefresh, type ResourceLivePool } from './live-resource-refresh.ts'
import type { LiveObserver, LiveStatus } from './live-client.ts'

function fixture(phase: LiveStatus['phase'] = 'live', kind: 'interactions' | 'service-groups' | 'automations' = 'interactions') {
  let observer!: LiveObserver
  let status!: (value: LiveStatus) => void
  let closed = 0, unobserved = 0, reads = 0
  const pool: ResourceLivePool = {
    client: () => ({ subscribe(topic, value) {
      assert.deepEqual(topic, { kind: 'resources', projectId: 'p' })
      observer = value
      return { ready: async () => {}, close() { closed++ } }
    } }),
    observeHost(base, callback) {
      assert.equal(base, 'http://fixture/projects/p')
      status = callback; callback({ phase })
      return () => { unobserved++ }
    },
  }
  const resource = createLiveResourceRefresh(pool, { base: 'http://fixture/projects/p', projectId: 'p', resource: kind, refresh: () => { reads++ } })
  const event = (resource: string) => observer.event({ type: 'event', topic: { kind: 'resources', projectId: 'p' }, cursor: 'epoch:1', payload: { event: 'invalidate', resource } })
  return { resource, event, observer: () => observer, status: (phase: LiveStatus['phase']) => status({ phase }), reads: () => reads, closed: () => closed, unobserved: () => unobserved }
}

test('healthy resources have one initial read, no idle polling and coalesce bursts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); t.after(() => f.resource.dispose())
  await f.resource.getPromise()
  t.mock.timers.tick(180_000)
  assert.equal(f.reads(), 1)
  f.event('service-groups'); t.mock.timers.tick(50)
  assert.equal(f.reads(), 1)
  for (let n = 0; n < 20; n++) f.event('interactions')
  t.mock.timers.tick(49); assert.equal(f.reads(), 1)
  t.mock.timers.tick(1); assert.equal(f.reads(), 2)
})

test('disconnected hosts use bounded fallback and live recovery cancels it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture('connecting'); t.after(() => f.resource.dispose())
  await f.resource.getPromise()
  t.mock.timers.tick(29_999); assert.equal(f.reads(), 1)
  t.mock.timers.tick(1); t.mock.timers.tick(50); assert.equal(f.reads(), 2)
  f.status('live')
  f.observer().reconnected?.(); t.mock.timers.tick(50)
  assert.equal(f.reads(), 3)
  t.mock.timers.tick(180_000); assert.equal(f.reads(), 3)
  f.status('reconnecting')
  t.mock.timers.tick(30_000); t.mock.timers.tick(50)
  assert.equal(f.reads(), 4)
})

test('reset/reconnect refresh, and disposing cancels pending work plus both subscriptions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  await f.resource.getPromise()
  f.observer().reset('subscription'); f.observer().reconnected?.()
  t.mock.timers.tick(50); assert.equal(f.reads(), 2)
  f.event('interactions'); f.status('error')
  f.resource.dispose(); f.resource.dispose()
  f.event('interactions'); f.observer().reset('reconnect')
  t.mock.timers.tick(180_000)
  assert.equal(f.reads(), 2)
  assert.equal(f.closed(), 1); assert.equal(f.unobserved(), 1)
})


test('automation snapshots ignore unrelated resource events and do not poll a healthy host', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture('live', 'automations')
  t.after(() => f.resource.dispose())
  await f.resource.getPromise()
  f.event('interactions'); f.event('service-groups')
  t.mock.timers.tick(100_000)
  assert.equal(f.reads(), 1)
  f.event('automations')
  t.mock.timers.tick(50)
  assert.equal(f.reads(), 2)
})
