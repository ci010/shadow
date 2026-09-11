import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage, OutboundMessage } from '../bus/events.ts'
import type { Config } from '../config/schema.ts'
import type { DeliveryReceipt, ReceiveChannelMessage } from '../sessions/input.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { AbstractChannel, type BaseChannel } from './base.ts'
import { ChannelManager } from './manager.ts'
import { WebChannel } from './web.ts'
import { QQChannel } from './qq.ts'

function accepted(message: InboundMessage): DeliveryReceipt {
  return { status: 'accepted', sessionId: `${message.channel}:${message.chatId}`, inputId: message.messageId }
}

function outbound(content: string, replyTo?: string, channel = 'web'): OutboundMessage {
  return { channel, chatId: 'chat', event: 'response', content, done: true, replyTo }
}

function post(app: Hono, path: string, body: Record<string, unknown>) {
  return Promise.resolve(app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

class TestChannel extends AbstractChannel {
  readonly name = 'test'
  stopped = false
  sent: OutboundMessage[] = []
  update = undefined
  async start(): Promise<void> { this.stopped = false }
  async stop(): Promise<void> { this.stopped = true }
  async send(message: OutboundMessage): Promise<null> {
    assert.equal(this.stopped, false)
    this.sent.push(message)
    return null
  }
  incoming(sender = 'sender', fields: Partial<InboundMessage> = {}) {
    return this.handleIncoming(sender, 'chat', 'hello', 'message', fields, ['uploads/test.png'])
  }
}

function webInternals(channel: WebChannel) {
  return channel as unknown as {
    pending: Map<string, ReadableStreamDefaultController>
    syncPending: Map<string, { timer: ReturnType<typeof setTimeout> }>
  }
}

test('channel ingress requires a receiver and rejects unauthorized senders without bus fallback', async () => {
  const bus = new Bus()
  let inboundNotifications = 0
  bus.on('message.inbound', () => { inboundNotifications++ })
  const channel = new TestChannel(bus, ['allowed'])
  await assert.rejects(channel.incoming('blocked'), /not authorized/)
  await assert.rejects(channel.incoming('allowed'), /receiver is not configured/)
  let received = 0
  channel.setReceiver(async (message) => { received++; return accepted(message) })
  await assert.rejects(channel.incoming('blocked'), /not authorized/)
  assert.equal(received, 0)
  assert.equal(inboundNotifications, 0)
})

test('channel ingress awaits explicit admission and preserves sender, policy and reply fields', async () => {
  const channel = new TestChannel(new Bus(), undefined, false, ['chat'])
  const gate = Promise.withResolvers<DeliveryReceipt>()
  let received: InboundMessage | undefined
  channel.setReceiver((message) => { received = message; return gate.promise })
  let settled = false
  const pending = channel.incoming('sender', {
    isGroup: true, silent: true, retry: true, senderName: 'Sender', chatName: 'Group',
  }).then((receipt) => { settled = true; return receipt })
  await setImmediate()
  assert.equal(settled, false)
  assert.deepEqual(received, {
    channel: 'test', senderId: 'sender', chatId: 'chat', content: 'hello',
    messageId: 'message', platformMessageId: 'message', timestamp: received!.timestamp,
    senderName: 'Sender', chatName: 'Group', isGroup: true, silent: true, retry: true,
    admin: true, media: ['uploads/test.png'],
  })
  const receipt = accepted(received!)
  gate.resolve(receipt)
  assert.equal(await pending, receipt)
  const rejection = new Error('Mailbox rejected input')
  channel.setReceiver(async () => { throw rejection })
  await assert.rejects(channel.incoming(), rejection)
})

test('nonstreaming web send waits only for admission and preserves its response shape', async (t) => {
  const bus = new Bus()
  const channel = new WebChannel(bus, {})
  const app = new Hono()
  const gate = Promise.withResolvers<DeliveryReceipt>()
  const entered = Promise.withResolvers<InboundMessage>()
  channel.setReceiver((message) => { entered.resolve(message); return gate.promise })
  await channel.start(app)
  t.after(() => channel.stop())
  let settled = false
  const request = post(app, '/api/chat/send', {
    chatId: 'chat', content: 'hello', stream: false, retry: true, media: ['uploads/test.png'],
  }).then((response) => { settled = true; return response })
  const message = await entered.promise
  await setImmediate()
  assert.equal(settled, false)
  assert.equal(webInternals(channel).pending.size, 0)
  assert.equal(message.retry, true)
  assert.deepEqual(message.media, ['uploads/test.png'])
  gate.resolve(accepted(message))
  const response = await request
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { requestId: message.messageId, chatId: 'chat' })
})

test('web admission rejection is an HTTP error for both send modes and sync requests', async (t) => {
  const channel = new WebChannel(new Bus(), {})
  const app = new Hono()
  channel.setReceiver(async () => { throw new Error('Mailbox unavailable') })
  await channel.start(app)
  t.after(() => channel.stop())
  for (const [path, extra] of [
    ['/api/chat/send', { stream: false }],
    ['/api/chat/send', {}],
    ['/api/chat/message', {}],
  ] as const) {
    const response = await post(app, path, { chatId: 'chat', content: 'hello', ...extra })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Mailbox unavailable' })
    assert.equal(webInternals(channel).pending.size, 0)
    assert.equal(webInternals(channel).syncPending.size, 0)
  }
})

test('web missing receiver and unauthorized sender never return accepted streams', async (t) => {
  const channel = new WebChannel(new Bus(), { allowFrom: ['allowed'] })
  const app = new Hono()
  await channel.start(app)
  t.after(() => channel.stop())
  for (const path of ['/api/chat/send', '/api/chat/message']) {
    const unauthorized = await post(app, path, { chatId: 'chat', content: 'hello' })
    assert.equal(unauthorized.status, 403)
    assert.match((await unauthorized.json()).error, /not authorized/)
    const unconfigured = await post(app, path, {
      chatId: 'chat', content: 'hello', senderId: 'allowed',
    })
    assert.equal(unconfigured.status, 503)
    assert.match((await unconfigured.json()).error, /not configured/)
  }
  assert.equal(webInternals(channel).pending.size, 0)
  assert.equal(webInternals(channel).syncPending.size, 0)
})

test('SSE registers before admission, captures fast replies, and waits for acceptance', async (t) => {
  const bus = new Bus()
  const channel = new WebChannel(bus, {})
  const app = new Hono()
  const gate = Promise.withResolvers<DeliveryReceipt>()
  const entered = Promise.withResolvers<InboundMessage>()
  channel.setReceiver((message) => {
    assert.equal(webInternals(channel).pending.has(message.messageId), true)
    bus.emit('message.outbound', outbound('fast response', message.messageId))
    entered.resolve(message)
    return gate.promise
  })
  await channel.start(app)
  t.after(() => channel.stop())
  let settled = false
  const request = post(app, '/api/chat/send', { chatId: 'chat', content: 'hello' })
    .then((response) => { settled = true; return response })
  const message = await entered.promise
  await setImmediate()
  assert.equal(settled, false)
  gate.resolve(accepted(message))
  const response = await request
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  assert.equal(await response.text(),
    'data: {"event":"response","content":"fast response","done":true}\n\n')
  assert.equal(webInternals(channel).pending.size, 0)
})

test('SSE admission rejection cancels even a stream with an already buffered response', async (t) => {
  const bus = new Bus()
  const channel = new WebChannel(bus, {})
  const app = new Hono()
  let controller: ReadableStreamDefaultController | undefined
  channel.setReceiver(async (message) => {
    controller = webInternals(channel).pending.get(message.messageId)
    bus.emit('message.outbound', { ...outbound('early', message.messageId), done: false })
    throw new Error('Admission rejected')
  })
  await channel.start(app)
  t.after(() => channel.stop())
  const response = await post(app, '/api/chat/send', { chatId: 'chat', content: 'hello' })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Admission rejected' })
  assert.equal(webInternals(channel).pending.size, 0)
  assert.throws(() => controller!.enqueue(new Uint8Array()), /closed/)
})

test('sync web requests await admission plus full response and clean timers on rejection', async (t) => {
  const bus = new Bus()
  const channel = new WebChannel(bus, {})
  const app = new Hono()
  const entered = Promise.withResolvers<InboundMessage>()
  channel.setReceiver(async (message) => { entered.resolve(message); return accepted(message) })
  await channel.start(app)
  t.after(() => channel.stop())
  let settled = false
  const request = post(app, '/api/chat/message', { chatId: 'chat', content: 'hello' })
    .then((response) => { settled = true; return response })
  const message = await entered.promise
  await setImmediate()
  assert.equal(settled, false)
  bus.emit('message.outbound', { ...outbound('part one', message.messageId), done: false })
  bus.emit('message.outbound', { ...outbound('part two', message.messageId), media: ['answer.txt'] })
  const response = await request
  assert.deepEqual(await response.json(), {
    requestId: message.messageId, chatId: 'chat', content: 'part one\npart two', media: ['answer.txt'],
  })
  assert.equal(webInternals(channel).syncPending.size, 0)

  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = t.mock.method(globalThis, 'clearTimeout')
  channel.setReceiver(async (incoming) => {
    timer = webInternals(channel).syncPending.get(incoming.messageId)!.timer
    bus.emit('message.outbound', outbound('premature success', incoming.messageId))
    throw new Error('Not accepted')
  })
  const rejected = await post(app, '/api/chat/message', { chatId: 'chat', content: 'hello' })
  assert.equal(rejected.status, 503)
  assert.deepEqual(await rejected.json(), { error: 'Not accepted' })
  assert(clearTimer.mock.calls.some((call) => call.arguments[0] === timer))
  assert.equal(webInternals(channel).syncPending.size, 0)
})

test('sync web timeout keeps 504 and stop rejects pending work instead of returning empty success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const channel = new WebChannel(new Bus(), {})
  const app = new Hono()
  await channel.start(app)
  t.after(() => channel.stop())
  let entered = Promise.withResolvers<void>()
  channel.setReceiver(async (message) => { entered.resolve(); return accepted(message) })
  const timed = post(app, '/api/chat/message', { content: 'hello', timeoutMs: 10 })
  await entered.promise
  t.mock.timers.tick(10)
  assert.equal((await timed).status, 504)
  assert.equal(webInternals(channel).syncPending.size, 0)

  entered = Promise.withResolvers<void>()
  const stopped = post(app, '/api/chat/message', { content: 'hello' })
  await entered.promise
  await channel.stop()
  assert.equal((await stopped).status, 503)
  assert.equal(webInternals(channel).syncPending.size, 0)
})

