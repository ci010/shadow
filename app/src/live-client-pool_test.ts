import test from 'node:test'
import assert from 'node:assert/strict'
import { createLiveClientPool } from './composables/useLiveClient.ts'

// Connection health is host-qualified, not an aggregate of unrelated Main nodes.
test('pool health observers are isolated by canonical host and unsubscribe cleanly', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sources: FakeSource[] = []
  class FakeSource {
    listeners = new Map<string, EventListener>()
    constructor(readonly url: string) { sources.push(this) }
    addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener) }
    close() {}
    ready() { this.listeners.get('realtime')?.({ data: JSON.stringify({ type: 'ready', cursor: 'epoch:0' }) } as unknown as Event) }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource })
  const pool = createLiveClientPool()
  t.after(() => {
    pool.dispose()
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor)
    else Reflect.deleteProperty(globalThis, 'EventSource')
  })
  const a: string[] = [], b: string[] = []
  const unobserve = pool.observeHost('http://a/projects/p', status => a.push(status.phase))
  pool.observeHost('http://b/projects/p', status => b.push(status.phase))
  const subscription = pool.client('http://a/projects/q').subscribe({ kind: 'sessions', projectId: 'q' }, { event() {}, reset() {} })
  t.mock.timers.tick(0)
  assert.deepEqual(a, ['idle', 'connecting'])
  assert.deepEqual(b, ['idle'])
  sources[0].ready()
  assert.deepEqual(a, ['idle', 'connecting', 'live'])
  unobserve()
  subscription.close()
  assert.deepEqual(a, ['idle', 'connecting', 'live'])
  const current: string[] = []
  pool.observeHost('http://a/projects/other', status => current.push(status.phase))()
  assert.deepEqual(current, ['idle'])
})


test('pool disposal owns resource cleanup, supports unsubscribe and late registration, and is idempotent', () => {
  const pool = createLiveClientPool()
  const calls: string[] = []
  pool.onDispose(() => { calls.push('resource'); pool.dispose() })
  const remove = pool.onDispose(() => calls.push('removed'))
  remove()
  pool.dispose()
  pool.dispose()
  pool.onDispose(() => calls.push('late'))()
  assert.deepEqual(calls, ['resource', 'late'])
})

test('one failing resource cleanup does not strand other resources or live clients', () => {
  const pool = createLiveClientPool()
  const client = pool.client('http://fixture')
  let cleaned = false
  pool.onDispose(() => { throw new Error('synthetic cleanup failure') })
  pool.onDispose(() => { cleaned = true })
  assert.throws(() => pool.dispose(), AggregateError)
  assert.equal(cleaned, true)
  assert.throws(() => client.subscribe({ kind: 'projects' }, { event() {}, reset() {} }), /disposed/)
  assert.doesNotThrow(() => pool.dispose())
})
