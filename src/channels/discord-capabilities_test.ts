import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { DiscordChannel } from './discord.ts'
import { DiscordPermission as P } from './discord-permissions.ts'
import type { InboundMessage } from '../bus/events.ts'

const all = P.view | P.send | P.attach | P.createPublicThreads | P.sendInThreads

test('Discord names guild sessions from channels and private sessions from the other participant', async t => {
  const channel = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => channel.stop())
  const received: InboundMessage[] = []
  channel.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: `discord:${message.chatId}`, inputId: message.messageId }
  })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: 'Readable channel' }))
  const base = { content: 'hello', author: { id: 'person', username: 'username', global_name: 'Readable person' } }
  await channel['handleDispatch']('MESSAGE_CREATE', { ...base, id: 'group-message', channel_id: 'group', guild_id: 'guild' })
  await channel['handleDispatch']('MESSAGE_CREATE', { ...base, id: 'private-message', channel_id: 'private' })
  assert.deepEqual(received.map(message => [message.chatId, message.chatName]), [
    ['group', 'Readable channel'], ['private', 'Readable person'],
  ])
})

function fixture(t: TestContext, type = 0) {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const expire = () => { now += 15_001 }
  const channel = new DiscordChannel(new Bus(), { token: 'synthetic-token' })
  t.after(() => channel.stop())
  const destination: Record<string, unknown> = {
    id: '100', type, ...(type === 1 || type === 3 ? {} : { guild_id: '200' }),
    permission_overwrites: [], parent_id: '101',
    thread_metadata: { archived: false, locked: false },
  }
  const parent = { id: '101', type: 0, guild_id: '200', permission_overwrites: [] }
  const roles = [{ id: '200', permissions: String(all) }]
  const member: Record<string, unknown> = { user: { id: '300', bot: true }, roles: [] }
  const guild = { id: '200', owner_id: '999' }
  const calls: { path: string; method: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace('/api/v10', '')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bot synthetic-token')
    assert.ok(init?.signal)
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {}, signal: init?.signal })
    if (path === '/channels/100/threads') return Response.json({ id: '400', type: 11, parent_id: '100' })
    const data = ({
      '/channels/100': destination, '/channels/101': parent, '/users/@me': { id: '300', bot: true },
      '/guilds/200': guild, '/guilds/200/roles': roles, '/guilds/200/members/300': member,
    } as Record<string, unknown>)[path]
    assert.ok(data, `Unexpected request ${path}`)
    return Response.json(data)
  })
  return { channel, destination, parent, roles, member, guild, calls, expire }
}

test('Discord capabilities reflect writable guild text and runtime attachment permissions', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.channel.getCapabilities('100'), {
    conversation: 'group', format: 'markdown', codeBlocks: true, tables: false,
    outboundMedia: ['image', 'file', 'audio', 'video'], updates: 'replace', threads: 'public', decisions: 'text',
  })
  f.roles[0].permissions = String(all & ~P.attach)
  f.expire()
  assert.deepEqual((await f.channel.getCapabilities('100')).outboundMedia, [])
  f.roles[0].permissions = String(all & ~P.view)
  f.expire()
  const denied = await f.channel.getCapabilities('100')
  assert.equal(denied.updates, 'none')
  assert.equal(denied.threads, 'none')
})

test('Discord capability reads share a bounded-lived snapshot across progressive chunks', async t => {
  const f = fixture(t)
  const results = await Promise.all(Array.from({ length: 20 }, () => f.channel.getCapabilities('100')))
  assert.equal(f.calls.length, 5)
  results[0].threads = 'none'
  ;(results[0].outboundMedia as string[]).push('invalid')
  assert.equal((await f.channel.getCapabilities('100')).threads, 'public')
  assert.equal((await f.channel.getCapabilities('100')).outboundMedia.length, 4)
  assert.equal(f.calls.length, 5)
  f.expire()
  await f.channel.getCapabilities('100')
  assert.equal(f.calls.length, 10)
})

test('Discord capability cache evicts old destinations instead of growing indefinitely', async t => {
  const f = fixture(t)
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    reads++
    return Response.json({ id: new URL(String(input)).pathname.split('/').at(-1), type: 1 })
  })
  for (let id = 1; id <= 501; id++) await f.channel.getCapabilities(String(id))
  assert.equal(reads, 501)
  await f.channel.getCapabilities('501')
  assert.equal(reads, 501)
  await f.channel.getCapabilities('1')
  assert.equal(reads, 502)
})

