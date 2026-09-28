import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import type { DeliverInput, EventInputSource, InputOrigin, SessionMessageInput } from '../sessions/input.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { EventService, eventToInput } from './service.ts'
import type { SystemEvent } from './types.ts'

const timestamp = '2026-09-11T00:00:00.000Z'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const accepted: DeliverInput = async (sessionId, input) => ({ status: 'accepted', sessionId, inputId: input.id })

async function setup(workspace: string, deliver: DeliverInput = accepted) {
  const bus = new Bus()
  const deliveries: { sessionId: string; input: SessionMessageInput & { source: EventInputSource } }[] = []
  const events = new EventService(workspace, bus, async (sessionId, input) => {
    assert(input.kind === 'message')
    assert(input.source.kind === 'event')
    deliveries.push({ sessionId, input: { ...input, source: input.source } })
    return deliver(sessionId, input)
  })
  await events.start()
  return { bus, events, deliveries }
}

function channelMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'discord',
    chatId: 'origin:thread',
    messageId: 'channel-input',
    platformMessageId: 'platform-input',
    senderId: 'user-1',
    senderName: 'Alice',
    chatName: 'Group chat',
    isGroup: true,
    admin: false,
    timestamp,
    content: 'hello subscribers',
    media: ['attachment.png'],
    ...overrides,
  }
}

function sessionOrigin(inputId: string): InputOrigin {
  return { sessionId: 'worker', inputId, source: { kind: 'session', sessionId: 'parent', senderName: 'Parent' } }
}

test('default and explicit queue become typed queue inputs with unique delivery IDs', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      await events.emit({ id: 'event-1', type: 'x', source: 'agent', content: 'hi', targetSessionId: 'opaque-session' })
      await events.emit({
        id: 'event-2', type: 'x', source: 'agent', targetSessionId: 'discord:a:b',
        delivery: { urgency: 'queue' },
      })
      assertEquals(deliveries.map((d) => d.sessionId), ['opaque-session', 'discord:a:b'])
      assertEquals(deliveries.map((d) => d.input.policy), ['queue', 'queue'])
      assertEquals(deliveries.map((d) => d.input.source.eventId), ['event-1', 'event-2'])
      assertEquals(deliveries[0].input.content, 'hi')
      assertEquals(deliveries[1].input.content, '')
      assert.notEqual(deliveries[0].input.id, 'event-1')
      assert.notEqual(deliveries[0].input.id, deliveries[1].input.id)
      assertEquals(deliveries[0].input.replyTo, undefined)
    } finally {
      await events.stop()
    }
  })
})

test('background results default to next-step while explicit and persisted delivery choices remain authoritative', async () => {
  await withTempWorkspace(async workspace => {
    const { events, deliveries } = await setup(workspace)
    try {
      const event = { type: 'background-task-complete', source: 'background-task', content: 'Full result', targetSessionId: 'owner' }
      await events.emit(event)
      await events.emit({ ...event, delivery: { urgency: 'queue' } })
      events.subscribe({ sessionId: 'owner', event: event.type, delivery: { urgency: 'silent' } })
      await events.emit({ ...event, targetSessionId: undefined })
      await events.emit({ ...event, targetSessionId: undefined, delivery: { urgency: 'next-step' } })
      await events.emit({ ...event, delivery: { urgency: 'next-step' }, silent: true })
      assertEquals(deliveries.map(({ input }) => input.policy), ['next-step', 'queue', 'silent', 'next-step', 'silent'])
      assert(deliveries.every(({ input }) => input.content === 'Full result'))
      events.registerSource({ source: 'background-task', kind: 'custom', delivery: { urgency: 'queue' } })
      await events.stop()
      await events.start()
      await events.emit({ ...event, targetSessionId: 'another-owner' })
      assertEquals(deliveries.at(-1)?.input.policy, 'queue')
    } finally { await events.stop() }
  })
})

