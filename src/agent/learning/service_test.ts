import assert from 'node:assert/strict'
import test from 'node:test'
import { Bus } from '../../bus/bus.ts'
import { createProjectScope, getProjectScope } from '../../projects/scope.ts'
import { LearningService } from './service.ts'
import type { SessionInput } from '../../sessions/input.ts'
import { CronService } from '../../cron/service.ts'
import { LearningLedger } from './ledger.ts'
import { LearningRunError } from './pipelines.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

const config = { reflectIntervalMs: 10, encapsulateIntervalMs: 20, soulIntervalMs: 30 }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const input: SessionInput = {
  kind: 'message', id: 'same-input', timestamp: '2026-09-15T00:00:00Z',
  content: 'same-content', policy: 'queue', source: { kind: 'session', sessionId: 'same-source' },
}

test('domain-local pending work feeds the existing scheduler without sharing Project cursors', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  await withTempWorkspace(async workspace => {
    const scope = createProjectScope('a')
    const bus = new Bus()
    const ledger = new LearningLedger(workspace, 'a')
    const manual: boolean[] = []
    let downstream = 2
    let runs = 0
    const service = new LearningService(bus, scope, {
      async reflector(_signal, _job, _accepted, requested) { manual.push(!!requested); return false },
      async encapsulator() { downstream--; runs++; return false },
      async soulReflector() { return false },
    }, config, new CronService(workspace, 'UTC', scope), () => false, ledger, {
      pending: pipeline => pipeline === 'encapsulator' && downstream > 0,
    })
    try {
      await service.trigger('reflector')
      assert.deepEqual(manual, [true])
      assert.equal(service.status().pipelines.encapsulator.pending, true)
      t.mock.timers.tick(20); await tick()
      assert.equal(runs, 1)
      assert.equal(service.status().pipelines.encapsulator.pending, true)
      t.mock.timers.tick(20); await tick()
      assert.equal(runs, 2)
      assert.equal(service.status().pipelines.encapsulator.pending, false)
      assert.equal(ledger.eventsFor('encapsulator').length, 0)
    } finally { await service.stop(); scope.close() }
  })
})

test('learning buffers and timers are org-local, preserve pending work across interval updates and report dispatch truthfully', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const buses = [new Bus(), new Bus()]
  const scopes = [createProjectScope('a'), createProjectScope('b')]
  const calls: string[][] = [[], []]
  const services = scopes.map((scope, i) => new LearningService(buses[i], scope, {
    async reflector() { assert.equal(getProjectScope(), scope); calls[i].push('reflector'); return true },
    async encapsulator() { assert.equal(getProjectScope(), scope); calls[i].push('encapsulator'); return 'accepted-session' },
    async soulReflector() { assert.equal(getProjectScope(), scope); calls[i].push('soulReflector'); return 'accepted-session' },
  }, config, new CronService('.', 'UTC', scope)))
  try {
    buses[0].emit('session.input.accepted', { sessionId: 'same-session', input })
    services[0].update({ ...config, reflectIntervalMs: 15 })
    assert.equal(services[0].status().pipelines.reflector.pending, true)
    t.mock.timers.tick(10)
    await tick()
    assert.deepEqual(calls, [[], []])
    t.mock.timers.tick(5)
    await tick()
    assert.deepEqual(calls, [['reflector'], []])
    assert(services[0].status().pipelines.reflector.lastDispatchedAt)
    assert.equal(services[1].status().pipelines.reflector.lastDispatchedAt, undefined)
    services[0].update({ ...config, enabled: false })
    buses[0].emit('session.ended', { sessionId: 'same-session', agentType: 'reflector' })
    buses[1].emit('session.ended', { sessionId: 'same-session', agentType: 'reflector' })
    t.mock.timers.tick(30)
    await tick()
    assert.deepEqual(calls, [['reflector'], []], 'ending a reflector alone must not enqueue downstream work')
    await services[1].trigger('encapsulator')
    await services[1].trigger('soulReflector')
    assert.deepEqual(calls, [['reflector'], ['encapsulator', 'soulReflector']])
    const snapshot = services[1].status()
    snapshot.pipelines.reflector.pending = true
    assert.equal(services[1].status().pipelines.reflector.pending, false)
    await services[0].stop()
    buses[1].emit('session.input.accepted', { sessionId: 'same-session', input })
    t.mock.timers.tick(10)
    await tick()
    assert.deepEqual(calls[1], ['encapsulator', 'soulReflector', 'reflector'])
    assert.throws(() => services[0].update(config), /stopped/)
  } finally {
    await Promise.all(services.map((service) => service.stop()))
    scopes.forEach((scope) => scope.close())
  }
})

test('learning disable and stop abort and drain dispatch without claiming agent completion', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const scope = createProjectScope('a')
  const bus = new Bus()
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const service = new LearningService(bus, scope, {
    async reflector(signal) { entered.resolve(signal); await release.promise },
    async encapsulator() {}, async soulReflector() {},
  }, config, new CronService('.', 'UTC', scope))
  bus.emit('session.input.accepted', { sessionId: 'same-session', input })
  t.mock.timers.tick(10)
  const signal = await entered.promise
  assert.equal(service.status().pipelines.reflector.dispatching, true)
  service.update({ ...config, enabled: false })
  assert.equal(signal.aborted, true)
  let stopped = false
  const stopping = service.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  release.resolve()
  await stopping
  assert.equal(service.status().pipelines.reflector.dispatching, false)
  assert.equal(service.status().pipelines.reflector.lastDispatchedAt, undefined)
  assert.equal(service.status().stopped, true)
  scope.close()
})