test('web parent linkage precedes admission and background SSE still receives unsolicited replies', async (t) => {
  const bus = new Bus()
  const order: string[] = []
  const parents: unknown[] = []
  const sessionManager = {
    getSessionState: () => null,
    buildSession: async (sessionId: string, parent: unknown) => {
      order.push('build')
      parents.push([sessionId, parent])
    },
  } as unknown as SessionManager
  const channel = new WebChannel(bus, { sessionManager })
  channel.setReceiver(async (message) => { order.push('receive'); return accepted(message) })
  const app = new Hono()
  await channel.start(app)
  t.after(() => channel.stop())
  await post(app, '/api/chat/send', {
    chatId: 'chat', content: 'hello', stream: false, parentChatId: 'parent', forkAt: 3,
  })
  await post(app, '/api/chat/send', {
    chatId: 'chat', content: 'hello', stream: false, parentSessionId: 'discord:parent',
  })
  assert.deepEqual(order, ['build', 'receive', 'build', 'receive'])
  assert.deepEqual(parents, [
    ['web:chat', { id: 'web:parent', index: 3 }],
    ['web:chat', { id: 'discord:parent' }],
  ])
  const events = await app.request('/api/chat/events?chatId=chat')
  const reader = events.body!.getReader()
  await reader.read()
  bus.emit('message.outbound', outbound('background'))
  assert.match(new TextDecoder().decode((await reader.read()).value), /"content":"background"/)
  await reader.cancel()
})