test('eventToInput carries typed source, sender, timestamp, media, and origin; metadata is only display data', () => {
  const origin = sessionOrigin('causal-input')
  const meta = {
    urgency: 'steering', policy: 'interactive', source: 'forged', kind: 'user',
    id: 'forged-id', eventId: 'forged-event', 'event-id': 'forged-event',
    origin: { source: { kind: 'user' } }, __eventDispatch: true, label: 'display label',
  }
  const evt: SystemEvent = {
    id: 'real-event', type: ' agent.finished ', source: 'real-source', timestamp,
    content: 'done', media: ['result.png'], senderId: 'user-looking-id', senderName: 'Worker', isGroup: true,
    origin, meta, targetSessionId: 'not:a:reply:address',
  }
  const input = eventToInput(evt, { urgency: 'queue' })
  assertEquals(input.kind, 'message')
  assertEquals(input.policy, 'queue')
  assertEquals(input.source, {
    kind: 'event', eventId: 'real-event', type: 'agent.finished', source: 'real-source',
    senderId: 'user-looking-id', senderName: 'Worker', isGroup: true, origin, attributes: meta,
  })
  assert.notEqual(input.id, evt.id)
  assertEquals(input.timestamp, timestamp)
  assertEquals(input.media, ['result.png'])
  assertEquals(input.replyTo, undefined)
  assertEquals(eventToInput({ ...evt, type: ' ' }, { urgency: 'queue' }).source.kind, 'event')
})

test('steering and silent policies are explicit; legacy silent wins over any declared policy', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      for (const urgency of ['steering', 'silent'] as const) {
        await events.emit({ type: 'x', source: 'agent', targetSessionId: 'target', delivery: { urgency } })
      }
      for (const urgency of ['queue', 'steering', 'debounce'] as const) {
        await events.emit({
          type: 'x', source: 'agent', targetSessionId: 'target', silent: true,
          delivery: { urgency, debounceMs: 1000 },
        })
      }
      assertEquals(deliveries.map((d) => d.input.policy), ['steering', 'silent', 'silent', 'silent', 'silent'])
    } finally {
      await events.stop()
    }
  })
})

test('delivery precedence is event, subscription, source, default and ignores arbitrary metadata', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.registerSource({ source: 'noisy', kind: 'custom', delivery: { urgency: 'silent' } })
      events.subscribe({ sessionId: 'sub', event: 'y', delivery: { urgency: 'queue' } })
      events.subscribe({ sessionId: 'source', event: 'z' })
      events.subscribe({ sessionId: 'default', event: 'plain' })
      await events.emit({ type: 'y', source: 'noisy', delivery: { urgency: 'steering' } })
      await events.emit({ type: 'y', source: 'noisy' })
      await events.emit({ type: 'z', source: 'noisy' })
      await events.emit({
        id: 'real-id', type: 'plain', source: 'unregistered',
        meta: { urgency: 'steering', policy: 'interactive', source: 'noisy', id: 'fake', silent: true },
      })
      assertEquals(deliveries.map((d) => d.input.policy), ['steering', 'queue', 'silent', 'queue'])
      assertEquals(deliveries[3].input.source.eventId, 'real-id')
      assertEquals(deliveries[3].input.source.source, 'unregistered')
    } finally {
      await events.stop()
    }
  })
})

test('fanout respects exact/wildcard/source/channel/chat filters and deduplicates each target', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.subscribe({ sessionId: 'all', event: '*' })
      events.subscribe({ sessionId: 'all', event: 'tick', delivery: { urgency: 'silent' } })
      events.subscribe({ sessionId: 'exact', event: 'tick', source: 'agent', channel: 'web', chatId: 'room' })
      events.subscribe({ sessionId: 'wrong-type', event: 'other' })
      events.subscribe({ sessionId: 'wrong-source', event: 'tick', source: 'cron' })
      events.subscribe({ sessionId: 'wrong-channel', event: 'tick', channel: 'discord' })
      events.subscribe({ sessionId: 'wrong-chat', event: 'tick', chatId: 'other' })
      await events.emit({ id: 'fanout', type: 'tick', source: 'agent', channel: 'web', chatId: 'room' })
      assertEquals(deliveries.map((d) => d.sessionId), ['all', 'exact'])
      assertEquals(deliveries.map((d) => d.input.policy), ['queue', 'queue'])
      assertEquals(deliveries.map((d) => d.input.source.eventId), ['fanout', 'fanout'])
      assert.notEqual(deliveries[0].input.id, deliveries[1].input.id)
    } finally {
      await events.stop()
    }
  })
})

