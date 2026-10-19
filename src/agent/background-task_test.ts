import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import type { SessionTurnFact, SessionInput } from '../sessions/input.ts'
import { BackgroundTaskManager, backgroundExecutionId, backgroundTaskId } from './background-task.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const fact: SessionTurnFact = {
  sessionId: 'virtual:child', turnId: 'turn', inputId: 'original-input',
  source: { kind: 'session', sessionId: 'web:parent' },
  status: 'completed', content: 'Actual final answer',
}

test('background display callbacks retain exact source bot from explicit replies and encoded session IDs', async (t) => {
  const scope = createProjectScope('org')
  const bus = new Bus()
  const displays: OutboundMessage[] = []
  const events = new EventService('.', bus, async (sessionId, input) => ({
    status: 'accepted', sessionId, inputId: input.id,
  }), scope)
  const tasks = new BackgroundTaskManager(bus, events, scope)
  bus.on('message.outbound', (message) => {
    assert.equal(getProjectScope(), scope)
    displays.push(message)
  })
  const addresses = ['first-bot', 'second-bot'].map((botInstanceId) => ({
    projectId: 'org', botInstanceId, platform: 'qq', conversationId: 'same-chat',
  }))
  try {
    for (const explicit of [true, false]) {
      const before = displays.length
      for (const address of addresses) {
        tasks.createDeferredTask({
          kind: 'process', title: 'same-task',
          callback: explicit
            ? { sessionId: 'same-session', replyTo: { channel: 'qq', chatId: 'same-chat', channelAddress: address } }
            : { sessionId: channelSessionId(address) },
        }).complete('result')
      }
      await t.waitFor(() => assert.equal(displays.length, before + addresses.length))
      assert.deepEqual(displays.slice(before).map((message) => message.channelAddress), addresses)
      for (const message of displays.slice(before)) {
        assert.equal(message.channel, 'qq')
        assert.equal(message.chatId, 'same-chat')
      }
    }
  } finally {
    await tasks.stop()
    await events.stop()
    bus.stopAll()
    scope.close()
  }
})

test('web background completion and failure emit only structured events, including explicit reply addresses', async t => {
  const deliveries: SessionInput[] = []
  const displays: OutboundMessage[] = []
  const bus = new Bus()
  const events = new EventService('.', bus, async (sessionId, input) => {
    deliveries.push(input)
    return { status: 'accepted', sessionId, inputId: input.id }
  })
  const manager = new BackgroundTaskManager(bus, events)
  bus.on('message.outbound', message => { displays.push(message) })
  t.after(async () => { await manager.stop(); await events.stop(); bus.stopAll() })
  for (const explicit of [false, true]) {
    for (const failed of [false, true]) {
      const task = manager.createDeferredTask({
        kind: 'process', title: 'Web callback',
        callback: {
          sessionId: 'web:target',
          ...(explicit ? { replyTo: { channel: 'web', chatId: 'target' } } : {}),
        },
      })
      if (failed) task.fail(new Error('process failed'))
      else task.complete('process result')
    }
  }
  await tick()
  assert.equal(deliveries.length, 4)
  assert.equal(displays.length, 0)
  for (const input of deliveries) {
    assert(input.kind === 'message' && input.source.kind === 'event')
    assert.equal(input.source.type, 'background-task-complete')
    assert.ok(input.source.attributes?.['task-id'])
  }
})

test('background session tasks finish once from domain lifecycle, not display done', async () => {
  const bus = new Bus()
  const events = new EventService('.', bus, async (sessionId, input) => ({
    status: 'accepted', sessionId, inputId: input.id,
  }))
  const tasks = new BackgroundTaskManager(bus, events)
  const deferred = tasks.createDeferredTask({
    kind: 'subagent', title: 'fixture', tags: { sessionId: fact.sessionId },
  })
  bus.emit('message.outbound', {
    channel: 'virtual', chatId: 'child', event: 'response', done: true, content: 'Display only',
  })
  assert.equal(tasks.listTasks()[0].status, 'running')
  bus.emit('session.turn.finished', fact)
  bus.emit('session.turn.finished', { ...fact, content: 'duplicate notification' })
  assert.match(await tasks.awaitTask(deferred.taskId), /Actual final answer/)
  assert.doesNotMatch(await tasks.awaitTask(deferred.taskId), /Display only|duplicate notification/)

  const failed = tasks.createDeferredTask({
    kind: 'subagent', title: 'failed fixture', tags: { sessionId: 'virtual:failed' },
  })
  bus.emit('session.turn.finished', {
    ...fact, sessionId: 'virtual:failed', status: 'failed', error: 'provider unavailable', content: '',
  })
  assert.match(await tasks.awaitTask(failed.taskId), /Status: failed[\s\S]*provider unavailable/)
})

