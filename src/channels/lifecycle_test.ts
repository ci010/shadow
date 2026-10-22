import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { QQChannel } from './qq.ts'
import { DiscordChannel } from './discord.ts'
import { FeishuChannel } from './feishu.ts'
import type { FeishuTransport } from './feishu-transport.ts'
import type { ChannelState } from './setup-contract.ts'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { deriveSessionId } from '../bus/events.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'

class FakeSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true; this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.(new Event('open')) }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent) }
  disconnected() { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'synthetic-secret' } as CloseEvent) }
}

function sockets(t: TestContext) {
  const created: FakeSocket[] = []
  t.mock.method(globalThis, 'WebSocket', function (url: string) {
    const socket = new FakeSocket(url)
    created.push(socket)
    return socket
  })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'bots.qq.com') {
      return Response.json({ access_token: 'synthetic-access-token', expires_in: 7200 })
    }
    return Response.json({ url: 'wss://synthetic.invalid' })
  })
  return created
}

for (const id of ['qq', 'discord'] as const) {
  const create = () => id === 'qq'
    ? new QQChannel(new Bus(), { appId: 'synthetic-app', secret: 'synthetic-secret' })
    : new DiscordChannel(new Bus(), { token: 'synthetic-secret' })

  test(`${id} transport callbacks retain their project scope when invoked by another runtime`, async t => {
    const created = sockets(t)
    const scope = createProjectScope('A')
    const foreign = createProjectScope('B')
    const channel = scope.run(create)
    const observed: Array<string | undefined> = []
    channel.setReceiver(async message => {
      observed.push(getProjectScope()?.projectId)
      return { status: 'accepted', sessionId: `${id}:${message.chatId}`, inputId: message.messageId }
    })
    const statusScopes: Array<string | undefined> = []
    channel.setStatusListener(() => statusScopes.push(getProjectScope()?.projectId))
    t.after(async () => { await channel.stop(); scope.close(); foreign.close() })
    await scope.run(() => channel.start(new Hono()))
    const stale = created[0].onmessage
    foreign.run(() => {
      created[0].message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } })
      created[0].message(id === 'qq'
        ? { op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'message', author: { user_openid: 'sender' }, content: 'Hello' } }
        : { op: 0, t: 'MESSAGE_CREATE', d: { id: 'message', channel_id: 'chat', author: { id: 'sender' }, content: 'Hello' } })
      assert.equal(getProjectScope(), foreign)
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(observed, ['A'])
    assert.ok(statusScopes.length > 0)
    assert.ok(statusScopes.every(id => id === 'A'))
    await channel.stop()
    scope.close()
    assert.doesNotThrow(() => foreign.run(() => stale?.({
      data: JSON.stringify({ op: 0, t: 'READY', d: {} }),
    } as MessageEvent)))
    assert.deepEqual(observed, ['A'])
  })

  test(`${id} readiness follows READY/disconnect/error, not start or WebSocket open`, async (t) => {
    const created = sockets(t)
    const log: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => { log.push(args) })
    t.mock.method(console, 'error', (...args: unknown[]) => { log.push(args) })
    const channel = create()
    const states: ChannelState[] = []
    channel.setStatusListener((state) => states.push(state))
    t.after(() => channel.stop())
    await channel.start(new Hono())
    assert.equal(states.at(-1), 'connecting')
    assert.equal(created.length, 1)
    const ws = created[0]
    ws.open()
    assert.equal(states.at(-1), 'connecting')
    ws.message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } })
    assert.equal(states.at(-1), 'connected')
    ws.onerror?.(Object.assign(new Event('error'), { message: 'synthetic-secret' }))
    assert.equal(states.at(-1), 'error')
    ws.message({ op: 0, t: 'RESUMED', d: {} })
    assert.equal(states.at(-1), 'connected')
    ws.disconnected()
    assert.equal(states.at(-1), 'disconnected')
    assert.doesNotMatch(JSON.stringify(log), /synthetic-secret/)
  })

  test(`${id} stop cancels reconnect, identify, heartbeat and stale socket callbacks`, async (t) => {
    const created = sockets(t)
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = create()
    const states: ChannelState[] = []
    channel.setStatusListener((state) => states.push(state))
    await channel.start(new Hono())
    const ws = created[0]
    ws.open()
    ws.message({ op: 10, d: { heartbeat_interval: 1000 } })
    ws.message({ op: 9, d: false })
    const staleMessage = ws.onmessage
    const staleClose = ws.onclose
    const staleError = ws.onerror
    ws.disconnected()
    await channel.stop()
    const sent = ws.sent.length
    staleMessage?.({ data: JSON.stringify({ op: 0, t: 'READY', d: {} }) } as MessageEvent)
    staleClose?.({ code: 1006 } as CloseEvent)
    staleError?.(new Event('error'))
    t.mock.timers.tick(60_000)
    await Promise.resolve()
    assert.equal(created.length, 1)
    assert.equal(ws.sent.length, sent)
    assert.equal(states.at(-1), 'disconnected')
  })

  test(`${id} a gateway fetch completing after stop never creates a socket`, async (t) => {
    const created = sockets(t)
    const response = Promise.withResolvers<Response>()
    t.mock.method(globalThis, 'fetch', () => response.promise)
    const channel = create()
    const start = channel.start(new Hono())
    await channel.stop()
    response.resolve(Response.json({ url: 'wss://synthetic.invalid', access_token: 'synthetic-token', expires_in: 7200 }))
    await start
    assert.equal(created.length, 0)
  })

  test(`${id} reconnect renews request admission without reviving old socket callbacks`, async (t) => {
    const created = sockets(t)
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = create()
    const received: string[] = []
    channel.setReceiver(async message => {
      received.push(message.messageId)
      return { status: 'accepted', sessionId: `${id}:${message.chatId}`, inputId: message.messageId }
    })
    t.after(() => channel.stop())
    await channel.start(new Hono())
    const stale = created[0].onmessage
    created[0].disconnected()
    t.mock.timers.tick(5_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(created.length, 2)
    const data = id === 'qq'
      ? { op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'after', author: { user_openid: 'sender' }, content: 'Hello' } }
      : { op: 0, t: 'MESSAGE_CREATE', d: { id: 'after', channel_id: 'chat', author: { id: 'sender' }, content: 'Hello' } }
    stale?.({ data: JSON.stringify(data) } as MessageEvent)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(received, [])
    created[1].message(data)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(received, ['after'])
  })

  test(`${id} fatal authentication closes report error without an automatic retry`, async (t) => {
    const created = sockets(t)
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = create()
    let state: ChannelState | undefined
    channel.setStatusListener((value) => { state = value })
    await channel.start(new Hono())
    created[0].onclose?.({ code: 4004, reason: 'synthetic-secret' } as CloseEvent)
    assert.equal(state, 'error')
    t.mock.timers.tick(60_000)
    await Promise.resolve()
    assert.equal(created.length, 1)
    await channel.stop()
  })

  test(`${id} missing heartbeat acknowledgements invalidate a previously ready connection`, async (t) => {
    const created = sockets(t)
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = create()
    let state: ChannelState | undefined
    channel.setStatusListener((value) => { state = value })
    await channel.start(new Hono())
    created[0].open()
    created[0].message({ op: 10, d: { heartbeat_interval: 1000 } })
    created[0].message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } })
    assert.equal(state, 'connected')
    t.mock.timers.tick(1000)
    created[0].message({ op: 11 })
    t.mock.timers.tick(1000)
    assert.equal(state, 'connected')
    t.mock.timers.tick(1000)
    assert.equal(state, 'disconnected')
    assert.equal(created[0].closed, true)
    await channel.stop()
  })
}