test('explicit target is delivered once and does not broadcast to other matching subscriptions', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.subscribe({ sessionId: 'target', event: '*', delivery: { urgency: 'silent' } })
      events.subscribe({ sessionId: 'target', event: 'tick' })
      events.subscribe({ sessionId: 'other', event: '*' })
      await events.emit({ type: 'tick', source: 'agent', targetSessionId: 'target' })
      assertEquals(deliveries.map((d) => d.sessionId), ['target'])
      assertEquals(deliveries[0].input.policy, 'queue')
    } finally {
      await events.stop()
    }
  })
})

test('debounce flushes explicit queue with latest payload and typed coalesced causal IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.subscribe({ sessionId: 'target', event: 'tick', delivery: { urgency: 'debounce', debounceMs: 30 } })
      for (let i = 1; i <= 3; i++) {
        await events.emit({
          id: `event-${i}`, type: 'tick', source: 'agent', content: `payload-${i}`,
          media: [`media-${i}`], timestamp, origin: sessionOrigin(`cause-${i}`),
          meta: { coalesced: 999, urgency: 'steering', label: `label-${i}` },
        })
        t.mock.timers.tick(10)
        assertEquals(deliveries.length, 0)
      }
      t.mock.timers.tick(20)
      assertEquals(deliveries.length, 1)
      const input = deliveries[0].input
      assertEquals(input.policy, 'queue')
      assertEquals(input.content, 'payload-3')
      assertEquals(input.media, ['media-3'])
      assertEquals(input.timestamp, timestamp)
      assertEquals(input.source.eventId, 'event-3')
      assertEquals(input.source.origin, sessionOrigin('cause-3'))
      assertEquals(input.source.coalesced, {
        count: 3,
        eventIds: ['event-1', 'event-2', 'event-3'],
        origins: [sessionOrigin('cause-1'), sessionOrigin('cause-2'), sessionOrigin('cause-3')],
      })
      assertEquals(input.source.attributes?.coalesced, 3)
      assertEquals(input.source.attributes?.label, 'label-3')
      assert(!['event-1', 'event-2', 'event-3'].includes(input.id))
    } finally {
      await events.stop()
    }
  })
})

test('debounce separates sessions and coalesce keys and resolves policy before buffering', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.registerSource({ source: 'clock', kind: 'custom', delivery: { urgency: 'debounce', debounceMs: 30 } })
      events.subscribe({ sessionId: 'one', event: '*' })
      events.subscribe({ sessionId: 'two', event: '*' })
      await events.emit({ id: 'a', type: 'first', source: 'clock' })
      await events.emit({ id: 'b', type: 'second', source: 'clock' })
      events.registerSource({ source: 'clock', kind: 'custom', delivery: { urgency: 'steering' } })
      t.mock.timers.tick(30)
      assertEquals(deliveries.map((d) => [d.sessionId, d.input.source.eventId]), [
        ['one', 'a'], ['two', 'a'], ['one', 'b'], ['two', 'b'],
      ])
      assert(deliveries.every((d) => d.input.policy === 'queue'))
      assert(deliveries.every((d) => d.input.source.coalesced?.count === 1))
    } finally {
      await events.stop()
    }
  })
})

test('explicit coalesce keys merge event types without colliding across session IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      await events.emit({
        id: 'first', type: 'first-type', source: 'agent', targetSessionId: 'one::two',
        delivery: { urgency: 'debounce', coalesceKey: 'three', debounceMs: 10 },
      })
      await events.emit({
        id: 'latest', type: 'second-type', source: 'agent', targetSessionId: 'one::two',
        delivery: { urgency: 'debounce', coalesceKey: 'three', debounceMs: 10 },
      })
      await events.emit({
        id: 'separate', type: 'first-type', source: 'agent', targetSessionId: 'one',
        delivery: { urgency: 'debounce', coalesceKey: 'two::three', debounceMs: 10 },
      })
      t.mock.timers.tick(10)
      assertEquals(deliveries.map((d) => [d.sessionId, d.input.source.eventId]), [
        ['one::two', 'latest'], ['one', 'separate'],
      ])
      assertEquals(deliveries[0].input.source.type, 'second-type')
      assertEquals(deliveries[0].input.source.coalesced?.eventIds, ['first', 'latest'])
      assertEquals(deliveries[1].input.source.coalesced?.eventIds, ['separate'])
    } finally {
      await events.stop()
    }
  })
})

