import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalResourceKey, createResource, ResourceRegistry, ResetRequired } from './engine.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('single flight, coalesced follow-up, immutable publication and no-op identity', async () => {
  const first = deferred<object>(), second = deferred<object>()
  let calls = 0
  const resource = createResource(() => (++calls === 1 ? first.promise : second.promise))
  const values: unknown[] = []
  resource.subscribe(state => { assert.ok(Object.isFrozen(state)); values.push(state) })
  const done = resource.read(); await tick()
  const initialState = resource.state
  resource.invalidate(); resource.invalidate(); resource.invalidate()
  assert.equal(calls, 1)
  const value = { id: 1 }; first.resolve(value); await tick()
  assert.equal(calls, 2)
  second.resolve(value); await done
  assert.equal(resource.state.value, value)
  assert.equal(resource.state.revision, 1)
  assert.equal(initialState.value, undefined)
  assert.ok(values.length > 0)
  assert.equal(resource.state.loading, false)
  resource.dispose()
})

test('reset rejects late responses from loaders that ignore abort', async () => {
  const first = deferred<number>(), second = deferred<number>()
  let calls = 0, signal: AbortSignal | undefined
  const resource = createResource(s => { signal = s; return ++calls === 1 ? first.promise : second.promise })
  const done = resource.read(); await tick()
  const oldSignal = signal!
  resource.reset(); await tick()
  assert.equal(oldSignal.aborted, true)
  second.resolve(2); await done
  first.resolve(1); await tick()
  assert.equal(resource.state.value, 2)
  assert.equal(resource.state.generation, 1)
  resource.dispose()
})

test('pause settles waiters, aborts, and never publishes late results', async () => {
  const pending = deferred<number>()
  const resource = createResource(() => pending.promise)
  const done = resource.read(); await tick(); resource.pause(); await done
  pending.resolve(1); await tick()
  assert.equal(resource.state.value, undefined)
  assert.equal(resource.state.loading, false)
  resource.dispose(); await resource.read()
})

test('validation is atomic and recovery bounded to one attempt', async () => {
  let reads = 0, recovery = 0
  const resource = createResource(async () => ++reads, 0, { validate: value => value === 1, recover: () => { recovery++ } })
  await resource.read()
  assert.equal(resource.state.value, 1)
  await resource.refresh()
  assert.equal(reads, 3)
  assert.equal(recovery, 1)
  assert.equal(resource.state.value, 1)
  assert.equal(resource.state.revision, 1)
  assert.equal(resource.state.status, 'error')
  assert.throws(() => resource.update(() => 4))
  assert.equal(resource.state.value, 1)
  resource.dispose()
})

test('adapter base failures recover once; arbitrary transport errors never do', async () => {
  let reads = 0, resets = 0
  const resource = createResource(async () => { if (++reads === 1) throw new ResetRequired('base'); return 3 }, 0, { recover: () => { resets++ } })
  await resource.read(); assert.equal(resource.state.value, 3); assert.equal(resets, 1)
  resource.dispose()
  const failed = createResource(async () => { throw new Error('offline') }, 0, { recover: () => { resets++ } })
  await failed.read(); assert.equal(failed.state.status, 'error'); assert.equal(resets, 1)
  failed.dispose()
})

test('401/403 clear protected state without retries', async () => {
  for (const status of [401, 403]) {
    let reads = 0
    const resource = createResource(async () => { if (++reads === 1) return 'secret'; throw Object.assign(new Error('denied'), { status }) })
    await resource.read(); assert.equal(resource.state.value, 'secret')
    await resource.refresh(); assert.equal(resource.state.value, undefined)
    assert.equal(resource.state.status, 'forbidden'); assert.equal(reads, 2)
    resource.dispose()
  }
})

test('initial readiness gate does not fetch until invalidated; disposal resolves gate waiters', async () => {
  let reads = 0
  const resource = createResource(async () => ++reads, 0, { initialLoading: true })
  const done = resource.read(); await tick(); assert.equal(reads, 0)
  resource.invalidate('ready'); await done; assert.equal(reads, 1)
  resource.dispose()
  const gated = createResource(async () => 1, 0, { initialLoading: true })
  const waiting = gated.read(); gated.dispose(); await waiting
})

