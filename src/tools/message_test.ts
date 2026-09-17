import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import type { ExecutionContext } from './context.ts'
import type { DeliveryReceipt, SessionInput } from '../sessions/input.ts'
import { EventService } from '../events/service.ts'
import { EventSubscribeTool } from './event-subscribe.ts'
import { MessageTool } from './message.ts'
import { SessionTools, Tools } from './registry.ts'

function context(): ExecutionContext {
  return {
    sessionId: 'web:source', physicalSessionId: 'source.0',
    channel: 'discord', chatId: 'reply-address', senderId: 'fixture',
    messageId: 'causal-input', senderName: 'Agent',
    signal: new AbortController().signal,
    tools: new SessionTools(new Tools('.'), '.'),
  }
}

test('message tool awaits acceptance before displaying one session-origin message', async () => {
  const bus = new Bus()
  const displayed: OutboundMessage[] = []
  bus.on('message.outbound', (message) => { displayed.push(message) })
  const accepted = Promise.withResolvers<DeliveryReceipt>()
  let delivered: SessionInput | undefined
  const tool = new MessageTool(bus, () => true, () => undefined, () => [], (sessionId, input) => {
    assert.equal(sessionId, 'web:target')
    delivered = input
    return accepted.promise
  })
  const result = tool.execute({ sessionId: 'web:target', content: 'task' }, context())
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(displayed.length, 0)
  assert(delivered?.kind === 'message')
  assert.equal(delivered.policy, 'queue')
  assert.deepEqual(delivered.source, {
    kind: 'session', sessionId: 'web:source', inputId: 'causal-input', senderName: 'Agent',
  })
  accepted.resolve({ status: 'accepted', sessionId: 'web:target', inputId: delivered.id })
  assert.match(await result, /Message sent to web:target/)
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0].chatId, 'target')
  assert.equal(displayed[0].content, 'task')
  assert.equal(displayed[0].done, false)
})

test('message projection carries the target bot address rather than the source or a platform-only address', async () => {
  const bus = new Bus()
  const displayed: OutboundMessage[] = []
  bus.on('message.outbound', message => { displayed.push(message) })
  const tool = new MessageTool(bus, () => true, () => undefined, () => [], async (sessionId, input) =>
    ({ status: 'accepted', sessionId, inputId: input.id }))
  for (const botInstanceId of ['bot-a', 'bot-b']) {
    const address = { projectId: 'org', botInstanceId, platform: 'discord', conversationId: 'same-chat' }
    await tool.execute({ sessionId: channelSessionId(address), content: 'Hello' }, { ...context(), projectId: 'org' })
    assert.deepEqual(displayed.at(-1)?.channelAddress, address)
    assert.equal(displayed.at(-1)?.channel, 'discord')
    assert.equal(displayed.at(-1)?.chatId, 'same-chat')
  }
})

test('rejected cross-session delivery never produces a sent projection', async () => {
  const bus = new Bus()
  let displays = 0
  bus.on('message.outbound', () => { displays++ })
  const tool = new MessageTool(bus, () => true, () => undefined, () => [], async () => {
    throw new Error('target unavailable')
  })
  await assert.rejects(tool.execute({ sessionId: 'web:target', content: 'task' }, context()), /target unavailable/)
  assert.equal(displays, 0)
})

test('initial ephemeral task reserves admission before a concurrent message-tool follow-up', async () => {
  const bus = new Bus()
  const accepted = Promise.withResolvers<DeliveryReceipt>()
  let available = true
  let deliveries = 0
  let firstInputId = ''
  const tool = new MessageTool(bus, () => available, () => undefined, () => [], (_sessionId, input) => {
    available = false
    deliveries++
    firstInputId = input.id
    return accepted.promise
  })
  const first = tool.execute({ sessionId: 'web:ephemeral', content: 'initial task' }, context())
  assert.match(
    await tool.execute({ sessionId: 'web:ephemeral', content: 'follow-up' }, context()),
    /ephemeral/i,
  )
  assert.equal(deliveries, 1)
  accepted.resolve({ status: 'accepted', sessionId: 'web:ephemeral', inputId: firstInputId })
  assert.match(await first, /Message sent/)
  assert.match(
    await tool.execute({ sessionId: 'web:ephemeral', content: 'later follow-up' }, context()),
    /ephemeral/i,
  )
  assert.equal(deliveries, 1)
})