test('no inbound Bus subscription or emission and no rebroadcast of accepted session inputs', async () => {
  await withTempWorkspace(async (workspace) => {
    const bus = new Bus()
    const observedSubscriptions: string[] = []
    const on = bus.on.bind(bus)
    bus.on = (topic, handler) => {
      observedSubscriptions.push(topic)
      return on(topic, handler)
    }
    let count = 0
    const events = new EventService(workspace, bus, async (sessionId, input) => {
      count++
      bus.emit('session.input.accepted', { sessionId, input })
      return accepted(sessionId, input)
    })
    await events.start()
    assertEquals(observedSubscriptions, [])
    const inbound: unknown[] = []
    const system: SystemEvent[] = []
    bus.on('message.inbound', (msg) => { inbound.push(msg) })
    bus.on('system.event', (evt) => { system.push(evt) })
    try {
      events.subscribe({ sessionId: 'target', event: '*' })
      bus.emit('message.inbound', channelMessage())
      bus.emit('message.inbound', channelMessage({ senderId: 'event:cron', eventMeta: { source: 'cron' } }))
      assertEquals(count, 0)
      assertEquals(system.length, 0)
      await events.emit({ type: 'tick', source: 'agent', senderId: 'ordinary-user' })
      assertEquals(count, 1)
      assertEquals(system.length, 1)
      assertEquals(inbound.length, 2)
    } finally {
      await events.stop()
    }
  })
})

test('emit waits for directed acceptance and propagates synchronous and asynchronous failures', async () => {
  await withTempWorkspace(async (workspace) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { events } = await setup(workspace, async (sessionId, input) => {
      await gate
      return accepted(sessionId, input)
    })
    let settled = false
    const pending = events.emit({ type: 'x', source: 'agent', targetSessionId: 'target' })
      .then(() => { settled = true })
    await Promise.resolve()
    assertEquals(settled, false)
    release()
    await pending
    assertEquals(settled, true)
    await events.stop()

    for (const isAsync of [false, true]) {
      const failure = new Error('rejected acceptance')
      const failing = new EventService(workspace, new Bus(), () => {
        if (isAsync) return Promise.reject(failure)
        throw failure
      })
      await failing.start()
      try {
        await assert.rejects(
          failing.emit({ type: 'x', source: 'agent', targetSessionId: 'target' }),
          (error) => error === failure,
        )
      } finally {
        await failing.stop()
      }
    }
  })
})

test('fanout awaits healthy targets even when another rejects and reports multiple failures', async () => {
  await withTempWorkspace(async (workspace) => {
    const failed = new Error('bad mailbox')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { events, deliveries } = await setup(workspace, async (sessionId, input) => {
      if (sessionId.startsWith('bad')) throw failed
      await gate
      return accepted(sessionId, input)
    })
    try {
      events.subscribe({ sessionId: 'bad-1', event: '*' })
      events.subscribe({ sessionId: 'good', event: '*' })
      let settled = false
      const pending = assert.rejects(events.emit({ type: 'x', source: 'agent' }), (error) => error === failed)
        .then(() => { settled = true })
      await Promise.resolve()
      assertEquals(settled, false)
      assertEquals(deliveries.map((d) => d.sessionId), ['bad-1', 'good'])
      release()
      await pending
      events.subscribe({ sessionId: 'bad-2', event: '*' })
      await assert.rejects(events.emit({ type: 'x', source: 'agent' }), (error) => {
        assert(error instanceof AggregateError)
        assertEquals(error.errors, [failed, failed])
        return true
      })
    } finally {
      await events.stop()
    }
  })
})

