import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import { AbstractChannel } from '../channels/base.ts'
import { BotInstanceStore, type BotInstance } from '../channels/bot-store.ts'
import { DiscordChannel, type DiscordChannelOptions } from '../channels/discord.ts'
import { DiscordPermission as P } from '../channels/discord-permissions.ts'
import { ChannelManager } from '../channels/manager.ts'
import type { ChannelOperationContext } from '../channels/operations.ts'
import type { ChannelId } from '../channels/setup-contract.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { channelMessageInput, inputContext } from '../sessions/input.ts'
import type { ExecutionContext } from './context.ts'
import { channelTools, ChannelOperationsTool, DiscordHistoryTool, DiscordMessageGetTool } from './channel.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { requireToolText } from './tool.ts'

class ReadyDiscord extends DiscordChannel {
  constructor(bus: Bus, private readonly bot: BotInstance, options: DiscordChannelOptions) {
    super(bus, options)
  }
  override async start() {
    this.setAccepting(true)
    this.reportIdentity(this.bot.id)
    this.reportState('connected')
  }
  reconnect() { this.setAccepting(false); this.setAccepting(true); this.reportState('connected') }
  state(state: 'connected' | 'disconnected' | 'error') { this.reportState(state) }
}

class OtherChannel extends AbstractChannel {
  update = undefined
  constructor(readonly name: ChannelId, bus: Bus, bot: BotInstance) { super(bus, bot.config.allowFrom) }
  async start() { this.setAccepting(true); this.reportState('connected') }
  async stop() { this.setAccepting(false); this.reportState('disconnected') }
  async send(): Promise<string | null> { throw new Error('Read tools must not send messages') }
}

function message(id = '800', channel = '100', content = 'Historical message') {
  return {
    id, channel_id: channel, type: 0, content,
    author: { id: '500', username: 'writer', global_name: 'Writer', avatar: 'not-returned' },
    timestamp: '2026-10-04T01:00:00+00:00', edited_timestamp: null,
    attachments: [], embeds: [], secret_property: 'not-returned',
  }
}

