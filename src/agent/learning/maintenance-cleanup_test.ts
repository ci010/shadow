import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Journal } from '../../watermarks/journal.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { MaintenanceCleanupError, MaintenanceGate } from './maintenance-gate.ts'
import { LearningLedger } from './ledger.ts'

function competitor(home: string, path: string, expectBusy = false) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { MaintenanceGate } from './src/agent/learning/maintenance-gate.ts'
    import { writeFileSync } from 'node:fs'
    try {
      new MaintenanceGate(${JSON.stringify(home)}).writeSync([${JSON.stringify(path)}], () => writeFileSync(${JSON.stringify(join(home, 'competitor-result'))}, 'published'))
      if (${expectBusy}) throw new Error('Expected same-path contention')
    } catch (error) { if (!${expectBusy} || !error.message.includes('path is busy')) throw error }
  `], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(child.status, 0, child.stderr)
}
function releaseBarrier(t: TestContext, home: string, inject: () => void) {
  const file = projectStoragePath(home, 'state/learning/document-maintenance-v1/gate.json'), save = Journal.prototype.save
  t.mock.method(Journal.prototype, 'save', function (this: Journal<unknown>, state: unknown) {
    if ((this as unknown as { file: string }).file === file && state && typeof state === 'object' &&
      'writers' in state && Array.isArray(state.writers) && state.writers.length === 0) inject()
    return save.call(this, state)
  })
}
for (const mode of ['sync', 'async'] as const) {
  test(`${mode}: fresh CAS retries clean only own writer after three real distinct-path competitors`, async t => withTempWorkspace(async home => {
    let armed = false, remaining = 3, actions = 0
    releaseBarrier(t, home, () => { if (armed && remaining-- > 0) competitor(home, 'memory/topics/other.md') })
    const gate = new MaintenanceGate(home)
    const action = () => { actions++; writeFileSync(join(home, 'source'), 'published'); armed = true; return 'result' }
    assert.equal(mode === 'sync' ? gate.writeSync(['memory/topics/one.md'], action) : await gate.write(['memory/topics/one.md'], action), 'result')
    assert.equal(actions, 1)
    assert.equal(readFileSync(join(home, 'competitor-result'), 'utf8'), 'published')
    assert.deepEqual(gate.status().writers, [])
    assert.deepEqual(gate.status().writerPaths, {})
  }))
  test(`${mode}: action error survives release CAS competition unchanged`, async t => withTempWorkspace(async home => {
    let armed = false, once = false
    releaseBarrier(t, home, () => { if (armed && !once) { once = true; competitor(home, 'memory/topics/other.md') } })
    const gate = new MaintenanceGate(home), original = new Error('ORIGINAL_ACTION_FAILURE')
    const action = () => { armed = true; throw original }
    if (mode === 'sync') assert.throws(() => gate.writeSync(['memory/topics/one.md'], action), error => error === original)
    else await assert.rejects(() => gate.write(['memory/topics/one.md'], action), error => error === original)
    assert.deepEqual(gate.status().writers, [])
  }))
  test(`${mode}: real cleanup failure retains evidence and both errors without replaying source`, async t => withTempWorkspace(async home => {
    let armed = false, fail = true, actions = 0
    const cleanupFailure = Object.assign(new Error('synthetic gate storage EIO'), { code: 'EIO' })
    releaseBarrier(t, home, () => { if (armed && fail) throw cleanupFailure })
    const gate = new MaintenanceGate(home), original = new Error('SOURCE_FAILED_AFTER_EFFECT')
    const action = () => { actions++; writeFileSync(join(home, 'effect'), 'retained'); armed = true; throw original }
    let caught: unknown
    try { if (mode === 'sync') gate.writeSync(['memory/topics/one.md'], action); else await gate.write(['memory/topics/one.md'], action) }
    catch (error) { caught = error }
    assert.ok(caught instanceof MaintenanceCleanupError)
    assert.equal(caught.actionReturned, false)
    assert.deepEqual(caught.errors, [original, cleanupFailure])
    assert.equal(gate.status().writers.length, 1)
    assert.equal(JSON.parse(readFileSync(caught.evidencePath!, 'utf8')).actionOutcome, 'threw')
    fail = false; caught.retryCleanup(); caught.retryCleanup()
    assert.deepEqual(gate.status().writers, [])
    assert.equal(actions, 1)
    assert.equal(readFileSync(join(home, 'effect'), 'utf8'), 'retained')
  }))
}
test('ledger publication is not rolled back in memory by a later cleanup EIO or CAS conflict', async t => withTempWorkspace(async home => {
  const ledger = new LearningLedger(home, 'synthetic-cleanup')
  ledger.setRetry('reflector', { attempts: 1 })
  let armed = false, inject = 'competition'
  releaseBarrier(t, home, () => {
    if (!armed) return
    if (inject === 'competition') { inject = ''; competitor(home, 'memory/topics/other.md') }
    else if (inject === 'EIO') { inject = ''; throw Object.assign(new Error('synthetic cleanup EIO'), { code: 'EIO' }) }
  })
  armed = true; ledger.setRetry('reflector', { attempts: 2 })
  assert.equal(ledger.retry('reflector').attempts, 2)
  inject = 'EIO'
  let cleanup: unknown
  try { ledger.setRetry('reflector', { attempts: 3 }) } catch (error) { cleanup = error }
  assert.ok(cleanup instanceof MaintenanceCleanupError)
  assert.equal(cleanup.actionReturned, true)
  assert.equal(ledger.retry('reflector').attempts, 3)
  assert.equal(new LearningLedger(home, 'synthetic-cleanup').retry('reflector').attempts, 3)
  ledger.setRetry('encapsulator', { attempts: 5 })
  assert.equal(new LearningLedger(home, 'synthetic-cleanup').retry('reflector').attempts, 3)
  cleanup.retryCleanup()
  assert.deepEqual(new MaintenanceGate(home).status().writers, [])
}))
test('same-path process is refused while the owning callback executes', async () => withTempWorkspace(async home => {
  new MaintenanceGate(home).writeSync(['memory/topics/same.md'], () => competitor(home, 'memory/topics/same.md', true))
  assert.deepEqual(new MaintenanceGate(home).status().writers, [])
}))

for (const mode of ['sync', 'async'] as const) {
  test(`${mode}: successful action plus real cleanup EIO reports retained result and never replays`, async t => withTempWorkspace(async home => {
    let armed = false, fail = true, actions = 0
    const storageError = Object.assign(new Error('synthetic cleanup EIO'), { code: 'EIO' })
    releaseBarrier(t, home, () => { if (armed && fail) throw storageError })
    const gate = new MaintenanceGate(home)
    const action = () => { actions++; writeFileSync(join(home, 'published'), 'actual source result'); armed = true; return 'published-result' }
    let caught: unknown
    try { if (mode === 'sync') gate.writeSync(['memory/topics/one.md'], action); else await gate.write(['memory/topics/one.md'], action) }
    catch (error) { caught = error }
    assert.ok(caught instanceof MaintenanceCleanupError)
    assert.equal(caught.actionReturned, true); assert.equal(caught.actionResult, 'published-result')
    assert.deepEqual(caught.errors, [storageError])
    assert.equal(JSON.parse(readFileSync(caught.evidencePath!, 'utf8')).actionOutcome, 'returned')
    assert.equal(gate.status().writers.length, 1)
    fail = false; caught.retryCleanup()
    assert.equal(actions, 1); assert.deepEqual(gate.status().writers, [])
  }))
}

test('cleanup CAS retry budget is bounded; exhaustion retains only its own unresolved evidence', async t => withTempWorkspace(async home => {
  const { JournalConflictError } = await import('../../watermarks/journal.ts')
  let armed = false, conflicts = 0, fail = true, actions = 0
  releaseBarrier(t, home, () => {
    if (armed && fail) { conflicts++; throw new JournalConflictError('Injected persistent CAS contention') }
  })
  const gate = new MaintenanceGate(home)
  let caught: unknown
  try { gate.writeSync(['memory/topics/one.md'], () => { actions++; armed = true }) } catch (error) { caught = error }
  assert.ok(caught instanceof MaintenanceCleanupError)
  assert.equal(conflicts, 32); assert.equal(actions, 1)
  assert.equal(gate.status().writers.length, 1)
  fail = false; caught.retryCleanup()
  assert.deepEqual(gate.status().writers, [])
}))

test('native filesystem cleanup failure retains source outcome and immutable evidence without deleting any gate bytes', async t => withTempWorkspace(async home => {
  const { mkdirSync, renameSync } = await import('node:fs')
  const gateFile = projectStoragePath(home, 'state/learning/document-maintenance-v1/gate.json'), preserved = `${gateFile}.preserved`
  let armed = false, injected = false, actions = 0
  releaseBarrier(t, home, () => {
    if (!armed || injected) return
    injected = true
    // Fault harness only: preserve the entire admitted gate byte-for-byte, then
    // make its pathname a directory. Real Journal IO produces EISDIR; no fake
    // gate state, source replay, lock deletion or writer-table repair is used.
    renameSync(gateFile, preserved); mkdirSync(gateFile)
  })
  const gate = new MaintenanceGate(home)
  let caught: unknown
  try { gate.writeSync(['memory/topics/one.md'], () => { actions++; writeFileSync(join(home, 'source'), 'published'); armed = true; return 'source-result' }) }
  catch (error) { caught = error }
  assert.ok(caught instanceof MaintenanceCleanupError)
  assert.equal((caught.cleanupError as NodeJS.ErrnoException).code, 'EISDIR')
  assert.equal(caught.actionReturned, true); assert.equal(caught.actionResult, 'source-result')
  assert.equal(JSON.parse(readFileSync(preserved, 'utf8')).writers.length, 1)
  assert.match(JSON.parse(readFileSync(caught.evidencePath!, 'utf8')).cleanupError, /EISDIR/)
  // Repair only the deliberately faulted fixture path using the preserved
  // original bytes. Keep the fault directory as evidence, never clear records.
  renameSync(gateFile, `${gateFile}.fault-directory`); renameSync(preserved, gateFile)
  caught.retryCleanup()
  assert.equal(actions, 1); assert.deepEqual(gate.status().writers, [])
  assert.equal(readFileSync(join(home, 'source'), 'utf8'), 'published')
}))

test('learning scheduler reports cleanup separately without callback replay or retry-counter spending', async t => withTempWorkspace(async home => {
  const { Bus } = await import('../../bus/bus.ts')
  const { createProjectScope } = await import('../../projects/scope.ts')
  const { TestCronService } = await import('../../cron/testing.ts')
  const { LearningService } = await import('./service.ts')
  t.mock.timers.enable({ apis: ['setInterval'] })
  const scope = createProjectScope('synthetic-cleanup-service'), ledger = new LearningLedger(home, scope.projectId)
  let armed = false, fail = true, actions = 0, cleanup: unknown
  releaseBarrier(t, home, () => { if (armed && fail) throw Object.assign(new Error('synthetic cleanup EIO'), { code: 'EIO' }) })
  const cron = new TestCronService(home, 'UTC', scope)
  const service = new LearningService(new Bus(), scope, {
    async reflector() {
      try { return await new MaintenanceGate(home).write(['memory/topics/one.md'], () => { actions++; armed = true; return 'already-published-result' }) }
      catch (error) { cleanup = error; throw error }
    }, async encapsulator() { return false }, async soulReflector() { return false },
  }, { reflectIntervalMs: 10, encapsulateIntervalMs: 20, soulIntervalMs: 30, pipelines: { encapsulator: false, soulReflector: false } }, cron, () => false, ledger)
  try {
    await assert.rejects(() => service.trigger('reflector'), /Source action returned/)
    t.mock.timers.tick(100)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(actions, 1)
    assert.equal(ledger.retry('reflector').attempts, 0)
    assert.match(service.status().pipelines.reflector.paused!, /source action must not be replayed/)
    assert.ok(cleanup instanceof MaintenanceCleanupError)
    fail = false; cleanup.retryCleanup()
    assert.deepEqual(new MaintenanceGate(home).status().writers, [])
  } finally { await service.stop(); await cron.stop(); scope.close() }
}))

test('cleanup failure retains durable evidence but cannot keep detached source admissions alive', async t => withTempWorkspace(async home => {
  let armed = false, fail = true, release!: () => void, continuation!: Promise<unknown>
  const later = new Promise<void>(resolve => { release = resolve }), gate = new MaintenanceGate(home)
  releaseBarrier(t, home, () => { if (armed && fail) throw Object.assign(new Error('synthetic cleanup EIO'), { code: 'EIO' }) })
  let caught: unknown, actions = 0
  try {
    gate.writeSync(['memory/topics/one.md'], () => {
      actions++; continuation = later.then(() => gate.writeSync([], () => { actions++ }))
      armed = true; return 'done'
    })
  } catch (error) { caught = error }
  assert.ok(caught instanceof MaintenanceCleanupError)
  assert.equal(gate.status().writers.length, 1)
  const observed = continuation.catch(error => error)
  release()
  assert.match(String(await observed), /Expired writer admission/)
  assert.equal(actions, 1)
  fail = false; caught.retryCleanup()
  assert.deepEqual(gate.status().writers, [])
}))
