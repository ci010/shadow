import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireInteractionRead } from './interaction-resource.ts'
import type { ResourceLivePool } from './live-resource-refresh.ts'
import type { LiveObserver } from './live-client.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))
const wait = () => new Promise(resolve => setTimeout(resolve, 70))
function fixture() {
  let observer!: LiveObserver
  let closed = 0
  let unobserved = 0
  const pool: ResourceLivePool = {
    client: () => ({ subscribe: (_topic, value) => { observer = value; return { ready: async () => {}, close() { closed++ } } } }),
    observeHost: (_base, notify) => { notify({ phase: 'live' } as Parameters<typeof notify>[0]); return () => { unobserved++ } },
  }
  return { pool, observer: () => observer, closed: () => closed, unobserved: () => unobserved }
}

test('panes share initial GET and cache; healthy idle live never fetches; last pane cleans up', async t => {
  const live = fixture()
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
  assert.equal(live.closed(), 1)
  assert.equal(live.unobserved(), 1)
})

test('invalidation during async GET queues a fresh read; explicit write invalidation and reconnect refresh', async t => {
  const live = fixture()
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
  const live = fixture()
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
  const live = fixture()
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
  const pool: ResourceLivePool = { client: () => ({ subscribe: () => ({ close() {}, ready: () => new Promise<void>(resolve => { ready = resolve }) }) }) }
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
  c.dispose(); await last; ready(); await settle()
  assert.equal(count, 1)
})

test('manual load bypasses initial gate and identical endpoints remain pool-isolated', async t => {
  const makePool = (): ResourceLivePool => ({ client: () => ({ subscribe: () => ({ ready: () => new Promise<void>(() => {}), close() {} }) }) })
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ requests: [count] }) })
  const a = acquireInteractionRead(makePool(), 'http://fixture', 'a', 'http://fixture/list', () => {})
  const b = acquireInteractionRead(makePool(), 'http://fixture', 'a', 'http://fixture/list', () => {})
  t.after(() => { a.dispose(); b.dispose() })
  assert.deepEqual(await a.load(true), { requests: [1] })
  assert.deepEqual(await b.load(true), { requests: [2] })
  assert.equal(count, 2)
})