test('timed debounce failure reports target/event/input IDs without leaking errors or payloads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  await withTempWorkspace(async (workspace) => {
    for (const isAsync of [false, true]) {
      let inputId: string | undefined
      const events = new EventService(workspace, new Bus(), (_sessionId, input) => {
        inputId = input.id
        const error = new Error('secret-provider-token secret-payload')
        if (isAsync) return Promise.reject(error)
        throw error
      })
      await events.start()
      try {
        await events.emit({
          id: 'timer-event', type: 'tick', source: 'agent', targetSessionId: 'timer-target',
          content: 'secret-payload', delivery: { urgency: 'debounce', debounceMs: 10 },
        })
        t.mock.timers.tick(10)
        // Drain the async delivery rejection, which has no awaiting emit caller.
        await Promise.resolve()
        assertEquals(logs.pop(), ['[events] Debounced delivery failed', {
          targetSessionId: 'timer-target', eventId: 'timer-event', inputId,
        }])
        assert(inputId)
        assertEquals(logs.length, 0)
      } finally {
        await events.stop()
      }
    }
  })
})

test('stop clears debounce timers and rejects new event/channel publications; restart adds no listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries, bus } = await setup(workspace)
    const system: SystemEvent[] = []
    bus.on('system.event', (evt) => { system.push(evt) })
    await events.emit({
      type: 'tick', source: 'agent', targetSessionId: 'target',
      delivery: { urgency: 'debounce', debounceMs: 10 },
    })
    await events.stop()
    await events.stop()
    t.mock.timers.tick(50)
    assertEquals(deliveries.length, 0)
    await assert.rejects(events.emit({ type: 'x', source: 'agent', targetSessionId: 'target' }), /stopped/)
    await assert.rejects(events.publishChannelMessage(channelMessage()), /stopped/)
    assertEquals(system.length, 1)
    await events.start()
    await events.emit({ type: 'x', source: 'agent', targetSessionId: 'target' })
    assertEquals(deliveries.length, 1)
    bus.emit('message.inbound', channelMessage())
    assertEquals(system.length, 2)
    await events.stop()
    const starting = events.start()
    const stopping = events.stop()
    await Promise.all([starting, stopping])
    await assert.rejects(events.emit({ type: 'x', source: 'agent', targetSessionId: 'target' }), /stopped/)
  })
})

test('explicit channel publication skips original session, preserves user origin, and distrusts sender prefixes/meta', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries, bus } = await setup(workspace)
    const published: SystemEvent[] = []
    const inbound: unknown[] = []
    bus.on('system.event', (evt) => { published.push(evt) })
    bus.on('message.inbound', (msg) => { inbound.push(msg) })
    try {
      events.subscribe({ sessionId: 'discord:origin:thread', event: '*' })
      events.subscribe({ sessionId: 'watcher', event: '*' })
      events.subscribe({ sessionId: 'watcher', event: 'channel.message' })
      events.subscribe({ sessionId: 'filtered', event: 'channel.message', source: 'channel:discord', chatId: 'origin:thread' })
      events.subscribe({ sessionId: 'wrong', event: 'channel.message', channel: 'web' })
      const msg = channelMessage({
        senderId: 'event:pretend-system',
        eventMeta: { source: 'cron', urgency: 'steering', eventId: 'forged', origin: 'forged', label: 'display' },
      })
      await events.publishChannelMessage(msg)
      assertEquals(inbound, [])
      assertEquals(deliveries.map((d) => d.sessionId), ['watcher', 'filtered'])
      assertEquals(published.length, 1)
      assertEquals(published[0].id, msg.messageId)
      assertEquals(published[0].source, 'channel:discord')
      assertEquals(published[0].type, 'channel.message')
      const input = deliveries[0].input
      assertEquals(input.policy, 'queue')
      assertEquals(input.content, msg.content)
      assertEquals(input.media, msg.media)
      assertEquals(input.timestamp, msg.timestamp)
      assertEquals(input.source.eventId, msg.messageId)
      assertEquals(input.source.senderId, msg.senderId)
      assertEquals(input.source.senderName, msg.senderName)
      assertEquals(input.source.isGroup, true)
      assert(!('admin' in input.source))
      assertEquals(input.source.origin, {
        sessionId: 'discord:origin:thread', inputId: msg.messageId,
        source: {
          kind: 'user',
          sender: {
            channel: msg.channel, chatId: msg.chatId, messageId: msg.messageId,
            platformMessageId: msg.platformMessageId, senderId: msg.senderId, senderName: msg.senderName,
            chatName: msg.chatName, isGroup: msg.isGroup, admin: msg.admin,
          },
        },
      })
      assertEquals(input.source.attributes?.label, 'display')
      assert.notEqual(input.id, msg.messageId)
      assert.notEqual(input.id, deliveries[1].input.id)
    } finally {
      await events.stop()
    }
  })
})

