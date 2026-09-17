import assert from 'node:assert/strict'
import test from 'node:test'
import { Bus } from '../../bus/bus.ts'
import { createProjectScope, getProjectScope } from '../../projects/scope.ts'
import { LearningService } from './service.ts'
import type { SessionInput } from '../../sessions/input.ts'
import { CronService } from '../../cron/service.ts'

const config = { reflectIntervalMs: 10, encapsulateIntervalMs: 20, soulIntervalMs: 30 }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const input: SessionInput = {
  kind: 'message', id: 'same-input', timestamp: '2026-09-15T00:00:00Z',
  content: 'same-content', policy: 'queue', source: { kind: 'session', sessionId: 'same-source' },
}

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