async function fixture(t: TestContext, platform: ChannelId = 'discord', count = 1, projectId = 'A', legacy = false) {
  const base = join(process.cwd(), '.test-data')
  await mkdir(base, { recursive: true })
  const workspace = await mkdtemp(join(base, 'channel-tools-'))
  const bus = new Bus()
  const config = ConfigSchema.parse({ agent: { workspace }, channels: legacy ? {
    discord: { enabled: true, token: 'synthetic-legacy', allowFrom: ['400'] },
  } : {} })
  const store = new BotInstanceStore({
    projectId, path: join(workspace, 'bots.json'),
    ...(legacy ? { legacyConfig: config, legacyRawChannels: config.channels } : {}),
  })
  const bots = legacy ? store.list() : Array.from({ length: count }, (_, index) => store.create(platform, `Bot ${index}`, {
    enabled: true, allowFrom: ['400'],
    ...(platform === 'discord' ? { token: `synthetic-${projectId}-${index}` }
      : { appId: `synthetic-${projectId}-${index}`, ...(platform === 'qq' ? { secret: 'synthetic' } : { appSecret: 'synthetic' }) }),
  }))
  const created: ReadyDiscord[] = []
  const manager = new ChannelManager(config, bus, {} as SessionManager, async () => {
    throw new Error('Read tools must not admit new messages')
  }, { projectId, instanceStore: store, factory: (name, config, bot) => {
    assert.ok(bot)
    if (name !== 'discord') return new OtherChannel(name, bus, bot)
    assert.ok(config.channels.discord)
    assert.ok(config.channels.discord.token)
    const channel = new ReadyDiscord(bus, bot, { ...config.channels.discord, token: config.channels.discord.token })
    created.push(channel)
    return channel
  } })
  t.after(async () => { await manager.stopAll(); await rm(workspace, { recursive: true, force: true }) })
  await manager.init()
  await manager.startAll(new Hono())
  const baseTools = new Tools(workspace)
  baseTools.register({
    name: 'read', description: 'Fixture metadata discovery admission.',
    parameters: { type: 'object', properties: {} },
    async execute() { throw new Error('This fixture reads metadata through ImportTool') },
  })
  const importer = new ImportTool(new Map(), workspace)
  for (const tool of channelTools(manager)) importer.registerBuiltin(tool.name, tool)
  const invoke = new InvokeTool(importer)
  baseTools.register(invoke)
  baseTools.register(importer)
  const tools = new SessionTools(baseTools, workspace)
  t.after(() => tools.resetDynamic())
  const context = (bot = bots[0], chatId = '100'): ExecutionContext => {
    const channelAddress: ChannelAddress = {
      projectId, botInstanceId: bot.id, platform, conversationId: chatId,
      ...(bot.legacySessionId ? { legacySessionId: true } : {}),
    }
    return {
      projectId, channelAddress, channel: platform, chatId, sessionId: channelSessionId(channelAddress),
      physicalSessionId: 'physical', inputSource: 'user', senderId: '400', messageId: 'input',
      admin: false, tools, signal: new AbortController().signal,
    }
  }
  const destination: Record<string, unknown> = { id: '100', type: 0, guild_id: '200', permission_overwrites: [] }
  const parent: Record<string, unknown> = { id: '101', type: 0, guild_id: '200', permission_overwrites: [] }
  const roles = [{ id: '200', permissions: String(P.view | P.readHistory) }]
  const actor: Record<string, unknown> = { user: { id: '400', bot: false }, roles: [] }
  const botMember = { user: { id: '300', bot: true }, roles: [] }
  let history: unknown = [message('800'), message('799')]
  let single: unknown = message()
  const calls: Array<{ url: URL; token: string; signal: AbortSignal }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal)
    assert.equal(init.method ?? 'GET', 'GET')
    const url = new URL(String(input))
    const path = url.pathname.replace('/api/v10', '')
    const token = new Headers(init.headers).get('Authorization')!
    calls.push({ url, token, signal: init.signal })
    if (path === '/channels/100/messages') return Response.json(history)
    if (path === '/channels/100/messages/800') return Response.json(single)
    const data = ({
      '/channels/100': destination, '/channels/101': parent, '/users/@me': { id: '300', bot: true },
      '/guilds/200': { id: '200', owner_id: '999' }, '/guilds/200/roles': roles,
      '/guilds/200/members/300': botMember, '/guilds/200/members/400': actor,
    } as Record<string, unknown>)[path]
    assert.ok(data, `Unexpected request ${path}`)
    return Response.json(data)
  })
  return { manager, store, bots, created, importer, invoke, baseTools, tools, workspace, context,
    destination, parent, roles, actor, botMember, calls,
    history(value: unknown) { history = value }, single(value: unknown) { single = value },
    discovery: new ChannelOperationsTool(manager), historyTool: new DiscordHistoryTool(manager),
    messageTool: new DiscordMessageGetTool(manager) }
}

test('channel tools are discovered lazily, not added to base tools or granted by importing', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.baseTools.names().sort(), ['import_tool', 'invoke_tool', 'read'])
  const contract = await f.importer.readVirtual('discord_history/discord_history', f.context())
  assert.match(contract, /current conversation/i)
  assert.match(contract, /"maximum":\s*100/)
  assert.equal(f.calls.length, 0)
  assert.match(await f.importer.execute({ source: 'v:tools/discord_history' }, f.context()), /discord_history/)
  assert.equal(f.tools.hasDynamic('discord_history'), true)
  assert.equal(f.calls.length, 0)
  const operations = JSON.parse(await f.discovery.execute({}, f.context()))
  assert.deepEqual(operations.operations, ['discord_history', 'discord_message_get'])
  assert.match(operations.authorization, /not permission/)
  assert.equal(f.calls.length, 0)
  f.roles[0].permissions = String(P.view)
  const result = requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context()))
  assert.match(result, /^Error executing discord_history:.*Read Message History/)
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/messages')), false)
})