test('learning failed dispatch records an error and retains only its own retry buffer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  t.mock.method(console, 'error', () => {})
  const scope = createProjectScope('a')
  const bus = new Bus()
  const service = new LearningService(bus, scope, {
    async reflector() { throw new Error('fixture dispatch failure') },
    async encapsulator() {}, async soulReflector() {},
  }, config, new CronService('.', 'UTC', scope))
  try {
    bus.emit('session.input.accepted', { sessionId: 'same-session', input })
    t.mock.timers.tick(10)
    await tick()
    const status = service.status().pipelines.reflector
    assert.equal(status.lastError, 'fixture dispatch failure')
    assert.equal(status.pending, true)
    assert.equal(status.lastDispatchedAt, undefined)
    assert.throws(() => service.update({ ...config, reflectIntervalMs: 0 }), /positive timer interval/)
  } finally {
    await service.stop()
    scope.close()
  }
})

test('learning ignores internal activity and does not report a no-op watermark check as a dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const scope = createProjectScope('a')
  const bus = new Bus()
  let checks = 0
  const service = new LearningService(bus, scope, {
    async reflector() { checks++; return false },
    async encapsulator() {}, async soulReflector() {},
  }, config, new CronService('.', 'UTC', scope))
  try {
    for (const sessionId of ['sleep:same', 'heartbeat:same']) bus.emit('session.input.accepted', { sessionId, input })
    t.mock.timers.tick(10)
    await tick()
    assert.equal(checks, 0)
    bus.emit('session.input.accepted', { sessionId: 'same', input })
    t.mock.timers.tick(10)
    await tick()
    assert.equal(checks, 1)
    assert(service.status().pipelines.reflector.lastCheckedAt)
    assert.equal(service.status().pipelines.reflector.lastDispatchedAt, undefined)
    assert.equal(service.status().pipelines.reflector.pending, false)
  } finally {
    await service.stop()
    scope.close()
  }
})

test('recovery gates timers; retries back off across restart, pause after three failures and resume explicitly', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-02T00:00:00Z') })
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'info', () => {})
  await withTempWorkspace(async workspace => {
    const scope = createProjectScope('a')
    const ledger = new LearningLedger(workspace, 'a')
    const cron = new CronService(workspace, 'UTC', scope)
    let calls = 0
    let nonretryable = false
    let changed = 0
    const callbacks = { async reflector() {
      calls++
      throw new LearningRunError(nonretryable ? 'model_not_supported' : 'fetch failed', !nonretryable)
    }, async encapsulator() { return false }, async soulReflector() { return false } }
    const config = { reflectIntervalMs: 1000, encapsulateIntervalMs: 3600000, soulIntervalMs: 3600000 }
    let service = new LearningService(new Bus(), scope, callbacks, config, cron, undefined, ledger,
      { deferStart: true, changed: () => { changed++ } })
    try {
      assert.equal(cron.listJobs().length, 0)
      t.mock.timers.tick(1000)
      await tick()
      assert.equal(calls, 0)
      await assert.rejects(service.trigger('reflector'), /recovery/)
      service.start()
      await cron.runNow('learning:reflector')
      assert.equal(calls, 1)
      assert.equal(ledger.retry('reflector').notBefore, Date.now() + 60_000)
      assert(changed >= 2, 'persisted outcomes and status changes must invalidate clients')
      await service.stop()
      service = new LearningService(new Bus(), scope, callbacks, config, cron, undefined, new LearningLedger(workspace, 'a'))
      await cron.runNow('learning:reflector')
      assert.equal(calls, 1)
      t.mock.timers.tick(60_000)
      await tick()
      assert.equal(calls, 2)
      t.mock.timers.tick(120_000)
      await tick()
      assert.equal(calls, 3)
      assert(service.status().pipelines.reflector.paused)
      await service.stop()
      service = new LearningService(new Bus(), scope, callbacks, config, cron, undefined, new LearningLedger(workspace, 'a'))
      await cron.runNow('learning:reflector')
      assert.equal(calls, 3)
      nonretryable = true
      await assert.rejects(service.trigger('reflector'), /model_not_supported/)
      assert.equal(calls, 4)
      assert(service.status().pipelines.reflector.paused)
    } finally { await service.stop(); scope.close() }
  })
})

test('per-item automatic preferences are independent, survive the master switch, and retain manual override', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const scope = createProjectScope('preferences')
  const cron = new CronService('.', 'UTC', scope)
  const calls: string[] = []
  const service = new LearningService(new Bus(), scope, {
    async reflector() { calls.push('reflector'); return true },
    async encapsulator() { calls.push('encapsulator'); return true },
    async soulReflector() { calls.push('soulReflector'); return true },
  }, config, cron)
  const preferences = { ...config, pipelines: { reflector: false } }
  try {
    service.update(config)
    service.update(preferences)
    t.mock.timers.tick(30); await tick()
    assert.deepEqual(calls, ['encapsulator', 'soulReflector'])
    service.update({ ...preferences, enabled: false })
    t.mock.timers.tick(60); await tick()
    assert.equal(calls.length, 2)
    service.update({ ...preferences, enabled: true })
    assert.equal(cron.listJobs().find(job => job.id === 'learning:reflector')!.enabled, false)
    t.mock.timers.tick(30); await tick()
    assert.deepEqual(calls, ['encapsulator', 'soulReflector', 'encapsulator', 'soulReflector'])
    service.update({ ...preferences, pipelines: { reflector: true } })
    t.mock.timers.tick(10); await tick()
    assert.equal(calls.at(-1), 'reflector')
    service.update({ ...preferences, enabled: false })
    await service.trigger('reflector')
    assert.equal(calls.at(-1), 'reflector')
  } finally { await service.stop(); await cron.stop(); scope.close() }
})