test('background callback targets a session and retains task/input causality with explicit queue', async () => {
  const bus = new Bus()
  const inputs: SessionInput[] = []
  const accept = Promise.withResolvers<void>()
  const events = new EventService('.', bus, async (sessionId, input) => {
    assert.equal(sessionId, 'web:target')
    inputs.push(input)
    await accept.promise
    return { status: 'accepted', sessionId, inputId: input.id }
  })
  const tasks = new BackgroundTaskManager(bus, events)
  let displays = 0
  bus.on('message.outbound', () => { displays++ })
  const task = tasks.createDeferredTask({
    kind: 'process', title: 'process fixture', sessionId: 'web:origin', inputId: 'cause',
    callback: { sessionId: 'web:target' },
  })
  task.complete('result')
  await tick()
  assert.equal(inputs.length, 1)
  assert.match(tasks.setContinuation(task.taskId, 'Late while delivery is pending'), /Continuation not changed/)
  await tick()
  assert.equal(inputs.length, 1)
  assert.equal(displays, 0)
  assert(inputs[0].kind === 'message')
  assert.equal(inputs[0].policy, 'queue')
  assert(inputs[0].source.kind === 'event')
  assert.equal(inputs[0].source.type, 'background-task-complete')
  assert.equal(inputs[0].source.origin?.sessionId, 'web:origin')
  assert.equal(inputs[0].source.origin?.inputId, 'cause')
  accept.resolve()
  await tick()
  assert.equal(displays, 0, 'Web completion is represented only by the structured session event')
  assert.equal(tasks.complete(task.taskId, 'duplicate'), false)
  assert.equal(inputs.length, 1)
  assert.match(tasks.setContinuation(task.taskId, 'Late after delivery'), /No completion event was replayed/)
  await tick()
  assert.equal(inputs.length, 1)
})

test('callback rejection is tracked without pretending a completed process itself failed', async (t) => {
  t.mock.method(console, 'error', () => {})
  const bus = new Bus()
  const events = new EventService('.', bus, async () => { throw new Error('target unavailable') })
  const tasks = new BackgroundTaskManager(bus, events)
  let displays = 0
  bus.on('message.outbound', () => { displays++ })
  const task = tasks.createDeferredTask({
    kind: 'process', title: 'fixture', sessionId: 'web:target', callback: { sessionId: 'web:target' },
  })
  task.complete('real process result')
  await tick()
  assert.equal(tasks.listTasks()[0].status, 'completed')
  assert.match(tasks.listTasks()[0].callbackError ?? '', /target unavailable|Event delivery failed/)
  assert.match(await tasks.getTaskOutput(task.taskId), /Callback delivery failed/)
  assert.equal(displays, 0)
  assert.match(tasks.setContinuation(task.taskId, 'Retry by accident'), /Continuation not changed/)
  await tick()
  assert.match(tasks.listTasks()[0].callbackError ?? '', /target unavailable|Event delivery failed/)
  assert.equal(displays, 0)
})

test('continuation annotates only running work, and late registration never revives a terminal task', async t => {
  const { tasks, owner, deliveries } = cancellationFixture(t)
  const task = tasks.createDeferredTask({
    kind: 'process', title: 'Annotation', sessionId: owner.sessionId, callback: { sessionId: owner.sessionId },
  })
  assert.match(tasks.setContinuation(task.taskId, 'Use this result for the approved next phase'), /Continuation set/)
  task.complete('result')
  await tick()
  assert.equal(deliveries.length, 1)
  assert.match(JSON.stringify(deliveries[0]), /approved next phase/)
  const silent = tasks.createDeferredTask({ kind: 'process', title: 'No callback', sessionId: owner.sessionId })
  silent.complete('saved')
  assert.match(tasks.setContinuation(silent.taskId, 'Do not create a new event'), /Continuation not changed/)
  await tick()
  assert.equal(deliveries.length, 1)
})

function cancellationFixture(t: TestContext) {
  const scope = createProjectScope('p')
  const bus = new Bus()
  const deliveries: SessionInput[] = []
  const events = new EventService('.', bus, async (sessionId, input) => {
    deliveries.push(input)
    return { status: 'accepted', sessionId, inputId: input.id }
  }, scope)
  const tasks = new BackgroundTaskManager(bus, events, scope)
  t.after(async () => {
    try { await tasks.stop(); await events.stop() }
    finally { bus.stopAll(); scope.close() }
  })
  return { tasks, deliveries, owner: { projectId: 'p', sessionId: 'web:owner' } }
}