test('history and single-message tools use only the current bot/conversation, preserving native IDs and bounded pages', async t => {
  const f = await fixture(t, 'discord', 2)
  const history = JSON.parse(await f.historyTool.execute({ limit: 2, before: '801' }, f.context(f.bots[1])))
  assert.equal(history.conversationId, '100')
  assert.equal(history.order, 'newest_first')
  assert.equal(history.nextBefore, '799')
  assert.deepEqual(history.messages.map((item: { id: string }) => item.id), ['800', '799'])
  assert.deepEqual(history.messages[0].author, { id: '500', name: 'Writer', bot: false })
  assert.equal(history.messages[0].contentAvailability, 'present')
  assert.equal(history.messages[0].secret_property, undefined)
  assert.equal(history.messages[0].author.avatar, undefined)
  assert.ok(f.calls.every(call => call.token === 'Bot synthetic-A-1'))
  assert.equal(f.calls.at(-1)?.url.search, '?limit=2&before=801')
  f.calls.length = 0
  const single = JSON.parse(await f.messageTool.execute({ messageId: '800' }, f.context()))
  assert.equal(single.message.id, '800')
  assert.ok(f.calls.every(call => call.token === 'Bot synthetic-A-0'))
  assert.equal(f.calls.at(-1)?.url.pathname, '/api/v10/channels/100/messages/800')
  f.calls.length = 0
  f.history([])
  assert.deepEqual(JSON.parse(await f.historyTool.execute({}, f.context())).messages, [])
  assert.equal(f.calls.at(-1)?.url.search, '?limit=20')
  f.tools.resetDynamic()
  assert.equal(f.tools.hasDynamic('discord_history'), false)
})

test('successful lazy invocation honors the maximum page size and projects only validated message fields', async t => {
  const f = await fixture(t)
  const lazy = JSON.parse(requireToolText(await f.invoke.execute({ name: 'discord_history', args: { limit: 2 } }, f.context())))
  assert.equal(f.tools.hasDynamic('discord_history'), true)
  assert.equal(lazy.messages.length, 2)
  f.history(Array.from({ length: 100 }, (_, index) => message(String(800 - index))))
  const result = JSON.parse(await f.historyTool.execute({ limit: 100 }, f.context()))
  assert.equal(result.messages.length, 100)
  assert.equal(result.nextBefore, '701')
  assert.equal(f.calls.at(-1)?.url.search, '?limit=100')
  f.single({
    ...message(),
    attachments: [{ id: '600', filename: 'notes.txt', size: 128, content_type: 'text/plain',
      url: 'https://cdn.discordapp.com/attachments/100/600/notes.txt', proxy_url: 'not-returned' }],
    embeds: [{ title: 'Link', description: 'Summary', url: 'http://example.com/',
      fields: [{ name: 'Field', value: 'Text' }], provider: { name: 'not-returned' } }],
    message_reference: { message_id: '700', channel_id: '100', guild_id: '200' },
  })
  const single = JSON.parse(requireToolText(await f.invoke.execute({ name: 'discord_message_get', args: { messageId: '800' } }, f.context())))
  assert.equal(single.message.attachments[0].mime, 'text/plain')
  assert.equal(single.message.attachments[0].proxy_url, undefined)
  assert.equal(single.message.embeds[0].url, 'http://example.com/')
  assert.equal(single.message.embeds[0].provider, undefined)
  assert.deepEqual(single.message.replyTo, { messageId: '700', conversationId: '100' })
  assert.ok(f.calls.every(call => call.url.hostname === 'discord.com'), 'Attachments and external embed URLs are not fetched')
})

test('all tool contracts reject target/credential injection and invalid message IDs or pagination before fetching', async t => {
  const f = await fixture(t)
  for (const args of [
    { botInstanceId: f.bots[0].id }, { conversationId: 'elsewhere' }, { channelId: 'elsewhere' },
    { projectId: 'A' }, { token: 'synthetic' }, { senderId: '400' }, { sessionId: f.context().sessionId },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { before: '../other' },
    { after: '800' }, { before: '8'.repeat(21) },
  ]) await assert.rejects(f.historyTool.execute(args, f.context()))
  for (const args of [{}, { messageId: 800 }, { messageId: '800?other' }, { messageId: '800', channelId: '101' }]) {
    await assert.rejects(f.messageTool.execute(args, f.context()))
  }
  await assert.rejects(f.discovery.execute({ platform: 'discord' }, f.context()))
  assert.equal(f.calls.length, 0)
  const denied = requireToolText(await f.invoke.execute({ name: 'discord_history', args: { limit: 101 } }, f.context()))
  assert.match(denied, /invalid arguments/)
  assert.equal(f.calls.length, 0)
})