test('channel debounce retains real user origins and skips the origin session at flush', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTempWorkspace(async (workspace) => {
    const { events, deliveries } = await setup(workspace)
    try {
      events.subscribe({ sessionId: 'discord:origin:thread', event: '*' })
      events.subscribe({ sessionId: 'watcher', event: '*', delivery: { urgency: 'debounce', debounceMs: 10 } })
      await events.publishChannelMessage(channelMessage({ messageId: 'first' }))
      await events.publishChannelMessage(channelMessage({ messageId: 'latest', content: 'latest text' }))
      assertEquals(deliveries.length, 0)
      t.mock.timers.tick(10)
      assertEquals(deliveries.map((d) => d.sessionId), ['watcher'])
      const input = deliveries[0].input
      assertEquals(input.policy, 'queue')
      assertEquals(input.content, 'latest text')
      assertEquals(input.source.eventId, 'latest')
      assertEquals(input.source.origin?.inputId, 'latest')
      assertEquals(input.source.coalesced?.eventIds, ['first', 'latest'])
      assertEquals(input.source.coalesced?.origins.map((origin) => [origin.inputId, origin.source.kind]), [
        ['first', 'user'], ['latest', 'user'],
      ])
    } finally {
      await events.stop()
    }
  })
})

test('channel publication surfaces subscription acceptance errors and honors silent channel inputs', async () => {
  await withTempWorkspace(async (workspace) => {
    const failure = new Error('watcher unavailable')
    const { events, deliveries } = await setup(workspace, async () => { throw failure })
    try {
      events.subscribe({ sessionId: 'watcher', event: '*', delivery: { urgency: 'steering' } })
      await assert.rejects(events.publishChannelMessage(channelMessage({ silent: true })), (error) => error === failure)
      assertEquals(deliveries[0].input.policy, 'silent')
    } finally {
      await events.stop()
    }
  })
})

test('source registry retains builtins, custom registration/removal, and ownership protections', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    try {
      const tags = () => events.listSources().map((s) => s.source)
      assert(tags().includes('cron'))
      assert(tags().includes('system'))
      assert(tags().includes('agent'))
      events.registerSource({ source: 'custom:github', kind: 'custom', description: 'GitHub issues' })
      assert(tags().includes('custom:github'))
      assertEquals(events.unregisterSource('system'), false)
      assertEquals(events.unregisterSource('custom:github'), true)
      assert(!tags().includes('custom:github'))
    } finally {
      await events.stop()
    }
  })
})

test('persisted legacy subscriptions and source defaults load without schema changes', async () => {
  await withTempWorkspace(async (workspace) => {
    const folder = join(workspace, '.events')
    await mkdir(folder)
    await writeFile(join(folder, 'subscriptions.json'), JSON.stringify([
      { id: 'old-sub', sessionId: 'legacy', event: 'tick', source: 'clock', cronJobId: 'job-1', createdAt: timestamp },
      { id: 'old-default', sessionId: 'default', event: 'plain', createdAt: timestamp },
    ]))
    await writeFile(join(folder, 'sources.json'), JSON.stringify([
      { source: 'clock', kind: 'custom', delivery: { urgency: 'steering' }, createdAt: timestamp },
    ]))
    const { events, deliveries } = await setup(workspace)
    try {
      await events.emit({ type: 'tick', source: 'clock' })
      await events.emit({ type: 'plain', source: 'other' })
      assertEquals(deliveries.map((d) => [d.sessionId, d.input.policy]), [['legacy', 'steering'], ['default', 'queue']])
      assertEquals(events.list('legacy')[0].cronJobId, 'job-1')
      assertEquals(events.unsubscribeByCronJob('job-1'), 1)
      assertEquals(events.list('legacy'), [])
    } finally {
      await events.stop()
    }
  })
})

test('custom sources persist across restarts', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    events.registerSource({ source: 'custom:persisted', kind: 'custom' })
    await events.stop()
    const restarted = new EventService(workspace, new Bus(), accepted)
    await restarted.start()
    assert(restarted.listSources().map((s) => s.source).includes('custom:persisted'))
    await restarted.stop()
  })
})

