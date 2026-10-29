import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { DiscordChannel } from './discord.ts'
import { discordDirectory, discordMembers, inspectDiscordConversation, type DiscordApi } from './discord-directory.ts'
import { DiscordPermission as P } from './discord-permissions.ts'
import type { InboundMessage } from '../bus/events.ts'
import type { DiscordLocation } from './integration-contract.ts'
import { Hono } from 'hono'
import { ChannelConnectionError } from './base.ts'

const signal = () => new AbortController().signal

test('Discord startup distinguishes safe credential and network errors without exposing tokens', async t => {
  for (const status of [401, 403, 500, 0]) {
    const adapter = new DiscordChannel(new Bus(), { token: 'SYNTHETIC_PRIVATE_TOKEN' })
    t.after(() => adapter.stop())
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      if (!status) throw new Error('Network failed with SYNTHETIC_PRIVATE_TOKEN in headers')
      return new Response('SYNTHETIC_PRIVATE_TOKEN', { status })
    })
    await assert.rejects(adapter.start(new Hono()), error => {
      assert(error instanceof ChannelConnectionError)
      assert.equal(error.code, status === 401 ? 'authentication' : status === 403 ? 'permission' : status ? 'gateway' : 'network')
      assert(!error.message.includes('SYNTHETIC_PRIVATE_TOKEN'))
      return true
    })
    mock.mock.restore()
  }
})
const permissions = (P.view | P.send | P.readHistory | P.sendInThreads).toString()
const channel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'help', guild_id: '100', type: 0, parent_id: null, permission_overwrites: [], ...extra,
})
function dispatch(adapter: DiscordChannel, event: string, data: Record<string, unknown>) {
  return (adapter as unknown as {
    handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
  }).handleDispatch(event, data)
}
const location: DiscordLocation = {
  id: '201', name: 'Named support channel', type: 0, guildId: '100', guildName: 'Our server',
  parentId: null, parentName: null, recipientId: null,
}

function fixture() {
  const values = new Map<string, unknown>([
    ['/users/@me', { id: '900', username: 'helper', bot: true }],
    ['/users/@me/guilds?limit=200', [{ id: '100', name: 'Our server', icon: null }]],
    ['/guilds/100', { id: '100', name: 'Our server', owner_id: '999' }],
    ['/guilds/100/roles', [{ id: '100', name: '@everyone', permissions: '0' }, { id: '700', name: 'Support', permissions }]],
    ['/guilds/100/members/900', { user: { id: '900', username: 'helper', bot: true }, roles: ['700'] }],
    ['/guilds/100/members/500', { user: { id: '500', username: 'sam', global_name: 'Sam' }, roles: ['700'], nick: 'Support Sam' }],
    ['/guilds/100/channels', [channel('201'), channel('202'), channel('203', { type: 15 })]],
    ['/guilds/100/threads/active', { threads: [
      channel('301', { type: 11, parent_id: '201', thread_metadata: { archived: false, locked: false } }),
      channel('302', { type: 12, parent_id: '201', thread_metadata: { archived: false, locked: false } }),
    ] }],
    ['/channels/201', channel('201')],
    ['/channels/301', channel('301', { type: 11, parent_id: '201', thread_metadata: { archived: false, locked: false } })],
  ])
  const calls: string[] = []
  const api: DiscordApi = async (path, init) => {
    assert(init?.signal)
    assert(!init.method || init.method === 'GET', 'Discovery never performs platform writes')
    calls.push(path)
    if (!values.has(path)) throw new Error(`Unavailable synthetic API: ${path}`)
    return structuredClone(values.get(path))
  }
  return { values, api, calls }
}

test('directory discovers names before any messages, preserves duplicate names and marks unsupported types', async () => {
  const f = fixture()
  const result = await discordDirectory(f.api, signal(), '100')
  assert.equal(result.botUserId, '900')
  assert.equal(result.guilds[0].name, 'Our server')
  assert.equal(result.channels.filter(item => item.name === 'help').length, 5)
  assert.equal(result.channels.find(item => item.id === '301')?.parentId, '201')
  assert.equal(result.channels.find(item => item.id === '302')?.supported, false)
  assert.equal(result.channels.find(item => item.id === '203')?.supported, true, 'Forums are assignable containers')
  assert.equal(result.completeness, 'channels-and-active-threads')
  assert.match(result.notice, /Archived and private/)
  assert(!f.calls.some(path => path.includes('/messages')))
})

