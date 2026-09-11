import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Bus, type BusObserverError } from './bus.ts'
import type { OutboundMessage } from './events.ts'

function internals(bus: Bus) {
  return bus as unknown as {
    consumeBuffers: Map<string, unknown[]>
    consumeWaiters: Map<string, unknown[]>
    pollHandlers: Map<string, {
      buffer: unknown[] | null
      agg: { acc: unknown; dirty: boolean } | null
    }>
  }
}

test('observer-only and unobserved topics never allocate consume buffers', (t) => {
  const bus = new Bus()
  t.after(() => bus.stopAll())
  let seen = 0
  bus.on('notification', () => { seen++ })
  const pollId = bus.poll('notification', { intervalMs: 60_000 }, () => {})
  for (let i = 0; i < 10_000; i++) {
    bus.emit('notification', i)
    bus.emit(`unobserved.${i}`, i)
  }
  assert.equal(seen, 10_000)
  assert.equal(internals(bus).consumeBuffers.size, 0)
  assert.equal(internals(bus).consumeWaiters.size, 0)
  assert.equal(internals(bus).pollHandlers.get(pollId)?.buffer?.length, 200)
  bus.off(pollId)
  assert.equal(internals(bus).pollHandlers.size, 0)
})

test('declared outbound queues retain every message before first consume in FIFO order', async () => {
  const bus = new Bus()
  bus.declareQueue('message.outbound')
  const messages: OutboundMessage[] = Array.from({ length: 350 }, (_, i) => ({
    channel: 'web', chatId: 'chat', event: 'response', content: `${i}`, done: true,
  }))
  for (const message of messages) {
    bus.emit('message.outbound', message)
    bus.declareQueue('message.outbound')
  }
  const received = await Promise.all(messages.map(() => bus.consume('message.outbound')))
  assert.deepEqual(received, messages)
  assert.equal(internals(bus).consumeBuffers.get('message.outbound')?.length, 0)
  assert.equal(internals(bus).consumeWaiters.size, 0)
})

test('undeclared consume rejects visibly without registering a queue', async () => {
  const bus = new Bus()
  bus.emit('notification', 'not retained')
  await assert.rejects(bus.consume('notification'), /undeclared queue.*declareQueue/)
  assert.equal(internals(bus).consumeBuffers.size, 0)
  assert.equal(internals(bus).consumeWaiters.size, 0)
})

test('hasQueued observes buffered work without allocating or counting in-flight messages', async () => {
  const bus = new Bus()
  assert.equal(bus.hasQueued('work'), false)
  assert.equal(internals(bus).consumeBuffers.size, 0)
  bus.declareQueue('work')
  assert.equal(bus.hasQueued('work'), false)
  bus.emit('work', 1)
  bus.emit('work', 2)
  assert.equal(bus.hasQueued('work'), true)
  assert.equal(await bus.consume('work'), 1)
  assert.equal(bus.hasQueued('work'), true)
  const inFlight = bus.consume('work')
  assert.equal(bus.hasQueued('work'), false)
  assert.equal(await inFlight, 2)
  const waiting = bus.consume('work')
  bus.emit('work', 3)
  assert.equal(bus.hasQueued('work'), false)
  assert.equal(await waiting, 3)
})

test('reentrant observers cannot reorder queued work', async () => {
  const bus = new Bus()
  bus.declareQueue('work')
  bus.on('work', (value) => {
    if (value === 1) bus.emit('work', 2)
  })
  bus.emit('work', 1)
  assert.deepEqual(await Promise.all([bus.consume('work'), bus.consume('work')]), [1, 2])
})