test('flush serializes definition changes and restart sees the final subscription/source state', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    try {
      for (let i = 0; i < 20; i++) {
        const sub = events.subscribe({ sessionId: `target-${i}`, event: 'tick', cronJobId: 'old-job' })
        events.registerSource({ source: `custom:${i}`, kind: 'custom', description: `revision-${i}` })
        if (i % 2 === 0) {
          events.unsubscribe(sub.id)
          events.unregisterSource(`custom:${i}`)
        }
      }
      events.unsubscribeByCronJob('old-job')
      const flushing = events.flush()
      const kept = events.subscribe({ sessionId: 'kept', event: 'final', delivery: { urgency: 'steering' } })
      events.registerSource({ source: 'custom:final', kind: 'custom', delivery: { urgency: 'queue' } })
      await flushing
      const persisted = JSON.parse(await readFile(join(workspace, '.events', 'subscriptions.json'), 'utf8'))
      assertEquals(persisted, JSON.parse(JSON.stringify([kept])))
      const persistedSources = JSON.parse(await readFile(join(workspace, '.events', 'sources.json'), 'utf8'))
      assertEquals(persistedSources, JSON.parse(JSON.stringify(events.listSources().filter((s) => s.kind !== 'system'))))
      await events.stop()
      const restarted = new EventService(workspace, new Bus(), accepted)
      await restarted.start()
      try {
        assertEquals(restarted.list(), persisted)
        assertEquals(restarted.listSources().filter((s) => s.kind !== 'system'), persistedSources)
      } finally {
        await restarted.stop()
      }
    } finally {
      await events.stop()
    }
  })
})

test('persistence failures are reported and stop rejects rather than claiming durable success', async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    await writeFile(join(workspace, '.events'), 'synthetic write obstruction')
    events.subscribe({ sessionId: 'target', event: 'tick' })
    events.registerSource({ source: 'custom:failed', kind: 'custom' })
    try {
      await assert.rejects(events.flush(), (error) => {
        assert(error instanceof AggregateError)
        assertEquals(error.errors.length, 2)
        return true
      })
      assertEquals(logs, [
        ['[events] Failed to persist definitions', { file: '.events/subscriptions.json' }],
        ['[events] Failed to persist definitions', { file: '.events/sources.json' }],
      ])
    } finally {
      await assert.rejects(events.stop(), AggregateError)
    }
  })
})

test('a successful replacement save clears the recorded failure for that definition file', async (t) => {
  t.mock.method(console, 'error', () => {})
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    await writeFile(join(workspace, '.events'), 'synthetic write obstruction')
    const first = events.subscribe({ sessionId: 'first', event: 'tick' })
    await assert.rejects(events.flush(), AggregateError)
    await rm(join(workspace, '.events'))
    events.subscribe({ sessionId: 'second', event: 'tick' })
    await events.stop()
    const persisted = JSON.parse(await readFile(join(workspace, '.events', 'subscriptions.json'), 'utf8'))
    assertEquals(persisted.map((s: { sessionId: string }) => s.sessionId), ['first', 'second'])
    assertEquals(persisted[0].id, first.id)
  })
})

test('awaited stop drains writes and prevents synthetic workspace recreation after cleanup', async () => {
  let fixturePath = ''
  await withTempWorkspace(async (workspace) => {
    fixturePath = workspace
    const { events } = await setup(workspace)
    for (let i = 0; i < 20; i++) {
      events.subscribe({ sessionId: `cleanup-${i}`, event: 'tick' })
      events.registerSource({ source: `custom:cleanup-${i}`, kind: 'custom' })
    }
    const stopping = events.stop()
    assert.throws(() => events.subscribe({ sessionId: 'late', event: 'tick' }), /stopped/)
    assert.throws(() => events.registerSource({ source: 'late', kind: 'custom' }), /stopped/)
    assert.throws(() => events.unsubscribe('late'), /stopped/)
    assert.throws(() => events.unregisterSource('late'), /stopped/)
    assert.throws(() => events.unsubscribeByCronJob('late'), /stopped/)
    await stopping
  })
  await assert.rejects(stat(fixturePath), { code: 'ENOENT' })
  await delay(20)
  await assert.rejects(stat(fixturePath), { code: 'ENOENT' })
})