test('forum assignment checks thread reply permission, never treating the parent as a message destination', async t => {
  const f = fixture()
  const forum = channel('203', { type: 15 })
  f.values.set('/channels/203', forum)
  f.values.set('/guilds/100/roles', [{ id: '100', name: '@everyone', permissions: '0' },
    { id: '700', name: 'Support', permissions: (P.view | P.readHistory | P.sendInThreads).toString() }])
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => adapter.stop())
  t.mock.method(adapter, 'directory', async () => discordDirectory(f.api, signal(), '100'))
  const target = { kind: 'channel' as const, guildId: '100', channelId: '203' }
  assert.equal((await adapter.inspectTarget(target, signal())).botUserId, '900',
    'Replying in existing posts does not require permission to create posts')
  await assert.rejects(inspectDiscordConversation(f.api, '203', '500', signal()), /not supported/,
    'A forum parent is never a direct conversation')
  f.values.set('/guilds/100/roles', [{ id: '100', name: '@everyone', permissions: '0' },
    { id: '700', name: 'Support', permissions: (P.view | P.send | P.readHistory).toString() }])
  const denied = (await discordDirectory(f.api, signal(), '100')).channels.find(item => item.id === '203')!
  assert.equal(denied.supported, true)
  assert.equal(denied.canSend, false, 'Creating posts is not permission to reply in threads')
  await assert.rejects(adapter.inspectTarget(target, signal()), /permission/)
})

test('forum posts enforce live parent overwrites, visibility, timeout and archive/lock state', async () => {
  const f = fixture()
  const forum = channel('203', { type: 15, name: 'Questions' })
  const post = channel('303', { type: 11, parent_id: '203', thread_metadata: { archived: false, locked: false } })
  f.values.set('/channels/203', forum)
  f.values.set('/channels/303', post)
  f.values.set('/guilds/100/threads/active', { threads: [post] })
  const inspect = () => inspectDiscordConversation(f.api, '303', '500', signal())
  const initial = await inspect()
  assert.equal(initial.location.parentName, 'Questions')
  assert.equal(initial.location.parentId, '203')
  assert.equal(initial.canSend, true)
  for (const actor of ['500', '900']) {
    for (const [permission, field] of [[P.sendInThreads, 'canSend'], [P.view, 'canView'], [P.readHistory, 'canReadHistory']] as const) {
      f.values.set('/channels/203', { ...forum, permission_overwrites: [
        { id: actor, type: 1, deny: permission.toString(), allow: '0' },
      ] })
      assert.equal((await inspect())[field], false, `${actor} must retain ${field}`)
    }
    f.values.set('/channels/203', forum)
    const memberPath = `/guilds/100/members/${actor}`
    const member = f.values.get(memberPath) as Record<string, unknown>
    f.values.set(memberPath, { ...member, communication_disabled_until: new Date(Date.now() + 60_000).toISOString() })
    assert.equal((await inspect()).canSend, false)
    if (actor === '900') assert.equal((await discordDirectory(f.api, signal(), '100')).channels.find(item => item.id === '203')?.canSend, false)
    f.values.set(memberPath, member)
  }
  for (const metadata of [{ archived: true, locked: false }, { archived: false, locked: true }]) {
    f.values.set('/channels/303', { ...post, thread_metadata: metadata })
    assert.equal((await inspect()).canSend, false)
  }
  f.values.set('/channels/303', { ...post, type: 12 })
  await assert.rejects(inspect(), /not supported/, 'Private threads remain disabled')
})