test('message tool preserves silent policy and refuses self or another parent child', async () => {
  const bus = new Bus()
  const inputs: SessionInput[] = []
  const tool = new MessageTool(
    bus, () => true, (id) => id === 'web:owned' ? { id: 'web:other' } : undefined,
    () => [], async (sessionId, input) => {
      inputs.push(input)
      return { status: 'accepted', sessionId, inputId: input.id }
    },
  )
  assert.match(await tool.execute({ sessionId: 'web:source', content: 'task' }, context()), /current session/)
  assert.match(await tool.execute({ sessionId: 'web:owned', content: 'task' }, context()), /another session/)
  assert.equal(inputs.length, 0)
  await tool.execute({ sessionId: 'web:target', content: 'record', silent: true }, context())
  assert(inputs[0].kind === 'message')
  assert.equal(inputs[0].policy, 'silent')
})

test('message routes to actual parent and same-owner siblings, but never across unrelated owners', async () => {
  const bus = new Bus()
  const parents: Record<string, { id: string }> = {
    'web:source': { id: 'web:parent' }, 'web:parent': { id: 'web:grandparent' },
    'web:sibling': { id: 'web:parent' }, 'web:foreign': { id: 'web:other' },
  }
  const delivered: string[] = []
  const tool = new MessageTool(bus, () => true, id => parents[id], () => [], async (sessionId, input) => {
    delivered.push(sessionId)
    return { status: 'accepted', sessionId, inputId: input.id }
  })
  assert.match(await tool.execute({ sessionId: 'web:parent', content: 'Parent' }, context()), /Message sent/)
  assert.match(await tool.execute({ sessionId: 'web:sibling', content: 'Sibling' }, context()), /Message sent/)
  assert.match(await tool.execute({ sessionId: 'web:foreign', content: 'Foreign' }, context()), /another session/)
  assert.deepEqual(delivered, ['web:parent', 'web:sibling'])
})

test('task target admission guard blocks delivery and outbound projection', async () => {
  const bus = new Bus()
  let projections = 0
  bus.on('message.outbound', () => { projections++ })
  const tool = new MessageTool(bus, () => true, () => undefined, () => [], async () => {
    throw new Error('Should not deliver')
  }, () => false)
  assert.match(await tool.execute({ sessionId: 'web:parent', content: 'Follow-up work' }, context()), /task executions do not admit messages/)
  assert.equal(projections, 0)
})

test('event tool awaits directed acceptance and preserves session causality', async () => {
  let observed: SessionInput | undefined
  const gate = Promise.withResolvers<void>()
  const events = new EventService('.', new Bus(), async (sessionId, input) => {
    assert.equal(sessionId, 'web:source')
    observed = input
    await gate.promise
    return { status: 'accepted', sessionId, inputId: input.id }
  })
  const tool = new EventSubscribeTool(events)
  let returned = false
  const result = tool.execute({
    action: 'emit', event: 'custom-result', content: 'result',
    meta_json: JSON.stringify({ urgency: 'steering' }),
  }, context()).then((value) => { returned = true; return value })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(returned, false)
  assert(observed?.kind === 'message' && observed.source.kind === 'event')
  assert.equal(observed.policy, 'queue')
  assert.equal(observed.source.origin?.sessionId, 'web:source')
  assert.equal(observed.source.origin?.inputId, 'causal-input')
  gate.resolve()
  assert.match(await result, /Emitted event custom-result/)

  const failing = new EventSubscribeTool(new EventService('.', new Bus(), async () => {
    throw new Error('Event target unavailable')
  }))
  await assert.rejects(
    failing.execute({ action: 'emit', event: 'custom-result', content: 'result' }, context()),
    /Event target unavailable/,
  )
})
