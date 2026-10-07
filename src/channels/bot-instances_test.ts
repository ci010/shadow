import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, deriveSessionId, type ChannelAddress, type InboundMessage, type OutboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import { REDACTED_SECRET } from '../config/store.ts'
import { channelMessageInput, inputContext, sessionReplyAddress, type ReceiveChannelMessage } from '../sessions/input.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { YieldManager } from '../sessions/yield.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import { AbstractChannel, type ChannelDecision } from './base.ts'
import { unavailableCapabilities } from './capabilities.ts'
import { BotInstanceStore, type BotInstance } from './bot-store.ts'
import { botSetupPlugin } from './bot-setup.ts'
import { ChannelManager } from './manager.ts'
import type { ChannelId, ChannelState } from './setup-contract.ts'
import { FeishuChannel } from './feishu.ts'
import type { FeishuTransport } from './feishu-transport.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { createProjectScope, getProjectScope, type ProjectScope } from '../projects/scope.ts'
import { WebChannel } from './web.ts'
import { QQChannel } from './qq.ts'

function directory(t: TestContext): string {
  const path = join(process.cwd(), '.test-data', `bot-instances-${randomUUID()}`)
  mkdirSync(path, { recursive: true })
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

class BotChannel extends AbstractChannel {
  update = undefined
  sent: OutboundMessage[] = []
  decisions: YieldRequest[] = []
  threads: string[] = []
  capturedReceiver!: ReceiveChannelMessage
  failStop = false
  constructor(readonly name: ChannelId, bus: Bus, readonly bot: BotInstance, private identity = bot.id) { super(bus, ['alice']) }
  override setReceiver(receiver: ReceiveChannelMessage) { this.capturedReceiver = receiver; super.setReceiver(receiver) }
  async start() { this.setAccepting(true); this.reportIdentity(this.identity); this.reportState('connected') }
  async stop() {
    if (this.failStop) throw new Error('synthetic-secret-stop-error')
    this.setAccepting(false); this.reportState('disconnected')
  }
  async send(message: OutboundMessage) { this.assertConnection(); this.sent.push(message); return 'same-message-id' }
  override getCapabilities() { return { ...unavailableCapabilities(), threads: 'public' as const, decisions: 'buttons' as const } }
  async createThread(chatId: string) { this.threads.push(chatId); return 'same-thread-id' }
  override async presentDecision(_chat: string, request: YieldRequest) { this.decisions.push(request) }
  click(decision: ChannelDecision) { return this.answerDecision(decision) }
  incoming(chatId = 'same-chat-id') { return this.handleIncoming('alice', chatId, 'Hello', 'same-message-id', { isGroup: true }) }
  state(state: ChannelState) { this.reportState(state) }
  reconnect() { this.setAccepting(false); this.setAccepting(true); this.reportState('connected') }
  async lateIncoming(gate: Promise<void>) {
    return this.withConnection(async () => { await gate; return this.incoming() })
  }
  sessionId(chatId: string) { return this.logicalSessionId(chatId) }
}

async function runtime(t: TestContext, root: string, projectId: string, bots: number, platform: ChannelId = 'discord', actualIdentity?: string, scope?: ProjectScope) {
  const bus = new Bus()
  const store = new BotInstanceStore({ projectId, path: join(root, projectId, 'bots.json') })
  const instances = Array.from({ length: bots }, (_, index) => store.create(platform, `Bot ${index}`, platform === 'discord'
    ? { token: 'synthetic-token', enabled: true }
    : platform === 'qq' ? { appId: `${projectId}-${index}`, secret: 'synthetic-secret', enabled: true }
      : { appId: `${projectId}-${index}`, appSecret: 'synthetic-secret', enabled: true }))
  const received: InboundMessage[] = []
  const receivedScopes: Array<string | undefined> = []
  const created: BotChannel[] = []
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }), notifyUser: async () => {}, notifyParent: async () => {},
  })
  let promptInvalidations = 0
  const sessions: Pick<SessionManager, 'yields' | 'getActiveSession' | 'invalidateSystemPrompts'> = {
    yields, getActiveSession: () => undefined,
    invalidateSystemPrompts: () => { promptInvalidations++ },
  }
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace: join(root, projectId) } }), bus, sessions as SessionManager, async message => {
    received.push(message)
    receivedScopes.push(getProjectScope()?.projectId)
    return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
  }, { projectId, instanceStore: store, scope, factory: (id, _config, bot) => {
    assert.ok(bot)
    const channel = new BotChannel(id, bus, bot, actualIdentity)
    created.push(channel)
    return channel
  } })
  await manager.init()
  const app = new Hono()
  botSetupPlugin({ store, runtime: manager, authorize: request => request.headers.get('x-fixture-authorized') === 'yes' })(app)
  await manager.startAll(app)
  t.after(async () => {
    for (const channel of created) channel.failStop = false
    yields.stop()
    await manager.stopAll()
  })
  const address = (bot: BotInstance, chat = 'same-chat-id'): ChannelAddress => ({
    projectId, botInstanceId: bot.id, platform: bot.platform, conversationId: chat,
  })
  const outbound = (bot: BotInstance): OutboundMessage => ({
    channel: platform, chatId: 'same-chat-id', channelAddress: address(bot),
    event: 'response', content: bot.displayName, media: ['uploads/same-file.png'], done: true,
  })
  return { bus, store, instances, received, receivedScopes, created, manager, app, address, outbound, yields,
    promptInvalidations: () => promptInvalidations }
}