test('live sender/Bot roles, overwrite precedence, timeouts and thread metadata are enforced', async () => {
  const f = fixture()
  const inspect = () => inspectDiscordConversation(f.api, '201', '500', signal())
  assert.equal((await inspect()).actor.name, 'Support Sam')
  f.values.set('/channels/201', channel('201', { permission_overwrites: [
    { id: '100', type: 0, deny: P.send.toString(), allow: '0' },
    { id: '700', type: 0, deny: '0', allow: P.send.toString() },
    { id: '500', type: 1, deny: P.send.toString(), allow: '0' },
  ] }))
  assert.equal((await inspect()).canSend, false)
  f.values.set('/channels/201', channel('201'))
  f.values.set('/guilds/100/members/500', { user: { id: '500', username: 'sam' }, roles: [] })
  assert.equal((await inspect()).canView, false)
  f.values.set('/guilds/100/members/500', { user: { id: '500', username: 'sam' }, roles: ['700'],
    communication_disabled_until: new Date(Date.now() + 60_000).toISOString() })
  assert.equal((await inspect()).canSend, false)
  f.values.set('/guilds/100/members/500', { user: { id: '500', username: 'sam' }, roles: ['700'] })
  assert.equal((await inspectDiscordConversation(f.api, '301', '500', signal())).canSend, true)
  f.values.set('/channels/301', channel('301', { type: 11, parent_id: '201', thread_metadata: { archived: true, locked: true } }))
  assert.equal((await inspectDiscordConversation(f.api, '301', '500', signal())).canSend, false)
  f.values.set('/guilds/100/members/900', { user: { id: '900', username: 'bot', bot: true }, roles: ['700'],
    communication_disabled_until: new Date(Date.now() + 60_000).toISOString() })
  assert.equal((await discordDirectory(f.api, signal(), '100')).channels.find(item => item.id === '201')?.canSend, false)
})

test('missing, contradictory or malformed metadata fails instead of pretending the directory is empty', async () => {
  const f = fixture()
  f.values.set('/guilds/100/channels', [{ id: '201', type: 0, name: 'help', guild_id: '100' }])
  await assert.rejects(discordDirectory(f.api, signal(), '100'), /metadata is unavailable/)
  f.values.set('/channels/201', channel('999'))
  await assert.rejects(inspectDiscordConversation(f.api, '201', '500', signal()), /another conversation/)
  f.values.set('/channels/201', channel('201'))
  f.values.set('/guilds/100/members/500', { user: { id: '500', username: 'sam' }, roles: ['700'], communication_disabled_until: 'invalid' })
  await assert.rejects(inspectDiscordConversation(f.api, '201', '500', signal()))
  f.values.delete('/guilds/100/roles')
  await assert.rejects(discordDirectory(f.api, signal(), '100'), /Unavailable synthetic API/)
})

test('DM recipient identity is exact and private/group threads cannot become administrative entrypoints', async () => {
  const f = fixture()
  f.values.set('/channels/401', { id: '401', type: 1, recipients: [{ id: '500', username: 'sam' }] })
  const result = await inspectDiscordConversation(f.api, '401', '500', signal())
  assert.equal(result.location.name, 'sam')
  assert.deepEqual(result.actor.roleIds, [])
  await assert.rejects(inspectDiscordConversation(f.api, '401', '501', signal()), /recipient/)
  f.values.set('/channels/401', channel('401', { type: 12, parent_id: '201' }))
  await assert.rejects(inspectDiscordConversation(f.api, '401', '500', signal()), /not supported/)
})

test('guild paging rejects duplicate/backward IDs and member search returns disambiguated non-Bot users', async () => {
  const f = fixture()
  const guilds = Array.from({ length: 200 }, (_, i) => ({ id: String(400 - i), name: 'Same name', icon: null }))
  f.values.set('/users/@me/guilds?limit=200', guilds)
  assert.equal((await discordDirectory(f.api, signal())).guildCursor, '400')
  f.values.set('/users/@me/guilds?limit=200&after=400', [guilds[0]])
  await assert.rejects(discordDirectory(f.api, signal(), undefined, '400'), /invalid server page/)
  f.values.set('/users/@me/guilds?limit=200', [guilds[0], guilds[0]])
  await assert.rejects(discordDirectory(f.api, signal()), /invalid server page/)
  f.values.set('/guilds/100/members/search?query=Sam%20%23one&limit=25', [
    { user: { id: '500', username: 'sam-one' }, roles: [], nick: 'Sam' },
    { user: { id: '501', username: 'sam-two' }, roles: [], nick: 'Sam' },
    { user: { id: '900', username: 'sam-bot', bot: true }, roles: [] },
  ])
  assert.deepEqual((await discordMembers(f.api, '100', 'Sam #one', signal())).map(member => member.username), ['sam-one', 'sam-two'])
})