test('cancellation waits for both cleanup and real execution, is idempotent, and does not send a completion callback', async t => {
  const { tasks, owner, deliveries } = cancellationFixture(t)
  const cleanup = Promise.withResolvers<void>()
  const execution = Promise.withResolvers<string>()
  let cancellations = 0
  const taskId = tasks.runPromiseTask({
    kind: 'tool', title: 'Slow cleanup', sessionId: owner.sessionId,
    callback: { sessionId: owner.sessionId },
    onCancel: () => { cancellations++; return cleanup.promise },
  }, execution.promise)
  assert.equal(backgroundTaskId(backgroundExecutionId(taskId)), taskId)
  assert.throws(() => backgroundTaskId(taskId), /bg:/)
  let returned = false
  const first = tasks.cancelTask(taskId, owner).then(status => { returned = true; return status })
  const second = tasks.cancelTask(taskId, owner)
  try {
    await tick()
    assert.equal(cancellations, 1)
    assert.equal(tasks.listTasks()[0].status, 'cancelling')
    assert.equal(tasks.hasRunningTasks, true)
    assert.match(await tasks.getTaskOutput(taskId), /Status: cancelling/)
    assert.throws(() => tasks.setContinuation(taskId, 'Do not wake'), /do not deliver/)
    cleanup.resolve()
    await tick()
    assert.equal(returned, false, 'Abort acknowledgement is not execution completion')
    execution.resolve('Final captured output')
    assert.deepEqual(await Promise.all([first, second]), ['cancelled', 'cancelled'])
    assert.match(await tasks.getTaskOutput(taskId), /Status: cancelled[\s\S]*Final captured output/)
    assert.equal(await tasks.cancelTask(taskId, owner), 'cancelled')
    assert.equal(tasks.complete(taskId, 'late result'), false)
    assert.equal(tasks.hasRunningTasks, false)
    assert.equal(deliveries.length, 0)
  } finally { cleanup.resolve(); execution.resolve('cleanup'); await first; await second }
})

test('background ownership is not callback routing, and unsupported cancellation leaves work running', async t => {
  const { tasks, owner } = cancellationFixture(t)
  const deferred = tasks.createDeferredTask({
    kind: 'process', title: 'Uncancellable', sessionId: owner.sessionId,
    callback: { sessionId: 'web:recipient' },
  })
  await assert.rejects(tasks.cancelTask(deferred.taskId, { ...owner, projectId: 'other' }), /owner/)
  await assert.rejects(tasks.cancelTask(deferred.taskId, { ...owner, sessionId: 'web:recipient' }), /owner/)
  await assert.rejects(tasks.cancelTask(deferred.taskId, owner), /no cancellation capability/)
  assert.equal(tasks.listTasks()[0].status, 'running')
  deferred.complete('Natural completion')
  assert.equal(await tasks.cancelTask(deferred.taskId, owner), 'completed')
})

test('failed cancellation is visible and retains a natural result that raced with cleanup', async t => {
  const { tasks, owner } = cancellationFixture(t)
  const fail = Promise.withResolvers<void>()
  const deferred = tasks.createDeferredTask({
    kind: 'process', title: 'Failed cleanup', sessionId: owner.sessionId,
    onCancel: () => fail.promise,
  })
  const rejected = assert.rejects(tasks.cancelTask(deferred.taskId, owner), /cleanup failed/)
  deferred.complete('Real completion')
  assert.equal(tasks.listTasks()[0].status, 'cancelling')
  fail.reject(new Error('cleanup failed'))
  await rejected
  assert.equal(tasks.listTasks()[0].status, 'completed')
  assert.match(await tasks.getTaskOutput(deferred.taskId), /Cancellation failed: cleanup failed[\s\S]*Real completion/)
  assert.equal(await tasks.cancelTask(deferred.taskId, owner), 'completed')
})

test('shutdown drains asynchronous cancellation instead of just rejecting the task receipt', async t => {
  const { tasks, owner } = cancellationFixture(t)
  const execution = Promise.withResolvers<string>()
  let aborted = false
  const taskId = tasks.runPromiseTask({
    kind: 'tool', title: 'Shutdown', sessionId: owner.sessionId,
    onCancel: () => { aborted = true },
  }, execution.promise)
  let stopped = false
  const stop = tasks.stop().then(() => { stopped = true })
  try {
    await tick()
    assert.equal(aborted, true)
    assert.equal(stopped, false)
    execution.reject(new Error('Aborted during shutdown'))
    await stop
    assert.equal(tasks.listTasks()[0].status, 'cancelled')
    assert.match(await tasks.getTaskOutput(taskId), /Status: cancelled/)
  } finally { execution.resolve('cleanup'); await stop }
})

test('a failed stop remains retryable and does not release active-work accounting', async t => {
  const { tasks, owner } = cancellationFixture(t)
  let attempts = 0
  const task = tasks.createDeferredTask({
    kind: 'tool', title: 'Retry cleanup', sessionId: owner.sessionId,
    onCancel: () => { if (++attempts === 1) throw new Error('Stop unavailable') },
  })
  await assert.rejects(tasks.cancelTask(task.taskId, owner), /Stop unavailable/)
  assert.equal(tasks.listTasks()[0].status, 'running')
  assert.equal(tasks.hasRunningTasks, true)
  assert.match(await tasks.getTaskOutput(task.taskId), /Cancellation failed: Stop unavailable/)
  assert.equal(await tasks.cancelTask(task.taskId, owner), 'cancelled')
  assert.equal(attempts, 2)
  assert.doesNotMatch(await tasks.getTaskOutput(task.taskId), /Cancellation failed/)
})