function managerWithChannel(bus: Bus, channel: BaseChannel) {
  const manager = new ChannelManager({} as Config, bus, {} as SessionManager, async acceptedMessage =>
    accepted(acceptedMessage))
  const internals = manager as unknown as {
    channels: Map<string, BaseChannel>
    dispatchTask?: Promise<void>
  }
  internals.channels.set(channel.name, channel)
  return { manager, internals }
}

test('ChannelManager configures receivers during init and web outbound is projected only once', async (t) => {
  const bus = new Bus()
  const received: InboundMessage[] = []
  const receive: ReceiveChannelMessage = async (message) => {
    received.push(message)
    bus.emit('message.outbound', outbound('reply', message.messageId))
    return accepted(message)
  }
  const manager = new ChannelManager(
    { channels: {}, agent: { workspace: '.' } } as Config,
    bus,
    { getSessionState: () => null } as unknown as SessionManager,
    receive,
  )
  await manager.init()
  const app = new Hono()
  await manager.startAll(app)
  t.after(() => manager.stopAll())
  const response = await post(app, '/api/chat/send', { chatId: 'chat', content: 'hello' })
  assert.equal(received.length, 1)
  assert.equal((await response.text()).match(/data:/g)?.length, 1)
})

test('ChannelManager preserves outbound FIFO published before dispatch', async () => {
  const bus = new Bus()
  const channel = new TestChannel(bus)
  bus.declareQueue('message.outbound')
  bus.emit('message.outbound', outbound('one', undefined, 'test'))
  const { manager } = managerWithChannel(bus, channel)
  bus.emit('message.outbound', outbound('two', undefined, 'test'))
  await manager.startAll(new Hono())
  await setImmediate()
  await manager.stopAll()
  assert.deepEqual(channel.sent.map((message) => message.content), ['one', 'two'])
})