test('every operation requires current project, bot root, admitted human and local workdir even after import', async t => {
  const f = await fixture(t, 'discord', 2)
  await f.importer.execute({ source: 'v:tools/discord_history' }, f.context())
  const own = f.context()
  const foreign = await fixture(t, 'discord', 1, 'B')
  const invalid: ChannelOperationContext[] = [
    { ...own, projectId: undefined }, { ...own, projectId: 'B' },
    { ...own, channelAddress: undefined }, { ...own, channelAddress: foreign.context().channelAddress },
    { ...own, channelAddress: { ...own.channelAddress!, botInstanceId: f.bots[1].id } },
    { ...own, channelAddress: { ...own.channelAddress!, conversationId: '101' } },
    { ...own, channelAddress: { ...own.channelAddress!, platform: 'qq' } },
    { ...own, channelAddress: { ...own.channelAddress!, legacySessionId: true } },
    { ...own, sessionId: 'web:owner' }, { ...own, sessionId: `${own.sessionId}/child` },
    { ...own, channel: 'qq' }, { ...own, chatId: '101' },
    { ...own, inputSource: 'session' }, { ...own, inputSource: 'event' }, { ...own, inputSource: undefined },
    { ...own, senderId: 'mallory', admin: true }, { ...own, senderId: '' },
    { ...own, remoteWorkdir: { nodeId: 'remote', capabilityId: 'opaque', executor: {} } },
    { ...own, signal: AbortSignal.abort(new Error('cancelled')) },
  ]
  for (const context of invalid) {
    await assert.rejects(f.historyTool.execute({}, context))
    await assert.rejects(f.messageTool.execute({ messageId: '800' }, context))
    await assert.rejects(f.discovery.execute({}, context))
  }
  assert.equal(f.calls.length, 0)
  assert.equal(foreign.calls.length, 0)
})

test('migrated legacy bots keep exact current-bot scoping without default-platform fallback', async t => {
  const f = await fixture(t, 'discord', 1, 'A', true)
  assert.equal(f.context().sessionId, 'discord:100')
  assert.equal(JSON.parse(await f.historyTool.execute({}, f.context())).messages.length, 2)
  const own = f.context()
  await assert.rejects(f.historyTool.execute({}, { ...own, channelAddress: undefined }), /current bot/)
  await assert.rejects(f.historyTool.execute({}, { ...own, channelAddress: { ...own.channelAddress!, legacySessionId: false } }), /current bot|unavailable/)
})

for (const platform of ['qq'] as const) {
  test(`${platform} does not advertise or emulate unimplemented Discord history operations`, async t => {
    const f = await fixture(t, platform)
    const list = JSON.parse(await f.discovery.execute({}, f.context()))
    assert.equal(list.platform, platform)
    assert.deepEqual(list.operations, [])
    await f.importer.execute({ source: 'v:tools/discord_history' }, f.context())
    const result = requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context()))
    assert.match(result, new RegExp(`not implemented for ${platform}`))
    await assert.rejects(f.messageTool.execute({ messageId: '800' }, f.context()), /not implemented/)
    assert.equal(f.calls.length, 0)
  })
}

test('Discord bot and requesting human permissions are refreshed independently of output capabilities or admin hints', async t => {
  const f = await fixture(t)
  await f.created[0].getCapabilities('100')
  assert.equal(JSON.parse(await f.historyTool.execute({}, f.context())).messages.length, 2)
  for (const permission of [P.view, P.readHistory]) {
    f.calls.length = 0
    f.roles[0].permissions = String((P.view | P.readHistory) & ~permission)
    await assert.rejects(f.historyTool.execute({}, { ...f.context(), admin: true }), /bot lacks/)
    assert.equal(f.calls.some(call => call.url.pathname.endsWith('/messages')), false)
  }
  f.roles[0].permissions = String(P.view | P.readHistory)
  f.destination.permission_overwrites = [{ id: '400', type: 1, allow: '0', deny: String(P.readHistory) }]
  f.calls.length = 0
  await assert.rejects(f.historyTool.execute({}, { ...f.context(), admin: true }), /sender lacks/)
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/messages')), false)
  f.destination.permission_overwrites = []
  assert.equal(JSON.parse(await f.messageTool.execute({ messageId: '800' }, f.context())).message.id, '800')
  f.actor.user = { id: '401' }
  await assert.rejects(f.historyTool.execute({}, f.context()), /sender membership/)
  f.actor.user = { id: '400', bot: true }
  await assert.rejects(f.historyTool.execute({}, f.context()), /sender membership/)
})

