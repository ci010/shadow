import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DataLayoutController } from './data-layout-controller.js'
import { parseMigrationProgress } from './data-layout-command.js'

test('read-only detection does not run migration and ready profiles need no upgrade', async () => {
  let runs = 0
  const controller = new DataLayoutController(async () => ({ status: 'ready' }), async () => { runs++ })
  assert.equal((await controller.inspect('/profile')).status, 'ready')
  await controller.start()
  assert.equal(runs, 0)
})
test('explicit upgrade publishes real progress and validates readiness before success', async () => {
  let ready = false
  let release!: () => void
  const controller = new DataLayoutController(async () => ({ status: ready ? 'ready' : 'migration-required' }), async (_, progress) => {
    progress({ phase: 'staging', completed: 2, total: 4 })
    await new Promise<void>(resolve => { release = resolve })
    ready = true
  })
  await controller.inspect('/selected-legacy')
  const operation = controller.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(controller.current()?.progress, { phase: 'staging', completed: 2, total: 4 })
  assert.equal((await controller.inspect('/other')).dataDir, '/selected-legacy')
  release()
  assert.equal((await operation).status, 'ready')
})
test('failure retains actionable error; retry redetects and never clears blocked locks', async () => {
  let blocked = false, runs = 0
  const controller = new DataLayoutController(async () => ({ status: blocked ? 'blocked' : 'migration-required', reason: 'Inspect lock' }), async () => { runs++; blocked = true; throw new Error('stale lock: inspect recovery') })
  await controller.inspect('/legacy')
  assert.match((await controller.start()).error!, /stale lock/)
  assert.equal((await controller.start()).status, 'blocked')
  assert.equal(runs, 1)
  blocked = false
  await controller.start()
  assert.equal(runs, 2)
})
test('complete progress event alone is not upgrade success', async () => {
  const controller = new DataLayoutController(async () => ({ status: 'migration-required' }), async (_, progress) => progress({ phase: 'complete', completed: 1, total: 1 }))
  await controller.inspect('/legacy')
  assert.match((await controller.start()).error!, /ready data layout/)
})
test('progress parser ignores diagnostics and malformed counts', () => {
  assert.equal(parseMigrationProgress('diagnostic'), undefined)
  assert.equal(parseMigrationProgress('{"type":"migration-progress","phase":"staging","completed":4,"total":2}'), undefined)
  assert.deepEqual(parseMigrationProgress('{"type":"migration-progress","phase":"inventory","completed":0,"total":0}'), { phase: 'inventory', completed: 0, total: 0 })
})
