import test from 'node:test'
import assert from 'node:assert/strict'
import { createInitialLiveSnapshot } from './initial-live-snapshot.ts'
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
function fixture() {
  let ready!: () => void, reads = 0
  const gate = createInitialLiveSnapshot({ refresh: () => { reads++ } })
  gate.attach({ ready: () => new Promise<void>(resolve => { ready = resolve }) })
  return { gate, ready: () => ready(), reads: () => reads }
}
test('delayed healthy ready and pre-ready reset have exactly one initial snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); t.after(() => f.gate.dispose())
  t.mock.timers.tick(500); f.gate.reset(); f.gate.invalidate()
  assert.equal(f.reads(), 0)
  f.ready(); await f.gate.getPromise(); await settle()
  assert.equal(f.reads(), 1)
  t.mock.timers.tick(1000); assert.equal(f.reads(), 1)
})
test('bounded fallback works without live; subsequent ready always catches up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); t.after(() => f.gate.dispose())
  t.mock.timers.tick(749); assert.equal(f.reads(), 0)
  t.mock.timers.tick(1); await f.gate.getPromise(); assert.equal(f.reads(), 1)
  f.ready(); await settle(); assert.equal(f.reads(), 2)
  f.gate.invalidate(); f.gate.reset(); f.gate.reconnected(); assert.equal(f.reads(), 5)
})
test('cleanup cancels fallback and late ready, releases gate waiters', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); f.gate.dispose(); await f.gate.getPromise()
  f.ready(); await settle(); t.mock.timers.tick(1000)
  f.gate.invalidate(); assert.equal(f.reads(), 0)
})
test('fallback then subscription reset plus ready delivers exactly one catchup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); t.after(() => f.gate.dispose())
  t.mock.timers.tick(750); assert.equal(f.reads(), 1)
  f.gate.reset(); f.gate.reconnected(); assert.equal(f.reads(), 1)
  f.gate.invalidate(); assert.equal(f.reads(), 2, 'real events are never suppressed')
  f.ready(); await settle(); assert.equal(f.reads(), 3)
})
test('failed readiness does not swallow later recovery resets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const gate = createInitialLiveSnapshot({ refresh: () => { reads++ } })
  gate.attach({ ready: async () => { throw new Error('offline') } })
  await settle(); t.mock.timers.tick(750); assert.equal(reads, 1)
  gate.reset(); assert.equal(reads, 2)
  gate.dispose()
})