for (const [type, kind, writable] of [[1, 'direct', true], [3, 'group', false], [5, 'group', true],
  [10, 'thread', true], [11, 'thread', true], [12, 'thread', false], [15, 'group', false],
  [16, 'group', false], [2, 'unknown', false]] as const) {
  test(`Discord type ${type} never creates a nested, DM, forum, or unsupported thread`, async t => {
    const f = fixture(t, type)
    const capabilities = await f.channel.getCapabilities('100')
    assert.equal(capabilities.conversation, kind)
    assert.equal(capabilities.updates, writable ? 'replace' : 'none')
    assert.equal(capabilities.threads, 'none')
    assert.equal(await f.channel.createThread('100', 'topic'), null)
    assert.ok(f.calls.every(call => call.method === 'GET'))
  })
}

for (const permission of [P.view, P.createPublicThreads, P.sendInThreads]) {
  test(`Discord createThread rechecks missing permission ${permission}`, async t => {
    const f = fixture(t)
    assert.equal((await f.channel.getCapabilities('100')).threads, 'public')
    f.roles[0].permissions = String(all & ~permission)
    assert.equal(await f.channel.createThread('100', 'topic'), null)
    assert.ok(f.calls.every(call => call.method === 'GET'))
  })
}

test('Discord computes everyone, combined role, and member overwrite precedence', async t => {
  const f = fixture(t)
  f.member.roles = ['201', '202']
  f.roles.push({ id: '201', permissions: '0' }, { id: '202', permissions: '0' })
  f.destination.permission_overwrites = [
    { id: '200', type: 0, deny: String(P.createPublicThreads), allow: '0' },
    { id: '201', type: 0, deny: String(P.createPublicThreads), allow: '0' },
    { id: '202', type: 0, deny: '0', allow: String(P.createPublicThreads) },
  ]
  assert.equal((await f.channel.getCapabilities('100')).threads, 'public')
  ;(f.destination.permission_overwrites as object[]).push({ id: '300', type: 1, deny: String(P.createPublicThreads), allow: '0' })
  f.expire()
  assert.equal((await f.channel.getCapabilities('100')).threads, 'none')
  f.roles[0].permissions = String(P.administrator)
  f.expire()
  assert.equal((await f.channel.getCapabilities('100')).threads, 'public')
})

test('Discord closed threads, timeouts and malformed permission data fail closed', async t => {
  const f = fixture(t, 11)
  for (const metadata of [{ archived: true, locked: false }, { archived: false, locked: true }, {}]) {
    f.destination.thread_metadata = metadata
    f.expire()
    assert.equal((await f.channel.getCapabilities('100')).updates, 'none')
  }
  f.destination.type = 0
  f.member.communication_disabled_until = new Date(Date.now() + 60_000).toISOString()
  f.expire()
  assert.equal((await f.channel.getCapabilities('100')).threads, 'none')
  f.member.communication_disabled_until = null
  f.roles[0].permissions = 'invalid'
  f.expire()
  assert.equal((await f.channel.getCapabilities('100')).conversation, 'unknown')
})

test('Discord creates only a validated public thread and bounds its name', async t => {
  const f = fixture(t)
  assert.equal(await f.channel.createThread('100', '  '), null)
  assert.equal(await f.channel.createThread('100', 'x'.repeat(150)), '400')
  const post = f.calls.find(call => call.method === 'POST')!
  assert.equal(post.path, '/channels/100/threads')
  assert.deepEqual(post.body, { name: 'x'.repeat(100), type: 11, auto_archive_duration: 1440 })
})

test('Discord capability failures and invalid addresses are safe and do not leak credentials', async t => {
  const f = fixture(t)
  assert.equal((await f.channel.getCapabilities('../other')).conversation, 'unknown')
  assert.equal(f.calls.length, 0)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-token') })
  assert.equal((await f.channel.getCapabilities('100')).conversation, 'unknown')
  assert.equal(await f.channel.createThread('100', 'topic'), null)
})

test('Discord denied REST access and malformed created thread responses fail closed', async t => {
  const f = fixture(t)
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ id: '400', type: 12, parent_id: '100' })
    return originalFetch(input, init)
  })
  assert.equal(await f.channel.createThread('100', 'topic'), null)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  f.expire()
  assert.equal((await f.channel.getCapabilities('100')).threads, 'none')
  assert.equal(await f.channel.createThread('100', 'topic'), null)
})

test('Discord capability requests abort on stop; late responses cannot create threads', async t => {
  const f = fixture(t)
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined
    return response.promise
  })
  const pending = f.channel.createThread('100', 'topic')
  await f.channel.stop()
  assert.equal(signal?.aborted, true)
  response.resolve(Response.json(f.destination))
  assert.equal(await pending, null)
  assert.equal((await f.channel.getCapabilities('100')).conversation, 'unknown')
})