test('Discord public-thread reads inherit parent permission overwrites; private threads are explicitly unsupported', async t => {
  const f = await fixture(t)
  f.destination.type = 11
  f.destination.parent_id = '101'
  f.destination.thread_metadata = { archived: true, locked: true }
  assert.equal(JSON.parse(await f.historyTool.execute({}, f.context())).messages.length, 2)
  f.parent.permission_overwrites = [{ id: '400', type: 1, allow: '0', deny: String(P.view) }]
  f.calls.length = 0
  await assert.rejects(f.historyTool.execute({}, f.context()), /sender lacks/)
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/messages')), false)
  for (const type of [12, 2, 3, 15, '0']) {
    f.destination.type = type
    f.calls.length = 0
    await assert.rejects(f.historyTool.execute({}, f.context()), /not implemented/)
    assert.equal(f.calls.length, 1)
  }
})

test('a native Discord thread child session reads its own bound thread, not the parent conversation', async t => {
  const f = await fixture(t)
  const own = f.context()
  const parent = { ...own.channelAddress!, conversationId: '101' }
  const state: SessionState = {
    sessionId: own.sessionId, segmentIndex: 0, parentSessionId: channelSessionId(parent),
    parent: { id: channelSessionId(parent) },
  }
  f.destination.type = 11
  f.destination.parent_id = '101'
  const input = channelMessageInput({ ...own, content: 'Read this thread', timestamp: new Date().toISOString(), platformMessageId: '800' })
  const context = { ...own, ...inputContext(state.sessionId, input), inputSource: 'user' as const }
  const result = JSON.parse(await f.historyTool.execute({}, context))
  assert.equal(result.conversationId, '100')
  assert.ok(f.calls.some(call => call.url.pathname === '/api/v10/channels/100/messages'))
  assert.equal(f.calls.some(call => call.url.pathname === '/api/v10/channels/101/messages'), false)
  await assert.rejects(f.historyTool.execute({}, { ...context, sessionId: 'virtual:child', inputSource: 'session' }), /current bot conversation/)
})

test('Discord DMs verify the current recipient instead of inheriting guild-wide read access', async t => {
  const f = await fixture(t)
  delete f.destination.guild_id
  f.destination.type = 1
  f.destination.recipients = [{ id: '400', bot: false }]
  const result = JSON.parse(await f.historyTool.execute({}, f.context()))
  assert.equal(result.messages.length, 2)
  assert.equal(f.calls.length, 2)
  for (const recipients of [undefined, [], [{ id: '401' }], [{ id: '400', bot: true }], [{ id: '400' }, { id: '401' }]]) {
    f.destination.recipients = recipients
    await assert.rejects(f.historyTool.execute({}, f.context()), /DM does not belong/)
  }
})

test('malformed, oversized, cross-channel and wrong-message responses fail explicitly; empty content is not claimed readable', async t => {
  const f = await fixture(t)
  for (const history of [{}, [message('800', '101')], [message('799'), message('800')], [message(), message()],
    [message(), { ...message('799'), author: null }], [message(), { ...message('799'), content: 'x'.repeat(4001) }],
  ]) {
    f.history(history)
    await assert.rejects(f.historyTool.execute({}, f.context()), /Invalid Discord/)
  }
  f.history([message(), message('799')])
  await assert.rejects(f.historyTool.execute({ limit: 1 }, f.context()), /Invalid Discord/)
  await assert.rejects(f.historyTool.execute({ before: '799' }, f.context()), /cursor/)
  for (const single of [message('801'), message('800', '101'), { ...message(), attachments: [{}] }]) {
    f.single(single)
    await assert.rejects(f.messageTool.execute({ messageId: '800' }, f.context()), /Invalid Discord/)
  }
  f.single(message('800', '100', ''))
  const result = JSON.parse(await f.messageTool.execute({ messageId: '800' }, f.context()))
  assert.equal(result.message.contentAvailability, 'empty_or_unavailable')
  assert.match(result.contentNotice, /intent/)
  assert.match(result.contentNotice, /external data/)
  const { content: _content, attachments: _attachments, embeds: _embeds, ...omitted } = message()
  f.single(omitted)
  const restricted = JSON.parse(await f.messageTool.execute({ messageId: '800' }, f.context()))
  assert.equal(restricted.message.content, null)
  assert.equal(restricted.message.contentAvailability, 'unavailable')
  assert.equal(restricted.message.attachments, null)
  assert.equal(restricted.message.embeds, null)
})

