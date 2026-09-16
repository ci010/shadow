import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import type { SessionTurnFact, SessionInput } from '../sessions/input.ts'
import { BackgroundTaskManager } from './background-task.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import { createOrganizationScope, getOrganizationScope } from '../organizations/scope.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const fact: SessionTurnFact = {
  sessionId: 'virtual:child', turnId: 'turn', inputId: 'original-input',
  source: { kind: 'session', sessionId: 'web:parent' },
  status: 'completed', content: 'Actual final answer',
}

test('background display callbacks retain exact source bot from explicit replies and encoded session IDs', async (t) => {
  const scope = createOrganizationScope('org')
  const bus = new Bus()
  const displays: OutboundMessage[] = []
  const events = new EventService('.', bus, async (sessionId, input) => ({
    status: 'accepted', sessionId, inputId: input.id,
  }), scope)
  const tasks = new BackgroundTaskManager(bus, events, scope)
  bus.on('message.outbound', (message) => {
    assert.equal(getOrganizationScope(), scope)
    displays.push(message)
  })
  const addresses = ['first-bot', 'second-bot'].map((botInstanceId) => ({
    organizationId: 'org', botInstanceId, platform: 'qq', conversationId: 'same-chat',
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
  assert.equal(displays, 0)
  assert(inputs[0].kind === 'message')
  assert.equal(inputs[0].policy, 'queue')
  assert(inputs[0].source.kind === 'event')
  assert.equal(inputs[0].source.type, 'background-task-complete')
  assert.equal(inputs[0].source.origin?.sessionId, 'web:origin')
  assert.equal(inputs[0].source.origin?.inputId, 'cause')
  accept.resolve()
  await tick()
  assert.equal(displays, 1)
  assert.equal(tasks.complete(task.taskId, 'duplicate'), false)
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
})