test('adapter honors bounded rate-limit retries and cancellation without a gateway or real token', async t => {
  const f = fixture()
  const channel = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => channel.stop())
  let attempts = 0
  let abort: AbortController | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('https://discord.com/api/v10', '')
    if (path === '/users/@me' && ++attempts <= 2) return Response.json({ retry_after: .001 }, { status: 429 })
    if (abort) {
      abort.abort()
      return Response.json({ retry_after: 1 }, { status: 429 })
    }
    return Response.json(await f.api(path, init))
  })
  assert.equal((await channel.directory(undefined, undefined, signal())).botUserId, '900')
  assert.equal(attempts, 3)
  abort = new AbortController()
  await assert.rejects(channel.directory(undefined, undefined, abort.signal), /abort/i)
  assert.equal(attempts, 4)
})

test('actual Discord ingress authorizes before reactions, attachments or silent history and uses binding metadata', async t => {
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token', triggerMode: 'mention', adminChats: ['201'] })
  t.after(() => adapter.stop())
  const received: InboundMessage[] = []
  let allowed = false, requests = 0
  let trigger: 'all' | 'mention' = 'all'
  adapter.setDiscordIntegration({
    admit: async () => {
      if (!allowed) throw new Error('Unassigned channel')
      return { admissionId: 'synthetic-proof', trigger, location }
    },
    discard() {}, confirm: async () => {}, invalidate() {},
  })
  adapter.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: 'discord:201', inputId: message.messageId }
  })
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 204 }) })
  const message = { id: '400', channel_id: '201', guild_id: '100', content: 'No mention',
    author: { id: '500', username: 'Sam', bot: false } }
  await assert.rejects(dispatch(adapter, 'MESSAGE_CREATE', { ...message, attachments: [{
    id: '600', filename: 'private.txt', url: 'https://cdn.discordapp.com/attachments/201/600/private.txt',
  }] }), /Unassigned channel/)
  assert.equal(requests, 0)
  assert.equal(received.length, 0)
  allowed = true
  await dispatch(adapter, 'MESSAGE_CREATE', message)
  assert.equal(received[0]!.silent, false, 'The assignment overrides the legacy mention-only setting')
  assert.equal(received[0]!.admin, false)
  assert.equal(received[0]!.chatName, location.name)
  assert.deepEqual(received[0]!.channelLocation, location)
  assert.equal(requests, 1, 'Only the admitted reaction performs I/O; names come from authorization metadata')
  trigger = 'mention'
  await dispatch(adapter, 'MESSAGE_CREATE', { ...message, id: '401' })
  assert.equal(received[1]!.silent, true)
  assert.equal(received[1]!.channelAdmissionId, 'synthetic-proof')
  assert.equal(requests, 1)
})

