import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { EventService } from './service.ts'
import type { InboundMessage } from '../bus/events.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

async function setup(workspace: string) {
  const bus = new Bus()
  const events = new EventService(workspace, bus)
  await events.start()
  const inbound: InboundMessage[] = []
  // Delivered events carry the __eventDispatch guard flag.
  bus.on('message.inbound', (m) => {
    if (m.eventMeta?.__eventDispatch === true) inbound.push(m)
  })
  return { bus, events, inbound }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('emit to target session defaults to queue urgency (no urgency meta)', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.emit({ type: 'x', source: 'agent', content: 'hi', targetSessionId: 'discord:1' })

    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].channel, 'discord')
    assertEquals(inbound[0].chatId, '1')
    assertEquals(inbound[0].eventMeta?.urgency, undefined)
    assert(!inbound[0].silent)
    events.stop()
  })
})

test('silent urgency records but marks the inbound silent', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.emit({
      type: 'x',
      source: 'agent',
      targetSessionId: 'discord:1',
      delivery: { urgency: 'silent' },
    })

    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].silent, true)
    assertEquals(inbound[0].eventMeta?.urgency, 'silent')
    events.stop()
  })
})

test('steering urgency surfaces in eventMeta', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.emit({
      type: 'x',
      source: 'agent',
      targetSessionId: 'discord:1',
      delivery: { urgency: 'steering' },
    })

    assertEquals(inbound[0].eventMeta?.urgency, 'steering')
    events.stop()
  })
})

test('event.delivery overrides subscription.delivery', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.subscribe({ sessionId: 'discord:2', event: 'y', delivery: { urgency: 'queue' } })
    events.emit({ type: 'y', source: 'agent', delivery: { urgency: 'steering' } })

    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].eventMeta?.urgency, 'steering')
    events.stop()
  })
})

test('subscription.delivery applies when the event declares none', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.subscribe({ sessionId: 'discord:2', event: 'y', delivery: { urgency: 'silent' } })
    events.emit({ type: 'y', source: 'agent' })

    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].silent, true)
    events.stop()
  })
})

test('source default delivery applies when neither event nor subscription set one', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.registerSource({ source: 'noisy', kind: 'custom', delivery: { urgency: 'silent' } })
    events.subscribe({ sessionId: 'discord:2', event: 'z', source: 'noisy' })
    events.emit({ type: 'z', source: 'noisy' })

    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].silent, true)
    events.stop()
  })
})

test('debounce coalesces a burst into a single wake', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events, inbound } = await setup(workspace)
    events.subscribe({
      sessionId: 'discord:3',
      event: 'tick',
      delivery: { urgency: 'debounce', debounceMs: 30 },
    })
    events.emit({ type: 'tick', source: 'agent' })
    events.emit({ type: 'tick', source: 'agent' })
    events.emit({ type: 'tick', source: 'agent' })

    // Nothing delivered synchronously.
    assertEquals(inbound.length, 0)

    await delay(80)
    assertEquals(inbound.length, 1)
    assertEquals(inbound[0].eventMeta?.coalesced, 3)
    events.stop()
  })
})

test('source registry: builtins present, custom register/unregister, builtins protected', async () => {
  await withTempWorkspace(async (workspace) => {
    const { events } = await setup(workspace)
    const tags = () => events.listSources().map((s) => s.source)

    assert(tags().includes('cron'))
    assert(tags().includes('system'))
    assert(tags().includes('agent'))

    events.registerSource({ source: 'custom:github', kind: 'custom', description: 'GitHub issues' })
    assert(tags().includes('custom:github'))

    // Built-in system source cannot be removed.
    assertEquals(events.unregisterSource('system'), false)
    // Custom source can.
    assertEquals(events.unregisterSource('custom:github'), true)
    assert(!tags().includes('custom:github'))
    events.stop()
  })
})

test('custom sources persist across restarts', async () => {
  await withTempWorkspace(async (workspace) => {
    const bus = new Bus()
    const events = new EventService(workspace, bus)
    await events.start()
    events.registerSource({ source: 'custom:persisted', kind: 'custom' })
    events.stop()

    // Give the async save a tick to flush.
    await delay(20)

    const bus2 = new Bus()
    const events2 = new EventService(workspace, bus2)
    await events2.start()
    assert(events2.listSources().map((s) => s.source).includes('custom:persisted'))
    events2.stop()
  })
})