test('QQ per-bot trigger modes persist, reach the real adapter and can be reconfigured', async t => {
  const root = directory(t)
  const path = join(root, 'bots.json')
  const store = new BotInstanceStore({ projectId: 'A', path })
  const credentials = { appId: 'synthetic-app', secret: 'synthetic-secret', enabled: true }
  const mention = store.create('qq', 'Mention bot', credentials)
  const all = store.create('qq', 'All messages bot', { ...credentials, triggerMode: 'all' })
  assert.equal(store.status(mention.id).config.triggerMode, 'mention')
  assert.equal(new BotInstanceStore({ projectId: 'A', path }).status(all.id).config.triggerMode, 'all')
  assert.throws(() => store.update(all.id, { config: { triggerMode: 'invalid' } }), /invalid_channel_config/)
  const received: InboundMessage[] = []
  const manager = new ChannelManager(ConfigSchema.parse({}), new Bus(), {} as SessionManager, async message => {
    received.push(message)
    return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
  }, { projectId: 'A', instanceStore: store })
  await manager.init()
  t.after(() => manager.stopAll())
  const incoming = async (botId: string) => {
    const channel = manager['channels'].get(botId)
    assert.ok(channel instanceof QQChannel)
    await channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
      id: 'source', content: 'Context without a mention', group_openid: 'group',
      author: { member_openid: 'sender' }, timestamp: new Date().toISOString(),
    })
  }
  await incoming(mention.id)
  await incoming(all.id)
  assert.deepEqual(received.map(message => message.silent), [true, false])
  const saved = await manager.updateBot(all.id, { config: { triggerMode: 'mention' } })
  assert.equal(saved.config.triggerMode, 'mention')
  await incoming(all.id)
  assert.equal(received.at(-1)?.silent, true)
  assert.equal(new BotInstanceStore({ projectId: 'A', path }).status(all.id).config.triggerMode, 'mention')
})

test('trusted audiences are scoped to exact project, bot and conversation, never sender or admin status', async t => {
  const root = directory(t)
  const a = await runtime(t, root, 'A', 2)
  const b = await runtime(t, root, 'B', 1)
  const bot = a.instances[0]
  await a.manager.updateBot(bot.id, { config: { adminChats: ['same-chat-id'], allowFrom: ['alice'] } })
  assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id', a.address(bot)), false)
  assert.equal(a.promptInvalidations(), 0)
  const saved = await a.manager.updateBot(bot.id, { config: { trustedChats: ['same-chat-id'] } })
  assert.deepEqual(saved.config.trustedChats, ['same-chat-id'])
  assert.equal(a.promptInvalidations(), 1)
  assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id', a.address(bot)), true)
  for (const address of [
    a.address(a.instances[1]), b.address(b.instances[0]),
    { ...a.address(bot), conversationId: 'different' },
    { ...a.address(bot), platform: 'qq' },
    { ...a.address(bot), legacySessionId: true },
  ]) assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id', address), false)
  assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id'), false)
  assert.equal(a.manager.isTrustedConversation('discord', 'same-thread-id', a.address(bot, 'same-thread-id')), false)
  const loaded = new BotInstanceStore({ projectId: 'A', path: join(root, 'A', 'bots.json') })
  assert.deepEqual(loaded.get(bot.id).config.trustedChats, ['same-chat-id'])
  await a.manager.updateBot(bot.id, { config: { trustedChats: [] } })
  assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id', a.address(bot)), false)
  assert.equal(a.promptInvalidations(), 2)
  await a.manager.updateBot(bot.id, { config: { trustedChats: ['same-chat-id'] } })
  await a.manager.deleteBot(bot.id)
  assert.equal(a.manager.isTrustedConversation('discord', 'same-chat-id', a.address(bot)), false)
  assert.equal(a.promptInvalidations(), 4)
})

