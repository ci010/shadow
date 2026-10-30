import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { acquireInteractionRead } from './interaction-resource.ts'
import type { ResourceLivePool } from './live-resource-refresh.ts'
import type { LiveObserver } from './live-client.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))
const wait = () => new Promise(resolve => setTimeout(resolve, 70))
function fixture(t: TestContext) {
  const disposers = new Set<() => void>()
  const dispose = () => { for (const callback of disposers) callback(); disposers.clear() }
  t.after(dispose)
  let observer!: LiveObserver
  let closed = 0
  let unobserved = 0
  const pool: ResourceLivePool = {
    onDispose: callback => { disposers.add(callback); return () => { disposers.delete(callback) } },
    client: () => ({ subscribe: (_topic, value) => { observer = value; return { ready: async () => {}, close() { closed++ } } } }),
    observeHost: (_base, notify) => { notify({ phase: 'live' } as Parameters<typeof notify>[0]); return () => { unobserved++ } },
  }
  return { pool, dispose, observer: () => observer, closed: () => closed, unobserved: () => unobserved }
}

test('panes share initial GET and cache; healthy idle live never fetches; pool cleans up', async t => {
  const live = fixture(t)
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ requests: [] }) })
  const a = acquireInteractionRead(live.pool, 'http://localhost/projects/a', 'a', 'http://localhost/list', () => {})
  const b = acquireInteractionRead(live.pool, 'http://localhost/projects/a', 'a', 'http://localhost/list', () => {})
  await Promise.all([a.load(), b.load()])
  await b.load()
  await wait()
  assert.equal(count, 1)
  a.dispose()
  assert.equal(live.closed(), 0)
  b.dispose()
  assert.equal(live.closed(), 0)
  live.dispose()
  assert.equal(live.closed(), 1)
  assert.equal(live.unobserved(), 1)
})

test('invalidation during async GET queues a fresh read; explicit write invalidation and reconnect refresh', async t => {
  const live = fixture(t)
  const finishes: Array<(response: Response) => void> = []
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => finishes.push(resolve)))
  let notifications = 0
  const read = acquireInteractionRead(live.pool, 'http://localhost', 'a', 'http://localhost/list', () => { notifications++; void read.load() })
  t.after(() => read.dispose())
  const initial = read.load()
  await settle()
  live.observer().reset?.({} as never)
  await wait()
  assert.equal(finishes.length, 1)
  finishes[0]!(Response.json({ requests: ['old'] }))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(finishes.length, 2)
  finishes[1]!(Response.json({ requests: ['fresh'] }))
  await initial
  await settle()
  assert.deepEqual(await read.load(), { requests: ['fresh'] })
  read.invalidate()
  await settle()
  assert.equal(finishes.length, 3)
  finishes[2]!(Response.json({ requests: [] }))
  await settle()
  live.observer().reconnected?.()
  await wait()
  assert.equal(finishes.length, 4)
  finishes[3]!(Response.json({ requests: [] }))
  await settle()
  assert.equal(notifications, 3)
})

test('final cleanup aborts shared GET and discards late cache for a later mount', async t => {
  const live = fixture(t)
  let signal!: AbortSignal
  let finish!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', (_url, init) => { signal = init.signal; return new Promise<Response>(resolve => { finish = resolve }) })
  const read = acquireInteractionRead(live.pool, 'http://localhost', 'a', 'http://localhost/list', () => {})
  const pending = assert.rejects(read.load(), /cancelled/)
  await settle()
  read.dispose()
  assert.equal(signal.aborted, true)
  finish(Response.json({ requests: ['late'] }))
  await pending
  assert.equal(live.closed(), 0)
  live.dispose()
  assert.equal(live.closed(), 1)
})

test('hidden pages release resource observers and resume with one fresh snapshot', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const live = fixture(t)
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ requests: [] }) })
  const read = acquireInteractionRead(live.pool, 'http://localhost', 'a', 'http://localhost/list', () => { void read.load() })
  t.after(() => read.dispose())
  await read.load()
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(live.closed(), 1)
  await wait()
  assert.equal(count, 1)
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(count, 2)
})

test('unmount before ready cancels gated leases without HTTP; another pane remains independent', async t => {
  let ready!: () => void, count = 0
  const pool = fixture(t).pool
  pool.client = () => ({ subscribe: () => ({ close() {}, ready: () => new Promise<void>(resolve => { ready = resolve }) }) })
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ requests: [] }) })
  const a = acquireInteractionRead(pool, 'http://fixture', 'a', 'http://fixture/list', () => {})
  const b = acquireInteractionRead(pool, 'http://fixture', 'a', 'http://fixture/list', () => {})
  const first = assert.rejects(a.load(), /cancelled/)
  const second = b.load()
  a.dispose(); ready(); await first; await second
  assert.equal(count, 1)
  b.dispose()
  const c = acquireInteractionRead(pool, 'http://fixture', 'a', 'http://fixture/list', () => {})
  const last = assert.rejects(c.load(), /cancelled/)
  c.dispose(); await last; await settle()
  assert.equal(count, 1)
})