test('waiting consumers receive one event each in FIFO order and remove abort listeners', async () => {
  const bus = new Bus()
  bus.declareQueue('work')
  const controllers = [new AbortController(), new AbortController()]
  const pending = controllers.map(({ signal }) => bus.consume('work', { signal }))
  bus.emit('work', 1)
  bus.emit('work', 2)
  assert.deepEqual(await Promise.all(pending), [1, 2])
  assert.equal(internals(bus).consumeWaiters.size, 0)
  for (const { signal } of controllers) {
    assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
})

test('aborted consumes leave queued messages and other consumers intact', async () => {
  const bus = new Bus()
  bus.declareQueue('work')
  bus.emit('work', 'buffered')
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(bus.consume('work', { signal: cancelled.signal }), { name: 'AbortError' })
  assert.equal(await bus.consume('work'), 'buffered')

  const controller = new AbortController()
  const rejected = assert.rejects(
    bus.consume('work', { signal: controller.signal }),
    { name: 'AbortError' },
  )
  const next = bus.consume('work')
  controller.abort()
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  bus.emit('work', 'next')
  await rejected
  assert.equal(await next, 'next')
  assert.equal(internals(bus).consumeWaiters.size, 0)
})

test('stopAll cancels waits and polls but preserves queued messages and declarations', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const bus = new Bus()
  for (const topic of ['waiting.a', 'waiting.b', 'buffered']) bus.declareQueue(topic)
  const controllers = [new AbortController(), new AbortController()]
  const rejections = controllers.map((controller, index) => assert.rejects(
    bus.consume(index === 0 ? 'waiting.a' : 'waiting.b', { signal: controller.signal }),
    { name: 'AbortError' },
  ))
  bus.emit('buffered', 1)
  bus.emit('buffered', 2)
  let polled = 0
  let observed = 0
  bus.poll('buffered', { intervalMs: 10 }, () => { polled++ })
  bus.on('buffered', () => { observed++ })
  bus.emit('buffered', 3)

  bus.stopAll()
  bus.stopAll()
  await Promise.all(rejections)
  assert.equal(internals(bus).consumeWaiters.size, 0)
  assert.equal(internals(bus).consumeBuffers.size, 3)
  assert.equal(internals(bus).pollHandlers.size, 0)
  for (const { signal } of controllers) {
    assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
  t.mock.timers.tick(10)
  assert.equal(polled, 0)
  assert.deepEqual(
    await Promise.all([bus.consume('buffered'), bus.consume('buffered'), bus.consume('buffered')]),
    [1, 2, 3],
  )
  const resumed = bus.consume('waiting.a')
  bus.emit('waiting.a', 'resumed')
  assert.equal(await resumed, 'resumed')
  bus.emit('buffered', 4)
  assert.equal(await bus.consume('buffered'), 4)
  assert.equal(observed, 2)
})

test('sync and async on failures are observable without changing emit or queue delivery', async () => {
  const failures: BusObserverError[] = []
  const bus = new Bus({ onError: (failure) => { failures.push(failure) } })
  bus.declareQueue('work')
  const syncError = new Error('sync observer')
  const asyncError = new Error('async observer')
  const syncId = bus.on('work', () => { throw syncError })
  const asyncId = bus.on('work', async () => { throw asyncError })
  let healthy = 0
  bus.on('work', () => { healthy++ })

  assert.equal(bus.emit('work', 42), undefined)
  assert.equal(healthy, 1)
  assert.equal(await bus.consume('work'), 42)
  await setImmediate()
  assert.deepEqual(failures, [
    { topic: 'work', subscriptionId: syncId, phase: 'on', error: syncError },
    { topic: 'work', subscriptionId: asyncId, phase: 'on', error: asyncError },
  ])
})

test('sync and async poll handler failures are reported and do not repeat drained events', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const failures: BusObserverError[] = []
  const bus = new Bus({ onError: (failure) => { failures.push(failure) } })
  t.after(() => bus.stopAll())
  const syncError = new Error('sync poll')
  const asyncError = new Error('async poll')
  const bufferedId = bus.poll('notification', { intervalMs: 10 }, () => { throw syncError })
  const foldedId = bus.poll<'notification', number>('notification', {
    intervalMs: 10, init: () => 0, reduce: (acc) => acc + 1,
  }, async () => { throw asyncError })
  bus.emit('notification', 1)
  t.mock.timers.tick(10)
  await setImmediate()
  assert.deepEqual(failures, [
    { topic: 'notification', subscriptionId: bufferedId, phase: 'poll', error: syncError },
    { topic: 'notification', subscriptionId: foldedId, phase: 'poll', error: asyncError },
  ])
  t.mock.timers.tick(10)
  await setImmediate()
  assert.equal(failures.length, 2)
})