for (const platform of ['discord', 'qq', 'feishu'] as const) {
  test(`${platform}: two bots in A and one in B preserve identical conversation/message/media IDs without collisions`, async t => {
    const root = directory(t)
    const a = await runtime(t, root, 'A', 2, platform)
    const b = await runtime(t, root, 'B', 1, platform)
    const receipts = await Promise.all([...a.created, ...b.created].map(channel => channel.incoming()))
    assert.equal(new Set(receipts.map(receipt => receipt.sessionId)).size, 3)
    assert.deepEqual(a.received.map(message => message.channelAddress?.botInstanceId), a.instances.map(bot => bot.id))
    assert.equal(b.received[0]?.channelAddress?.projectId, 'B')
    assert.equal(a.received[0]?.admin, false)
    for (const f of [a, b]) for (const [index, bot] of f.instances.entries()) {
      const message = f.outbound(bot)
      await f.manager.deliver(message)
      assert.deepEqual(f.created[index].sent, [message])
      const input = channelMessageInput(f.received[index])
      assert.deepEqual(inputContext(receipts[f === a ? index : 2].sessionId, input).channelAddress, f.address(bot))
      assert.deepEqual(sessionReplyAddress(channelSessionId(f.address(bot)))?.channelAddress, f.address(bot))
      assert.equal(f.created[index].sessionId('same-chat-id'), channelSessionId(f.address(bot)))
      assert.equal(await f.manager.createThread(platform, 'same-chat-id', 'Child', f.address(bot)), 'same-thread-id')
    }
    await assert.rejects(a.manager.deliver(b.outbound(b.instances[0])), /unavailable/)
    await assert.rejects(a.manager.deliver({ ...a.outbound(a.instances[0]), channelAddress: undefined }), /unavailable/)
    await assert.rejects(a.manager.deliver({ ...a.outbound(a.instances[0]), chatId: 'other-chat' }), /Invalid/)
    assert.equal(a.created[1].sent.length, 1)
    await assert.rejects(a.created[0].capturedReceiver({
      ...a.received[0], channel: 'wrong',
    }), /identity mismatch/)
  })
}

test('bot manager scope injection owns callbacks and reconfiguration regardless of caller scope', async t => {
  const scope = createProjectScope('A')
  const foreign = createProjectScope('B')
  const f = await runtime(t, directory(t), 'A', 2, 'discord', undefined, scope)
  assert.throws(() => new ChannelManager(ConfigSchema.parse({}), new Bus(), {} as SessionManager,
    async () => ({ status: 'accepted', sessionId: 'unused', inputId: 'unused' }),
    { projectId: 'A', instanceStore: f.store, scope: foreign }), /scope mismatch/)
  await foreign.run(() => f.created[0].incoming())
  await foreign.run(() => f.manager.updateBot(f.instances[0].id, { config: { enabled: true } }))
  await foreign.run(() => f.created[2].incoming())
  assert.deepEqual(f.receivedScopes, ['A', 'A'])
  await foreign.run(() => f.manager.stopAll())
  scope.close()
  foreign.close()
})

test('Web bus callbacks retain org scope and stopping unsubscribes only their own handlers', async () => {
  const scope = createProjectScope('A')
  const foreign = createProjectScope('B')
  const bus = new Bus()
  const channel = scope.run(() => new WebChannel(bus, {}))
  const observed: Array<string | undefined> = []
  let otherCalls = 0
  const subscription = bus.on('message.outbound', () => { otherCalls++ })
  const message: OutboundMessage = {
    channel: 'web', chatId: 'chat', event: 'response', done: true,
    get content() { observed.push(getProjectScope()?.projectId); return 'Hello' },
  }
  foreign.run(() => bus.emit('message.outbound', message))
  assert.deepEqual(observed, ['A'])
  await channel.stop()
  scope.close()
  foreign.run(() => bus.emit('message.outbound', message))
  assert.deepEqual(observed, ['A'])
  assert.equal(otherCalls, 2)
  bus.off(subscription)
  foreign.close()
})