test('empty completion clears progressive replies through ChannelManager without blank sends or updates', async () => {
  class ProgressiveChannel extends AbstractChannel {
    readonly name = 'test'
    sent: OutboundMessage[] = []
    updates: Array<{ messageId: string; content: string }> = []
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(message: OutboundMessage): Promise<string> {
      this.sent.push(message)
      return `sent-${this.sent.length}`
    }
    async update(messageId: string, _chatId: string, content: string): Promise<void> {
      this.updates.push({ messageId, content })
    }
  }
  const bus = new Bus()
  const channel = new ProgressiveChannel(bus)
  const { manager } = managerWithChannel(bus, channel)
  bus.emit('message.outbound', { ...outbound('first', undefined, 'test'), done: false })
  bus.emit('message.outbound', { ...outbound('continuation', undefined, 'test'), done: false })
  bus.emit('message.outbound', outbound('', undefined, 'test'))
  bus.emit('message.outbound', { ...outbound('next', undefined, 'test'), done: false })
  bus.emit('message.outbound', { ...outbound('', undefined, 'test'), media: [] })
  bus.emit('message.outbound', outbound('final', undefined, 'test'))
  await manager.startAll(new Hono())
  await setImmediate()
  await manager.stopAll()
  assert.deepEqual(channel.sent.map((message) => message.content), ['first', 'next', 'final'])
  assert.deepEqual(channel.updates, [{ messageId: 'sent-1', content: 'continuation' }])
})

test('completion-only dispatch is silent for non-editable channels but still delivers media-only replies', async () => {
  const bus = new Bus()
  const channel = new TestChannel(bus)
  const { manager } = managerWithChannel(bus, channel)
  bus.emit('message.outbound', outbound('', undefined, 'test'))
  bus.emit('message.outbound', { ...outbound('', undefined, 'test'), media: ['answer.png'] })
  await manager.startAll(new Hono())
  await setImmediate()
  await manager.stopAll()
  assert.equal(channel.sent.length, 1)
  assert.deepEqual(channel.sent[0].media, ['answer.png'])
})

test('ChannelManager cancels blocked consume quietly on stop without taking later messages', async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const bus = new Bus()
  const channel = new TestChannel(bus)
  const { manager, internals } = managerWithChannel(bus, channel)
  await manager.startAll(new Hono())
  const task = internals.dispatchTask
  await manager.stopAll()
  await task
  assert.deepEqual(errors, [])
  bus.emit('message.outbound', outbound('pending', undefined, 'test'))
  assert.deepEqual(channel.sent, [])
  assert.equal((await bus.consume('message.outbound', { signal: AbortSignal.timeout(1000) })).content, 'pending')
})