test('manual load bypasses initial gate and identical endpoints remain pool-isolated', async t => {
  const makePool = (): ResourceLivePool => { const pool = fixture(t).pool; pool.client = () => ({ subscribe: () => ({ ready: () => new Promise<void>(() => {}), close() {} }) }); return pool }
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ requests: [count] }) })
  const a = acquireInteractionRead(makePool(), 'http://fixture', 'a', 'http://fixture/list', () => {})
  const b = acquireInteractionRead(makePool(), 'http://fixture', 'a', 'http://fixture/list', () => {})
  t.after(() => { a.dispose(); b.dispose() })
  assert.deepEqual(await a.load(true), { requests: [1] })
  assert.deepEqual(await b.load(true), { requests: [2] })
  assert.equal(count, 2)
})

test('new sessions reuse Project cache; inactive invalidation never fetches; projects isolate', async t => {
  const live = fixture(t)
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ snapshot: ++count }))
  const acquire = (project = 'a') => acquireInteractionRead(live.pool, 'http://fixture', project, 'http://fixture/list', () => {})
  const a = acquire(); await a.load(); a.dispose()
  const b = acquire(); assert.deepEqual(await b.load(), { snapshot: 1 }); b.dispose()
  live.observer().event?.({ payload: { event: 'invalidate', resource: 'interactions' } } as never)
  await wait(); assert.equal(count, 1)
  const c = acquire(); assert.deepEqual(await c.load(), { snapshot: 2 }); c.dispose()
  live.observer().reconnected?.(); await wait(); assert.equal(count, 2)
  const d = acquire(); assert.deepEqual(await d.load(), { snapshot: 3 })
  assert.deepEqual(await d.load(true), { snapshot: 4 })
  const other = acquire('b'); assert.deepEqual(await other.load(), { snapshot: 5 })
  d.dispose(); other.dispose()
})

test('idle expiry reclaims cache; active age never forces HTTP; pool cleanup cancels eviction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const live = fixture(t)
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json({ snapshot: ++count }))
  const acquire = () => acquireInteractionRead(live.pool, 'http://fixture', 'a', 'http://fixture/list', () => {})
  const a = acquire(); await a.load()
  t.mock.timers.tick(60_001)
  assert.deepEqual(await a.load(), { snapshot: 1 })
  a.dispose(); t.mock.timers.tick(59_999); assert.equal(live.closed(), 0)
  t.mock.timers.tick(1); assert.equal(live.closed(), 1); assert.equal(live.unobserved(), 1); assert.equal(count, 1)
  const b = acquire(); assert.deepEqual(await b.load(), { snapshot: 2 }); b.dispose()
  live.dispose(); assert.equal(live.closed(), 2)
  t.mock.timers.tick(60_000); assert.equal(live.closed(), 2)
})

test('pool disposal aborts HTTP and cancels pending notifications; disposed pool cannot subscribe', async t => {
  const live = fixture(t)
  let signal!: AbortSignal, finish!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', (_url, init) => { signal = init.signal; return new Promise<Response>(resolve => { finish = resolve }) })
  let disposed = false
  const a = acquireInteractionRead(live.pool, 'http://fixture', 'a', 'http://fixture/list', () => { assert.equal(disposed, false) })
  const pending = assert.rejects(a.load(), /cancelled/)
  await settle(); live.observer().reset?.({} as never); live.dispose(); disposed = true
  assert.equal(signal.aborted, true); assert.equal(live.closed(), 1); assert.equal(live.unobserved(), 1)
  finish(Response.json({ requests: [] })); await pending; await wait()
  await assert.rejects(a.load(), /cancelled/); a.dispose()
  live.pool.onDispose = callback => { callback(); return () => {} }
  live.pool.client = () => { throw new Error('must not subscribe') }
  const b = acquireInteractionRead(live.pool, 'http://fixture', 'a', 'http://fixture/list', () => {})
  await assert.rejects(b.load(true), /cancelled/); b.dispose()
  assert.equal(live.closed(), 1)
})


test('retained cache does not report an old completed GET as a current HTTP read', async t => {
  const live = fixture(t)
  const finishes: Array<(response: Response) => void> = []
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => finishes.push(resolve)))
  const a = acquireInteractionRead(live.pool, 'http://localhost', 'a', 'http://localhost/list', () => {})
  const first = a.load()
  await settle()
  assert.equal(a.started(), true)
  finishes[0](Response.json({ requests: [] }))
  await first
  a.dispose()
  const b = acquireInteractionRead(live.pool, 'http://localhost', 'a', 'http://localhost/list', () => {})
  t.after(() => b.dispose())
  assert.equal(b.started(), false, 'manual reload may bypass a new readiness wait despite an old cached GET')
  await b.load()
  assert.equal(finishes.length, 1)
  const forced = b.load(true)
  assert.equal(b.started(), true)
  finishes[1](Response.json({ requests: [] }))
  await forced
  assert.equal(b.started(), false)
})