test('reconnect fences late callbacks and source-bot disable never falls back to its sibling', async t => {
  const f = await runtime(t, directory(t), 'A', 2)
  const old = f.created[0]
  const capturedReceiver = old.capturedReceiver
  const gate = Promise.withResolvers<void>()
  const late = old.lateIncoming(gate.promise)
  const rejected = assert.rejects(late, /connection has changed/)
  old.reconnect()
  gate.resolve()
  await rejected
  assert.equal(f.received.length, 0)
  await old.incoming()
  const message = f.received[0]
  await f.manager.updateBot(f.instances[0].id, { config: { enabled: true } })
  await assert.rejects(capturedReceiver(message), /unavailable/)
  old.state('error')
  assert.equal(f.manager.botStatuses()[0].state, 'connected')
  await f.manager.updateBot(f.instances[0].id, { config: { enabled: false } })
  await assert.rejects(f.manager.deliver(f.outbound(f.instances[0])), /unavailable/)
  await f.manager.deliver(f.outbound(f.instances[1]))
  assert.equal(f.created[1].sent.length, 1)
  const failure = Promise.withResolvers<unknown>()
  f.bus.on('channel.delivery.failed', event => failure.resolve(event))
  f.bus.emit('message.outbound', f.outbound(f.instances[0]))
  const event = await failure.promise
  assert.deepEqual(event, {
    projectId: 'A', channelAddress: f.address(f.instances[0]), channel: 'discord',
    chatId: 'same-chat-id', error: 'source_bot_unavailable',
  })
})

test('a reconnected bot rejects an in-flight media send and thread result from its previous generation', async t => {
  const f = await runtime(t, directory(t), 'A', 2)
  const channel = f.created[0]
  const sendGate = Promise.withResolvers<void>()
  const originalSend = channel.send.bind(channel)
  t.mock.method(channel, 'send', async (message: OutboundMessage) => {
    await sendGate.promise
    return originalSend(message)
  })
  const pendingSend = f.manager.deliver(f.outbound(f.instances[0]))
  const rejectedSend = assert.rejects(pendingSend, /connection has changed/)
  channel.reconnect()
  sendGate.resolve()
  await rejectedSend
  assert.equal(channel.sent.length, 0)
  const threadGate = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<void>()
  t.mock.method(channel, 'createThread', () => { entered.resolve(); return threadGate.promise })
  const thread = f.manager.createThread('discord', 'same-chat-id', 'Child', f.address(f.instances[0]))
  const rejectedThread = assert.rejects(thread, /connection has changed/)
  await entered.promise
  channel.reconnect()
  threadGate.resolve('late-thread')
  await rejectedThread
  assert.equal(f.created[1].sent.length, 0)
  assert.equal(f.created[1].threads.length, 0)
})

test('project shutdown drains queued bot replies before disconnecting their exact source', async t => {
  const f = await runtime(t, directory(t), 'A', 2)
  f.bus.emit('message.outbound', { ...f.outbound(f.instances[0]), content: 'First' })
  f.bus.emit('message.outbound', { ...f.outbound(f.instances[1]), content: 'Second' })
  await f.manager.stopAll()
  assert.deepEqual(f.created.map(channel => channel.sent.map(message => message.content)), [['First'], ['Second']])
  await assert.rejects(f.manager.deliver(f.outbound(f.instances[0])), /unavailable/)
  await assert.rejects(f.created[0].incoming(), /disconnected/)
})