test('polling retains the latest 200 events while folds count all events and reset', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const bus = new Bus()
  t.after(() => bus.stopAll())
  const batches: unknown[][] = []
  const counts: number[] = []
  bus.poll('notification', { intervalMs: 10 }, (events) => { batches.push(events) })
  const foldId = bus.poll<'notification', number>('notification', {
    intervalMs: 10, init: () => 0, reduce: (acc) => acc + 1,
  }, (count) => { counts.push(count) })
  for (let i = 0; i < 500; i++) bus.emit('notification', i)
  assert.equal(internals(bus).pollHandlers.get(foldId)?.buffer, null)
  assert.equal(internals(bus).pollHandlers.get(foldId)?.agg?.acc, 500)
  t.mock.timers.tick(10)
  assert.deepEqual(batches, [Array.from({ length: 200 }, (_, i) => i + 300)])
  assert.deepEqual(counts, [500])
  t.mock.timers.tick(10)
  assert.equal(batches.length, 1)
  assert.equal(counts.length, 1)
  bus.emit('notification', 500)
  t.mock.timers.tick(10)
  assert.deepEqual(batches[1], [500])
  assert.deepEqual(counts, [500, 1])
  bus.off(foldId)
  bus.emit('notification', 501)
  t.mock.timers.tick(10)
  assert.deepEqual(counts, [500, 1])
})

test('fold reducer and reset failures are reported without preventing queue delivery', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const failures: BusObserverError[] = []
  const bus = new Bus({ onError: (failure) => { failures.push(failure) } })
  t.after(() => bus.stopAll())
  bus.declareQueue('work')
  const reduceError = new Error('reduce failed')
  const initError = new Error('reset failed')
  const counts: number[] = []
  let resetFails = false
  bus.poll<'work', number>('work', {
    intervalMs: 10,
    init: () => {
      if (resetFails) throw initError
      return 0
    },
    reduce: (acc, value) => {
      if (value === 'bad') throw reduceError
      return acc + 1
    },
  }, (count) => { counts.push(count) })
  bus.emit('work', 'bad')
  bus.emit('work', 'good')
  resetFails = true
  t.mock.timers.tick(10)
  assert.deepEqual(counts, [])
  resetFails = false
  t.mock.timers.tick(10)
  assert.deepEqual(counts, [1])
  assert.deepEqual(failures.map(({ phase, error }) => ({ phase, error })), [
    { phase: 'poll.reduce', error: reduceError },
    { phase: 'poll.init', error: initError },
  ])
  assert.deepEqual(await Promise.all([bus.consume('work'), bus.consume('work')]), ['bad', 'good'])
})

test('default reporting and failing custom reporters fall back to console.error', async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const observerError = new Error('observer failed')
  const reporterError = new Error('reporter failed')
  const buses = [
    new Bus(),
    new Bus({ onError: () => { throw reporterError } }),
    new Bus({ onError: async () => { throw reporterError } }),
  ]
  for (const bus of buses) {
    bus.on('notification', async () => { throw observerError })
    bus.emit('notification', 1)
  }
  await setImmediate()
  assert.equal(errors.length, 3)
  assert.equal(errors[0][1], observerError)
  assert.equal(errors[1][1], reporterError)
  assert.equal(errors[2][1], reporterError)
})