test('Discord READY uses the actual bot user identity to refuse cross-org duplicate tokens before admitting messages', async t => {
  const created = sockets(t)
  mkdirSync(join(process.cwd(), '.test-data'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), '.test-data', 'discord-bot-identity-'))
  const managers: ChannelManager[] = []
  const received: string[] = []
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.stopAll()))
    rmSync(root, { recursive: true, force: true })
  })
  for (const projectId of ['A', 'B']) {
    const store = new BotInstanceStore({ projectId, path: join(root, projectId, 'bots.json') })
    store.create('discord', 'Discord', { token: `synthetic-rotated-token-${projectId}`, enabled: true })
    const sessions: Pick<SessionManager, 'getSessionState'> = { getSessionState: () => null }
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace: join(root, projectId) } }),
      new Bus(), sessions as SessionManager, async message => {
        received.push(message.channelAddress!.projectId)
        return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
      }, { projectId, instanceStore: store })
    managers.push(manager)
    await manager.init()
    await manager.startAll(new Hono())
  }
  for (const socket of created) socket.message({
    op: 0, t: 'READY', d: { session_id: 'same-session', user: { id: 'same-actual-bot', bot: true } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(managers[0].botStatuses()[0].state, 'connected')
  assert.equal(managers[1].botStatuses()[0].state, 'error')
  assert.equal(managers[1].botStatuses()[0].message, 'bot_identity_already_bound')
  assert.equal(created[1].closed, true)
  for (const socket of created) socket.message({
    op: 0, t: 'MESSAGE_CREATE', d: { id: 'same-message', channel_id: 'same-chat', author: { id: 'alice' }, content: 'Hello' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, ['A'])
})

test('QQ replacement connection retains receiver routing and rejects old subscriptions without adding routes', async (t) => {
  const created = sockets(t)
  const app = new Hono()
  app.get('/fixture', (c) => c.text('ready'))
  await app.request('/fixture')
  const routeCount = app.routes.length
  const received: string[] = []
  const create = () => {
    const channel = new QQChannel(new Bus(), { appId: 'synthetic-app', secret: 'synthetic-secret' })
    channel.setReceiver(async (message) => {
      received.push(message.messageId)
      return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
    })
    return channel
  }
  const message = (id: string) => ({
    op: 0, t: 'C2C_MESSAGE_CREATE',
    d: { id, author: { user_openid: 'sender' }, content: 'hello' },
  })
  const first = create()
  await first.start(app)
  created[0].message(message('before'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(received, ['before'])
  const staleMessage = created[0].onmessage
  await first.stop()
  assert.equal(created[0].closed, true)
  assert.equal(created[0].onmessage, null)
  const second = create()
  t.after(() => second.stop())
  await second.start(app)
  staleMessage?.({ data: JSON.stringify(message('stale')) } as MessageEvent)
  created[1].message(message('after'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(received, ['before', 'after'])
  assert.equal(app.routes.length, routeCount)
})

test('Feishu hot setup keeps one proxy route and disconnects old transport with stale callbacks ignored', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 })
    return Response.json({ code: 0, bot: { open_id: 'bot' } })
  })
  const app = new Hono()
  FeishuChannel.registerRoutes(app)
  assert.equal((await app.request('/feishu/open-apis/example')).status, 503)
  const routeCount = app.routes.length
  const transports: Array<{
    states: (state: 'running' | 'error' | 'disconnected') => void
    onEvent: (event: Record<string, unknown>) => void
    stops: number
  }> = []
  const received: string[] = []
  const receive = async (message: { messageId: string }) => {
    received.push(message.messageId)
    return { status: 'accepted' as const, sessionId: 'feishu:sender', inputId: message.messageId }
  }
  const event = (id: string) => ({
    sender: { sender_id: { open_id: 'sender' } },
    message: { message_id: id, chat_id: 'sender', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}' },
  })
  const create = () => new FeishuChannel(new Bus(), {
    appId: 'synthetic-app', appSecret: 'synthetic-secret',
    transportFactory: (_options, onEvent, states): FeishuTransport => {
      const entry = { states, onEvent, stops: 0 }
      transports.push(entry)
      return { start: () => states('running'), stop: async () => { entry.stops++ } }
    },
  })
  const first = create()
  first.setReceiver(receive)
  const firstStates: ChannelState[] = []
  first.setStatusListener((state) => firstStates.push(state))
  await first.start(app)
  assert.equal(firstStates.at(-1), 'running')
  assert.equal(app.routes.length, routeCount)
  assert.equal((await app.request('/feishu/open-apis/example')).status, 200)
  transports[0].onEvent(event('before'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(received, ['before'])
  await first.stop()
  assert.equal(transports[0].stops, 1)
  assert.equal((await app.request('/feishu/open-apis/example')).status, 503)
  const second = create()
  second.setReceiver(receive)
  await second.start(app)
  transports[0].states('error')
  transports[0].onEvent(event('stale'))
  transports[1].onEvent(event('after'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(received, ['before', 'after'])
  assert.equal(firstStates.at(-1), 'disconnected')
  assert.equal(app.routes.length, routeCount)
  assert.equal((await app.request('/feishu/open-apis/example')).status, 200)
  await second.stop()
})

test('Feishu startup and proxy failures do not return or log raw SDK errors', async (t) => {
  const log: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { log.push(args) })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-secret-bearing-sdk-error') })
  const channel = new FeishuChannel(new Bus(), {
    appId: 'app', appSecret: 'synthetic-secret',
    transportFactory: () => ({ start() {}, async stop() {} }),
  })
  const app = new Hono()
  await channel.start(app)
  const response = await app.request('/feishu/open-apis/example')
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), /synthetic-secret/)
  assert.doesNotMatch(JSON.stringify(log), /synthetic-secret/)
  await channel.stop()
})