test('yield answers stay with their source bot, user, project and generation', async t => {
  const root = directory(t)
  const a = await runtime(t, root, 'A', 2)
  const b = await runtime(t, root, 'B', 1)
  const ask = (f: typeof a, index: number) => {
    const sessionId = channelSessionId(f.address(f.instances[index]))
    const waiting = f.yields.ask(sessionId, {
      question: 'Proceed?', options: ['Yes', 'Change', 'Stop'], defaultOption: 'Yes',
    }, new AbortController().signal, { channel: 'discord', senderId: 'alice' })
    const request = f.yields.get(sessionId)!
    const click: ChannelDecision = { chatId: 'same-chat-id', senderId: 'alice', requestId: request.id, option: 2 }
    return { waiting, request, click }
  }
  const first = ask(a, 0)
  const second = ask(a, 1)
  const third = ask(b, 0)
  await a.manager.deliverDecision({ ...a.outbound(a.instances[0]), yieldRequest: first.request })
  assert.equal(a.created[0].decisions[0].id, first.request.id)
  assert.equal(a.created[1].decisions.length, 0)
  await assert.rejects(a.created[1].click(first.click), /no longer pending/)
  await assert.rejects(b.created[0].click(first.click), /no longer pending/)
  await assert.rejects(a.created[0].click({ ...first.click, senderId: 'mallory' }), /not authorized/)
  await a.created[0].click(first.click)
  assert.equal((await first.waiting).option, 'Change')
  await a.manager.updateBot(a.instances[1].id, { config: { enabled: true } })
  await assert.rejects(a.created[1].click(second.click), /disconnected/)
  await a.created[2].click(second.click)
  await b.created[0].click(third.click)
  assert.equal((await second.waiting).option, 'Change')
  assert.equal((await third.waiting).option, 'Change')
})

test('actual platform identity cannot be bound concurrently, including in another project', async t => {
  const root = directory(t)
  const a = await runtime(t, root, 'A', 2, 'discord', 'actual-bot')
  const b = await runtime(t, root, 'B', 1, 'discord', 'actual-bot')
  assert.equal(a.manager.botStatuses()[0].state, 'connected')
  assert.equal(a.manager.botStatuses()[1].state, 'error')
  assert.equal(b.manager.botStatuses()[0].state, 'error')
  assert.equal(b.manager.botStatuses()[0].message, 'bot_identity_already_bound')
  await assert.rejects(b.manager.deliver(b.outbound(b.instances[0])), /unavailable/)
  await a.manager.updateBot(a.instances[0].id, { config: { enabled: false } })
  await b.manager.updateBot(b.instances[0].id, { config: { enabled: true } })
  assert.equal(b.manager.botStatuses()[0].state, 'connected')
})

test('failed source cleanup blocks replacement and does not change sibling readiness', async t => {
  const f = await runtime(t, directory(t), 'A', 2)
  f.created[0].failStop = true
  await f.manager.updateBot(f.instances[0].id, { config: { token: 'new-synthetic-token' } })
  assert.equal(f.created.length, 2)
  assert.equal(f.manager.botStatuses()[0].state, 'restart-required')
  assert.equal(f.manager.botStatuses()[1].state, 'connected')
  await assert.rejects(f.manager.deleteBot(f.instances[0].id), /restart_required/)
  await assert.rejects(f.manager.deliver(f.outbound(f.instances[0])), /unavailable/)
  await assert.rejects(f.created[0].incoming(), /unavailable/)
})

test('default-org legacy migration preserves old logical IDs and disk secrets without cloning environment bootstrap', t => {
  const root = directory(t)
  const path = join(root, 'default', 'bots.json')
  const config = ConfigSchema.parse({ channels: {
    qq: { appId: 'qq-app', secret: 'synthetic-file-secret', enabled: true },
    discord: { token: 'synthetic-environment-token', enabled: true },
  } })
  const options = {
    projectId: 'default', path, legacyConfig: config,
    legacyRawChannels: { qq: config.channels.qq },
  }
  const store = new BotInstanceStore(options)
  assert.deepEqual(store.list().map(bot => bot.id), ['legacy-qq', 'legacy-discord'])
  assert.equal(store.get('legacy-discord').enabled, true)
  assert.equal(store.status('legacy-discord').secrets.token, true)
  assert.match(readFileSync(path, 'utf8'), /synthetic-file-secret/)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-environment-token/)
  store.update('legacy-discord', { config: { token: '', triggerMode: 'all' } })
  assert.equal(store.status('legacy-discord').secrets.token, true)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-environment-token/)
  assert.equal(new BotInstanceStore(options).get('legacy-discord').enabled, true)
  const bot = store.get('legacy-qq')
  assert.equal(channelSessionId({
    projectId: bot.projectId, botInstanceId: bot.id, platform: bot.platform,
    conversationId: 'group:historical-chat', legacySessionId: bot.legacySessionId,
  }), 'qq:group:historical-chat')
  const newOrg = new BotInstanceStore({ projectId: 'new', path: join(root, 'new', 'bots.json') })
  assert.deepEqual(newOrg.list(), [])
  assert.throws(() => new BotInstanceStore({ projectId: 'wrong', path }), /ownership/)
})