test('timeout aborts loader and settles read; observer failures are isolated', async () => {
  let signal: AbortSignal | undefined
  const resource = createResource(s => { signal = s; return new Promise<number>(() => {}) }, 0, { timeoutMs: 5 })
  resource.subscribe(() => { throw new Error('observer') })
  await resource.read()
  assert.equal(resource.state.status, 'error'); assert.equal(signal?.aborted, true)
  resource.dispose()
})

test('registry shares resource; only last release pauses; eviction never affects active leases', async () => {
  const registry = new ResourceRegistry({ maxInactive: 0 })
  let creations = 0
  const create = () => { creations++; return createResource(async () => 1) }
  const a = registry.acquire('a', create), b = registry.acquire('a', create)
  assert.equal(creations, 1); assert.equal(a.resource, b.resource)
  await a.resource.read(); a.release(); a.release()
  assert.equal(b.resource.state.status, 'ready'); assert.equal(registry.size, 1)
  b.release(); assert.equal(registry.size, 0); assert.equal(b.resource.state.status, 'disposed')
  registry.dispose(); assert.throws(() => registry.acquire('b', create))
})

test('registry retains bounded inactive entries and expires them by TTL', async () => {
  let now = 0
  const registry = new ResourceRegistry({ maxInactive: 1, ttlMs: 100, now: () => now })
  const a = registry.acquire('a', () => createResource(async () => 1)); await a.resource.read(); a.release()
  const again = registry.acquire('a', () => { throw new Error('must reuse') }); assert.equal(again.resource, a.resource); again.release()
  now = 1
  const b = registry.acquire('b', () => createResource(async () => 2)); b.release()
  assert.equal(registry.size, 1); assert.equal(a.resource.state.status, 'disposed')
  now = 101; registry.sweep(); assert.equal(registry.size, 0)
  registry.dispose()
})

test('canonical scope isolates auth/project/projection, sorts objects, preserves arrays', () => {
  const scope = { host: 'https://example.test/', authGeneration: 1, projectId: 'p', resource: 'sessions', projection: 'navigation-v1' }
  const key = canonicalResourceKey({ ...scope, query: { b: 2, a: ['x', 'y'] } })
  assert.equal(key, canonicalResourceKey({ ...scope, host: 'https://example.test', query: { a: ['x', 'y'], b: 2 } }))
  assert.notEqual(key, canonicalResourceKey({ ...scope, query: { a: ['y', 'x'], b: 2 } }))
  for (const changed of [{ authGeneration: 2 }, { projectId: 'q' }, { projection: 'full-v1' }]) {
    assert.notEqual(canonicalResourceKey(scope), canonicalResourceKey({ ...scope, ...changed }))
  }
  assert.throws(() => canonicalResourceKey({ ...scope, query: { count: Infinity } }))
})

test('validated value and adapter version publish atomically; rejected reads cannot advance either', async () => {
  let value = 1, version = 'v1'
  const resource = createResource(async () => value, 0, { version: () => version, validate: v => v < 3 })
  const commits: [number | undefined, string | undefined][] = []
  resource.subscribe(state => { if (state.status === 'ready') commits.push([state.value, state.version]) })
  await resource.read(); assert.equal(resource.state.version, 'v1')
  value = 2; version = 'v2'; await resource.refresh()
  assert.equal(resource.state.value, 2); assert.equal(resource.state.version, 'v2')
  value = 3; version = 'v3'; await resource.refresh()
  assert.equal(resource.state.value, 2); assert.equal(resource.state.version, 'v2')
  assert(commits.every(([v, version]) => (v === 1 && version === 'v1') || (v === 2 && version === 'v2')))
  resource.dispose(); assert.equal(resource.state.version, undefined)
})

test('inactive retention is bounded by UTF-8 bytes as well as entry count; active leases are not evicted', async () => {
  const registry = new ResourceRegistry({ maxInactive: 10, maxInactiveBytes: 12 })
  const a = registry.acquire('a', () => createResource(async () => '中文中文'))
  await a.resource.read(); assert.equal(a.resource.state.status, 'ready')
  assert.equal(registry.size, 1, 'active demand is not dropped by an inactive budget')
  a.release(); assert.equal(registry.size, 0, 'JSON quotes plus UTF-8 characters exceed retention budget')
  const b = registry.acquire('b', () => createResource(async () => 1)); await b.resource.read(); b.release()
  assert.equal(registry.size, 1); registry.dispose()
})