test('forum post events keep ingress in the child thread and preserve mention-only triggering', async t => {
  const f = fixture()
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token', triggerMode: 'all', reactionEmoji: '' })
  t.after(() => adapter.stop())
  f.values.set('/channels/203', channel('203', { type: 15, name: 'Questions' }))
  f.values.set('/channels/303', channel('303', { type: 11, name: 'One question', parent_id: '203',
    thread_metadata: { archived: false, locked: false } }))
  const received: InboundMessage[] = []
  adapter.setDiscordIntegration({
    admit: async input => ({ admissionId: `proof-${input.messageId}`, trigger: 'mention',
      location: (await inspectDiscordConversation(f.api, input.chatId, input.senderId, signal())).location }),
    discard() {}, confirm: async () => {}, invalidate() {},
  })
  adapter.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: `discord:${message.chatId}`, inputId: message.messageId }
  })
  const collected: unknown[] = []
  adapter.setStreamCollector(async event => { collected.push(event) })
  // No gateway connection: the READY identity and subsequent events are synthetic.
  await dispatch(adapter, 'READY', { user: { id: '900', username: 'helper', bot: true }, application: { id: '900' }, session_id: 'synthetic' })
  await dispatch(adapter, 'THREAD_CREATE', { id: '303', parent_id: '203', type: 11, name: 'One question' })
  const message = { id: '400', channel_id: '303', guild_id: '100', content: 'Question without mention',
    author: { id: '500', username: 'Sam', bot: false } }
  await dispatch(adapter, 'MESSAGE_CREATE', message)
  await dispatch(adapter, 'MESSAGE_CREATE', { ...message, id: '401', content: '<@900> Help with this post', mentions: [{ id: '900' }] })
  assert.deepEqual(received.map(message => message.chatId), ['303', '303'], 'Never route posts into their forum parent')
  assert.deepEqual(received.map(message => message.silent), [true, false])
  assert.equal(collected.length, 3, 'Thread discovery and both messages remain available to stream consumers')
  assert.deepEqual(received.map(message => message.channelAdmissionId), ['proof-400', 'proof-401'])
  assert(received.every(message => message.channelLocation?.parentId === '203' && message.channelLocation.type === 11))
})

test('per-request output guards stop subsequent Discord send and edit chunks after revocation', async t => {
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => adapter.stop())
  let allowed = true, checks = 0, requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; allowed = false; return Response.json({ id: '700' }) })
  const guard = async () => { checks++; if (!allowed) throw new Error('Synthetic authorization revoked') }
  for (const operation of ['send', 'edit']) {
    allowed = true; checks = 0; requests = 0
    const content = 'Scoped response '.repeat(400)
    await assert.rejects(adapter.withDeliveryGuard(guard, () => operation === 'send'
      ? adapter.send({ channel: 'discord', chatId: '201', event: 'response', done: true, content })
      : adapter.update('700', '201', content)), /Channel request failed/)
    assert.equal(requests, 1)
    assert.equal(checks, 2)
  }
})

test('human approval delivery failure never rewrites an applied outcome as a rejected approval', async t => {
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => adapter.stop())
  let applied = false, confirms = 0, presentations = 0
  adapter.setDiscordIntegration({
    admit: async () => ({ admissionId: 'synthetic-proof', trigger: 'mention', location }),
    discard() {}, invalidate() {},
    confirm: async () => { confirms++; applied = true },
  })
  t.mock.method(adapter, 'presentDecisionText', async (_chatId: string, content: string) => {
    presentations++
    assert.equal(content, 'The reviewed configuration is applied.')
    throw new Error('Synthetic presentation failure')
  })
  await assert.rejects(dispatch(adapter, 'MESSAGE_CREATE', {
    id: '400', channel_id: '201', guild_id: '100', author: { id: '500', username: 'Sam', bot: false },
    content: `/shadow-approve 11111111-1111-4111-8111-111111111111 ${'a'.repeat(64)}`,
  }), /Synthetic presentation failure/)
  assert(applied)
  assert.equal(confirms, 1)
  assert.equal(presentations, 1)
})

test('uncertain approval completion asks the human to inspect applied and recovery state without entering the model', async t => {
  const adapter = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => adapter.stop())
  const messages: string[] = []
  adapter.setDiscordIntegration({
    admit: async () => ({ admissionId: 'synthetic-proof', trigger: 'mention', location }),
    discard() {}, invalidate() {},
    confirm: async () => { throw new Error('Synthetic failure after a configuration side effect') },
  })
  adapter.setReceiver(async () => { assert.fail('Approval commands must not enter the model') })
  t.mock.method(adapter, 'presentDecisionText', async (_chatId: string, content: string) => { messages.push(content) })
  await dispatch(adapter, 'MESSAGE_CREATE', {
    id: '400', channel_id: '201', guild_id: '100', author: { id: '500', username: 'Sam', bot: false },
    content: `/shadow-approve 11111111-1111-4111-8111-111111111111 ${'a'.repeat(64)}`,
  })
  assert.equal(messages.length, 1)
  assert.match(messages[0]!, /could not be confirmed/)
  assert.match(messages[0]!, /applied or recovery state/)
})