test('pristine default project has no legacy placeholders while explicit disabled settings are retained', t => {
  const root = directory(t)
  const freshOptions = {
    projectId: 'default', path: join(root, 'fresh', 'bots.json'),
    legacyConfig: ConfigSchema.parse({}), legacyRawChannels: {},
  }
  assert.deepEqual(new BotInstanceStore(freshOptions).list(), [])
  assert.deepEqual(new BotInstanceStore(freshOptions).list(), [])
  const configuredOptions = {
    projectId: 'default', path: join(root, 'configured', 'bots.json'),
    legacyConfig: ConfigSchema.parse({ channels: { feishu: { enabled: false, allowFrom: ['alice'] } } }),
    legacyRawChannels: { feishu: { enabled: false, allowFrom: ['alice'] } },
  }
  const configured = new BotInstanceStore(configuredOptions)
  assert.deepEqual(configured.list().map(bot => bot.id), ['legacy-feishu'])
  assert.equal(configured.get('legacy-feishu').enabled, false)
  assert.deepEqual(configured.get('legacy-feishu').config.allowFrom, ['alice'])
  configured.delete('legacy-feishu')
  assert.deepEqual(new BotInstanceStore(configuredOptions).list(), [])
})

test('org settings API validates ownership, redacts secrets, retains blanks and persists independent same-platform bots', async t => {
  const root = directory(t)
  const f = await runtime(t, root, 'A', 0)
  const headers = { 'content-type': 'application/json', 'x-fixture-authorized': 'yes' }
  assert.equal((await f.app.request('/api/channels')).status, 401)
  const post = (body: unknown) => f.app.request('/api/channels', { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await post({ projectId: 'B', platform: 'qq', displayName: 'Bad', config: {} })).status, 400)
  assert.equal((await post({ platform: 'qq', displayName: 'Bad', config: { enabled: true } })).status, 400)
  const responses = await Promise.all(['One', 'Two'].map((displayName, index) => post({
    platform: 'qq', displayName, config: { appId: `app-${index}`, secret: 'synthetic-secret', enabled: true },
  })))
  assert.deepEqual(responses.map(response => response.status), [201, 201])
  const bodies = await Promise.all(responses.map(response => response.json()))
  assert.notEqual(bodies[0].channel.id, bodies[1].channel.id)
  assert.equal(bodies[0].channel.projectId, 'A')
  assert.equal(bodies[0].channel.secrets.secret, true)
  assert.doesNotMatch(JSON.stringify(bodies), /synthetic-secret/)
  for (const secret of ['', '  ', REDACTED_SECRET]) {
    const response = await f.app.request(`/api/channels/${bodies[0].channel.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ displayName: 'Renamed', config: { secret } }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).channel.secrets.secret, true)
  }
  const response = await f.app.request('/api/channels', { headers })
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal((await response.json()).channels.length, 2)
  const reloaded = new BotInstanceStore({ projectId: 'A', path: join(root, 'A', 'bots.json') })
  assert.equal(reloaded.list()[0].displayName, 'Renamed')
  assert.equal((await f.app.request(`/api/channels/${bodies[0].channel.id}`, { method: 'DELETE', headers })).status, 200)
  assert.equal((await f.app.request(`/api/channels/${bodies[0].channel.id}`, {
    method: 'PATCH', headers, body: '{"config":{"enabled":true}}',
  })).status, 404)
  assert.equal(f.manager.botStatuses().length, 1)
})

test('real Feishu adapters isolate proxy credentials, identical inbound files, and late worker callbacks across three bots', async t => {
  const root = directory(t)
  const apps = { A: new Hono(), B: new Hono() }
  const scopes = { A: createProjectScope('A'), B: createProjectScope('B') }
  for (const app of Object.values(apps)) FeishuChannel.registerRoutes(app, true)
  const sent: Array<{ authorization: string | null; path: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (path.includes('/auth/')) {
      const body = JSON.parse(String(init?.body)) as { app_id: string }
      return Response.json({ code: 0, tenant_access_token: `synthetic-${body.app_id}`, expire: 7200 })
    }
    const authorization = new Headers(init?.headers).get('Authorization')
    if (path.includes('/resources/')) return new Response(authorization ?? 'missing')
    if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } })
    if (path.includes('/contact/')) return Response.json({ code: 0, data: { user: { name: 'Alice' } } })
    if (path.includes('/reactions')) return Response.json({ code: 0 })
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (init?.body instanceof FormData) {
      const file = init.body.get('file')
      if (file instanceof Blob) body.fileContent = await file.text()
    }
    sent.push({ authorization, path, body })
    if (path.endsWith('/files')) return Response.json({ code: 0, data: { file_key: 'uploaded-file' } })
    return Response.json({ code: 0, data: { message_id: 'om_same_outbound' } })
  })
  const specs = [{ projectId: 'A', botInstanceId: 'bot-one' }, { projectId: 'A', botInstanceId: 'bot-two' }, { projectId: 'B', botInstanceId: 'bot-three' }] as const
  const channels: FeishuChannel[] = []
  const events: Array<(event: Record<string, unknown>) => void> = []
  const received: InboundMessage[] = []
  for (const spec of specs) {
    const channel = scopes[spec.projectId].run(() => new FeishuChannel(new Bus(), {
      appId: spec.botInstanceId, appSecret: 'synthetic-secret', workspace: join(root, spec.projectId),
      transportFactory: (_options, onEvent, state): FeishuTransport => {
        events.push(onEvent)
        return { start: () => state('running'), stop: async () => {} }
      },
    }))
    channel.setBotScope({ ...spec, platform: 'feishu' })
    channel.setReceiver(async message => {
      assert.equal(getProjectScope(), scopes[spec.projectId])
      received.push(message)
      return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
    })
    channels.push(channel)
    await scopes[spec.projectId].run(() => channel.start(apps[spec.projectId]))
  }
  t.after(async () => {
    await Promise.all(channels.map(channel => channel.stop()))
    scopes.A.close()
    scopes.B.close()
  })
  assert.equal((await apps.A.request('/feishu/open-apis/example')).status, 503)
  assert.equal((await apps.A.request('/feishu/bots/bot-three/open-apis/example')).status, 503)
  for (const [index, spec] of specs.entries()) {
    const response = await apps[spec.projectId].request(`/feishu/bots/${spec.botInstanceId}/open-apis/example`)
    assert.equal(response.status, 200)
    assert.equal(sent.at(-1)?.authorization, `Bearer synthetic-${spec.botInstanceId}`)
    assert.equal(sent.at(-1)?.path, '/open-apis/example')
    scopes[spec.projectId === 'A' ? 'B' : 'A'].run(() => events[index]({
      sender: { sender_id: { open_id: 'alice' } },
      message: {
        message_id: 'om_same_inbound', chat_id: 'oc_same_chat', chat_type: 'p2p',
        message_type: 'file', content: '{"file_key":"same-file","file_name":"same.txt"}',
      },
    }))
  }
  for (let attempt = 0; attempt < 100 && received.length !== 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(received.length, 3)
  for (const [index, spec] of specs.entries()) {
    const address = { ...spec, platform: 'feishu', conversationId: 'oc_same_chat' }
    const path = join(sessionWorkspacePath(join(root, spec.projectId), channelSessionId(address)), 'uploads', 'same.txt')
    assert.equal(readFileSync(path, 'utf8'), `Bearer synthetic-${spec.botInstanceId}`)
    const message = received.find(message => message.channelAddress?.botInstanceId === spec.botInstanceId)!
    assert.deepEqual(message.channelAddress, address)
    assert.deepEqual(message.media, ['uploads/same.txt'])
    await channels[index].send({
      channel: 'feishu', chatId: address.conversationId, channelAddress: address,
      event: 'response', content: spec.botInstanceId, media: ['uploads/same.txt'], done: true,
    })
    const upload = sent.findLast(request => request.path.endsWith('/files'))
    assert.equal(upload?.authorization, `Bearer synthetic-${spec.botInstanceId}`)
    assert.equal(upload?.body.fileContent, `Bearer synthetic-${spec.botInstanceId}`)
    const reply = sent.at(-1)!
    assert.equal(reply.authorization, `Bearer synthetic-${spec.botInstanceId}`)
    assert.equal(reply.body.receive_id, 'oc_same_chat')
    assert.equal(reply.body.msg_type, 'file')
  }
  await channels[0].stop()
  assert.equal((await apps.A.request('/feishu/bots/bot-one/open-apis/example')).status, 503)
  assert.equal((await apps.A.request('/feishu/bots/bot-two/open-apis/example')).status, 200)
  events[0]({
    sender: { sender_id: { open_id: 'alice' } },
    message: { message_id: 'om_late', chat_id: 'oc_same_chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"late"}' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.length, 3)
})
