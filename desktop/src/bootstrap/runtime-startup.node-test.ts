import assert from 'node:assert/strict'
import test from 'node:test'
import type { EnsureRuntimeResult, MainRuntimeStatus } from './coordinator.js'
import { RuntimeStartup } from './runtime-startup.js'

const ready: EnsureRuntimeResult = {
  ok: true,
  context: {
    version: 1, mode: 'child', localNodeId: 'fixture', mainConnection: 'connecting',
    mainLatencyMs: null, uiScopes: [], apiBase: 'http://127.0.0.1:43124',
  },
}

test('Electron starts before a renderer exists; reads and concurrent retries share the attempt', async () => {
  let launches = 0
  let resolve!: (value: EnsureRuntimeResult) => void
  const deferred = new Promise<EnsureRuntimeResult>(done => { resolve = done })
  const startup = new RuntimeStartup(() => { launches++; return deferred }, () => ({ phase: 'ready' }))
  assert.deepEqual(await startup.current(), { ok: false, code: 'invalid-state' })
  assert.equal(launches, 0)
  const attempt = startup.start()
  assert.equal(startup.start(), attempt)
  const renderer = startup.current()
  await Promise.resolve()
  assert.equal(launches, 1)
  resolve(ready)
  assert.deepEqual(await renderer, ready)
  assert.deepEqual(await startup.current(), ready)
  assert.equal(launches, 1)
})

test('failed startup remains visible across reloads until explicit retry', async () => {
  let launches = 0
  const failure: EnsureRuntimeResult = {
    ok: false, code: 'runtime-unavailable', failure: { role: 'child', kind: 'readiness-timeout' },
  }
  const startup = new RuntimeStartup(async () => ++launches === 1 ? failure : ready, () => ({ phase: 'ready' }))
  await startup.start()
  assert.deepEqual(await startup.current(), failure)
  assert.deepEqual(await startup.current(), failure)
  assert.equal(launches, 1)
  await startup.start()
  assert.deepEqual(await startup.current(), ready)
  assert.equal(launches, 2)
})

test('a crashed runtime does not return cached ready context or restart on observation', async () => {
  let status: MainRuntimeStatus = { phase: 'ready' }
  let launches = 0
  const startup = new RuntimeStartup(async () => { launches++; return ready }, () => status)
  await startup.start()
  status = { phase: 'failed', role: 'child', kind: 'crash' }
  assert.deepEqual(await startup.current(), {
    ok: false, code: 'runtime-unavailable', failure: { role: 'child', kind: 'crash' },
  })
  assert.equal(launches, 1)
})

test('provider setup attempts replace current result and retries use the persisted-profile launcher', async () => {
  let retries = 0
  const startup = new RuntimeStartup(async () => { retries++; return ready }, () => ({ phase: 'ready' }))
  const failure = { ok: false, code: 'runtime-unavailable', failure: { role: 'main', kind: 'readiness-timeout' } } as const
  assert.deepEqual(await startup.start(async () => failure), failure)
  assert.deepEqual(await startup.current(), failure)
  assert.equal(retries, 0)
  assert.deepEqual(await startup.start(), ready)
  assert.deepEqual(await startup.current(), ready)
  assert.equal(retries, 1)
  assert.deepEqual(await startup.start(async () => ready), ready)
  assert.deepEqual(await startup.current(), ready)
  assert.equal(retries, 1)
})

test('explicit setup validates its own role/step after any pending saved-profile startup', async () => {
  let resolve!: (value: EnsureRuntimeResult) => void
  const startup = new RuntimeStartup(() => new Promise(done => { resolve = done }), () => ({ phase: 'ready' }))
  const pending = startup.start()
  let setupCalls = 0
  const setup = startup.start(async () => { setupCalls++; return { ok: false, code: 'invalid-state' } })
  await Promise.resolve()
  assert.equal(setupCalls, 0)
  resolve(ready)
  assert.deepEqual(await pending, ready)
  assert.deepEqual(await setup, { ok: false, code: 'invalid-state' })
  assert.equal(setupCalls, 1)
  assert.deepEqual(await startup.current(), { ok: false, code: 'invalid-state' })
})