test('ChannelManager drains already-queued messages in FIFO order when stop races with consume', async () => {
  const bus = new Bus()
  const channel = new TestChannel(bus)
  const { manager } = managerWithChannel(bus, channel)
  bus.emit('message.outbound', outbound('in-flight', undefined, 'test'))
  bus.emit('message.outbound', outbound('still queued', undefined, 'test'))
  const starting = manager.startAll(new Hono())
  const stopping = manager.stopAll()
  await Promise.all([starting, stopping])
  assert.equal(channel.stopped, true)
  assert.deepEqual(channel.sent.map((message) => message.content), ['in-flight', 'still queued'])
  assert.equal(bus.hasQueued('message.outbound'), false)
})

test('ChannelManager drains behind in-flight sends and awaits the final send before stopping resources', async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const bus = new Bus()
  const channel = new TestChannel(bus)
  const { manager } = managerWithChannel(bus, channel)
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const finalEntered = Promise.withResolvers<void>()
  const finalFinish = Promise.withResolvers<void>()
  const send = channel.send.bind(channel)
  channel.send = async (message) => {
    if (message.content === 'in-flight') {
      entered.resolve()
      await finish.promise
    } else if (message.content === 'final') {
      finalEntered.resolve()
      await finalFinish.promise
    }
    return send(message)
  }
  bus.emit('message.outbound', outbound('in-flight', undefined, 'test'))
  await manager.startAll(new Hono())
  await entered.promise
  bus.emit('message.outbound', outbound('queued', undefined, 'test'))
  bus.emit('message.outbound', outbound('final', undefined, 'test'))
  let stopped = false
  const stopping = manager.stopAll().then(() => { stopped = true })
  await setImmediate()
  assert.equal(stopped, false)
  assert.equal(channel.stopped, false)
  finish.resolve()
  await finalEntered.promise
  assert.equal(stopped, false)
  assert.equal(channel.stopped, false)
  assert.deepEqual(channel.sent.map((message) => message.content), ['in-flight', 'queued'])
  finalFinish.resolve()
  await stopping
  assert.equal(channel.stopped, true)
  assert.deepEqual(channel.sent.map((message) => message.content), ['in-flight', 'queued', 'final'])
  assert.equal(bus.hasQueued('message.outbound'), false)
  assert.deepEqual(errors, [])
})

test('ChannelManager reports send failures instead of mistaking them for consume cancellation', async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const bus = new Bus()
  const channel = new TestChannel(bus)
  const { manager } = managerWithChannel(bus, channel)
  const send = channel.send.bind(channel)
  const abortedSend = new DOMException('Network send aborted', 'AbortError')
  channel.send = async (message) => {
    if (message.content === 'failed') throw abortedSend
    return send(message)
  }
  bus.emit('message.outbound', outbound('failed', undefined, 'test'))
  bus.emit('message.outbound', outbound('next', undefined, 'test'))
  await manager.startAll(new Hono())
  await setImmediate()
  await manager.stopAll()
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], abortedSend)
  assert.deepEqual(channel.sent.map((message) => message.content), ['next'])
})

test('QQ dispatch awaits and propagates receiver rejection for group, private and guild messages', async () => {
  const channel = new QQChannel(new Bus(), { appId: 'synthetic', secret: 'synthetic' })
  const received: InboundMessage[] = []
  const rejection = new Error('Receiver rejected')
  channel.setReceiver(async (message) => { received.push(message); throw rejection })
  const dispatch = (channel as unknown as {
    handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
  }).handleDispatch.bind(channel)
  for (const [index, event] of [
    'GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE',
  ].entries()) {
    await assert.rejects(dispatch(event, {
      id: `message-${index}`, content: 'hello', group_openid: 'group', guild_id: 'guild',
      channel_id: 'channel', author: { member_openid: 'user', user_openid: 'user', id: 'user' },
    }), rejection)
  }
  assert.deepEqual(received.map((message) => message.chatId), [
    'group:group', 'c2c:user', 'channel:channel', 'dms:guild',
  ])
})