test('platform errors and rate limits remain errors and never become empty history or trigger replay', async t => {
  const f = await fixture(t)
  for (const status of [403, 404, 429, 500]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'synthetic-private-error' }, { status }))
    await assert.rejects(f.historyTool.execute({}, f.context()), new RegExp(`status=${status}`))
    assert.equal(fetch.mock.callCount(), 1)
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-token-credential-url') })
  await assert.rejects(f.historyTool.execute({}, f.context()), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Channel request failed/)
    assert.ok(!error.message.includes('synthetic-token'))
    return true
  })
  t.mock.method(globalThis, 'fetch', async () => new Response('synthetic-token-private-response', { status: 200 }))
  await assert.rejects(f.historyTool.execute({}, f.context()), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Invalid Discord JSON response')
    return true
  })
})

test('imported tools recheck live allowlists, disconnects, replacement, deletion and agent tool filtering', async t => {
  const f = await fixture(t, 'discord', 2)
  await f.importer.execute({ source: 'v:tools/discord_history' }, f.context())
  await f.manager.updateBot(f.bots[0].id, { config: { allowFrom: ['401'] } })
  assert.match(requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context())), /Sender is not authorized/)
  await f.manager.updateBot(f.bots[0].id, { config: { allowFrom: ['400'] } })
  f.created.at(-1)!.state('disconnected')
  assert.match(requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context())), /unavailable/)
  f.created.at(-1)!.state('connected')
  const filtered = new SessionTools(f.baseTools, f.workspace, undefined, ['discord_history'])
  filtered.registerDynamic(f.historyTool)
  assert.match(requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, { ...f.context(), tools: filtered })), /not available/)
  await f.manager.updateBot(f.bots[0].id, { config: { enabled: false } })
  assert.match(requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context())), /unavailable/)
  await f.manager.deleteBot(f.bots[0].id)
  assert.match(requireToolText(await f.invoke.execute({ name: 'discord_history', args: {} }, f.context())), /unavailable/)
  assert.equal(f.calls.length, 0, 'A sibling bot must never be a fallback')
})

test('an aborted invocation cannot return a late API result even if the transport ignores cancellation', async t => {
  const f = await fixture(t)
  const originalFetch = globalThis.fetch
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith('/messages')) {
      signal = init?.signal
      entered.resolve()
      return response.promise
    }
    return originalFetch(input, init)
  })
  const controller = new AbortController()
  const pending = f.historyTool.execute({}, { ...f.context(), signal: controller.signal })
  const rejected = assert.rejects(pending, /cancelled/)
  await entered.promise
  controller.abort(new Error('cancelled'))
  assert.equal(signal?.aborted, true)
  response.resolve(Response.json([message()]))
  await rejected
})

for (const action of ['reconnect', 'replace', 'stop'] as const) {
  test(`${action} invalidates an in-flight read without using another bot or releasing late data`, async t => {
    const f = await fixture(t, 'discord', 2)
    const originalFetch = globalThis.fetch
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/messages')) {
        signal = init?.signal
        entered.resolve()
        return response.promise
      }
      return originalFetch(input, init)
    })
    const pending = f.historyTool.execute({}, f.context())
    const rejected = assert.rejects(pending, /connection has changed|disconnected/)
    await entered.promise
    if (action === 'reconnect') f.created[0].reconnect()
    else if (action === 'replace') await f.manager.updateBot(f.bots[0].id, { config: { token: 'synthetic-replacement' } })
    else await f.manager.stopAll()
    assert.equal(signal?.aborted, true)
    response.resolve(Response.json([message()]))
    await rejected
    assert.ok(f.calls.every(call => call.token === 'Bot synthetic-A-0'))
  })
}
