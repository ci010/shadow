import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { DiscordChannel } from './discord.ts'
import type { ChannelDecision } from './base.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import { YieldManager } from '../sessions/yield.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { ChannelManager } from './manager.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

const request: YieldRequest = {
  id: '59ab28a8-1a17-480a-bd7e-cb463b966001', sessionId: 'discord:100',
  recipient: { kind: 'user', sessionId: 'discord:100' }, createdAt: '2026-09-14T00:00:00Z', deadline: null,
  question: 'Choose @everyone?', options: ['First', 'Second', 'Third'], defaultOption: 'First',
}

class Socket {
  readyState = 1
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() { this.readyState = 3 }
  emit(type: string, data: object) {
    this.onmessage?.({ data: JSON.stringify({ op: 0, t: type, d: data }) } as MessageEvent)
  }
}

type Call = { path: string; method: string; body: Record<string, any>; init?: RequestInit }

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

async function fixture(t: TestContext, allowFrom?: string[]) {
  const socket = new Socket()
  const calls: Call[] = []
  const channel = new DiscordChannel(new Bus(), { token: 'synthetic-bot-token', allowFrom })
  let nextMessage = 500
  t.mock.method(globalThis, 'WebSocket', function () { socket.readyState = 1; return socket })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace('/api/v10', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body, init })
    if (path.startsWith('/interactions/') || path.startsWith('/webhooks/')) {
      assert.equal(new Headers(init?.headers).has('Authorization'), false)
      return method === 'POST' ? new Response(null, { status: 204 }) : Response.json({})
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bot synthetic-bot-token')
    if (path === '/gateway/bot') return Response.json({ url: 'wss://synthetic.invalid' })
    if (path === '/channels/100') return Response.json({ id: '100', type: 1 })
    if (path === '/channels/100/messages' && method === 'POST') return Response.json({ id: String(nextMessage++) })
    if (/^\/channels\/100\/messages\/\d+$/.test(path) && method === 'PATCH') return Response.json({})
    assert.fail(`Unexpected request ${path}`)
  })
  t.after(() => channel.stop())
  await channel.start(new Hono())
  socket.emit('READY', { session_id: 'synthetic-session', user: { id: '300', bot: true }, application: { id: '301' } })
  function interaction(patch: Record<string, unknown> = {}) {
    return {
      id: '600', type: 3, application_id: '301', token: 'synthetic-interaction-token', channel_id: '100',
      user: { id: '400' },
      message: { id: '500', channel_id: '100', author: { id: '300', bot: true } },
      data: { component_type: 2, custom_id: `yield:${request.id}:2` },
      ...patch,
    }
  }
  async function dispatch(data = interaction()) {
    socket.emit('INTERACTION_CREATE', data)
    await flush()
  }
  return { channel, calls, socket, interaction, dispatch }
}

test('Discord renders isolated bounded buttons, full long options and no unsolicited mentions', async t => {
  const f = await fixture(t)
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'buttons')
  const longRequest = { ...request, question: 'Question '.repeat(400), options: ['A'.repeat(500), 'B'.repeat(500), 'C'.repeat(500)] as [string, string, string], defaultOption: 'A'.repeat(500) }
  await f.channel.presentDecision('100', longRequest, 'Context')
  const posts = f.calls.filter(call => call.method === 'POST')
  assert.ok(posts.length > 1)
  const fullText = posts.map(call => call.body.content).join('')
  assert.ok(fullText.includes(longRequest.question.trim()))
  for (const option of longRequest.options) assert.ok(fullText.includes(option))
  assert.ok(posts.every(call => call.body.content.length <= 2000))
  assert.ok(posts.slice(0, -1).every(call => !call.body.components))
  const buttons = posts.at(-1)!.body.components[0].components
  assert.equal(buttons.length, 4)
  assert.ok(buttons.every((button: { label: string }) => button.label.length <= 80))
  assert.deepEqual(buttons.map((button: { custom_id: string }) => button.custom_id),
    ['1', '2', '3', 'cancel'].map(choice => `yield:${request.id}:${choice}`))
  for (const call of posts) assert.deepEqual(call.body.allowed_mentions, { parse: [], replied_user: false })
})

test('Discord defers privately before shared handler and clears only isolated buttons on success', async t => {
  const f = await fixture(t)
  await f.channel.onMessage({ channel: 'discord', chatId: '100', content: 'Working', event: 'response', done: false })
  await f.channel.presentDecision('100', request, '')
  const pending = Promise.withResolvers<string>()
  const decisions: ChannelDecision[] = []
  f.channel.setDecisionHandler(async decision => {
    assert.ok(f.calls.some(call => call.path.startsWith('/interactions/') && call.body.type === 5))
    decisions.push(decision)
    return pending.promise
  })
  await f.dispatch(f.interaction({ message: { id: '501', author: { id: '300', bot: true } } }))
  const ack = f.calls.find(call => call.path.startsWith('/interactions/'))!
  assert.equal(ack.body.data.flags, 64)
  assert.equal(f.calls.some(call => call.path.startsWith('/webhooks/')), false)
  assert.deepEqual(decisions, [{ chatId: '100', senderId: '400', requestId: request.id, option: 2 }])
  await f.channel.onMessage({ channel: 'discord', chatId: '100', content: 'More @everyone', event: 'response', done: true })
  pending.resolve('Answer accepted.')
  await flush()
  const updates = f.calls.filter(call => call.method === 'PATCH')
  assert.equal(updates[0].path, '/channels/100/messages/500')
  assert.equal(updates[0].body.content, 'More @everyone')
  const decisionUpdate = updates.find(call => call.path === '/channels/100/messages/501')!
  assert.deepEqual(decisionUpdate.body.components, [])
  assert.equal(decisionUpdate.body.content, undefined)
  assert.equal(updates.at(-1)!.body.content, 'Answer accepted.')
  for (const call of updates) assert.deepEqual(call.body.allowed_mentions, { parse: [], replied_user: false })
})

test('Discord validates callback payload, bot identity, address and actor before invoking shared handler', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  let answers = 0
  f.channel.setDecisionHandler(async () => { answers++; return 'Accepted' })
  const rejected = [
    { application_id: '999' }, { type: 2 }, { token: '../../other' }, { channel_id: '../100' },
    { data: { component_type: 3, custom_id: `yield:${request.id}:1` } },
    { data: { component_type: 2, custom_id: `yield:${request.id}:execute supplied text` } },
    { data: { component_type: 2, custom_id: 'yield:not-a-uuid:1' } },
    { data: { component_type: 2, custom_id: 'yield:59ab28a8-1a17-480a-bd7e-cb463b966999:1' } },
    { channel_id: '999' },
    { message: { id: '999', author: { id: '300', bot: true } } },
    { message: { id: '500', author: { id: '999', bot: true } } },
    { message: { id: '500', author: { id: '300', bot: false } } },
    { message: { id: '500', channel_id: '999', author: { id: '300', bot: true } } },
    { message: { id: '500', application_id: '999', author: { id: '300', bot: true } } },
    { user: { id: '400', bot: true } }, { user: {} },
    { guild_id: '200', member: { user: { id: '401' } } },
  ]
  for (const patch of rejected) await f.dispatch(f.interaction(patch))
  assert.equal(answers, 0)
  assert.ok(f.calls.some(call => call.path.startsWith('/webhooks/') && /could not be accepted/.test(call.body.content)))
  assert.ok(!f.calls.some(call => call.method === 'PATCH' && call.path.startsWith('/channels/')))
})

test('Discord allowFrom rejects after acknowledgement and hides shared error contents', async t => {
  const f = await fixture(t, ['401'])
  await f.channel.presentDecision('100', request, '')
  let answers = 0
  f.channel.setDecisionHandler(async () => { answers++; throw new Error('synthetic-private-detail') })
  await f.dispatch()
  assert.equal(answers, 0)
  await f.dispatch(f.interaction({ user: { id: '401' } }))
  assert.equal(answers, 1)
  const replies = f.calls.filter(call => call.path.startsWith('/webhooks/'))
  assert.equal(replies.length, 2)
  assert.doesNotMatch(JSON.stringify(replies.map(call => call.body)), /synthetic-private-detail|synthetic-interaction-token/)
})

test('Discord cancel buttons pass only cancel to shared handler, including guild member identity', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  const decisions: ChannelDecision[] = []
  f.channel.setDecisionHandler(async decision => { decisions.push(decision); return 'Cancelled' })
  await f.dispatch(f.interaction({
    user: undefined, guild_id: '200', member: { user: { id: '400' } },
    data: { component_type: 2, custom_id: `yield:${request.id}:cancel` },
  }))
  assert.equal(decisions[0].option, 'cancel')
  assert.equal(decisions[0].senderId, '400')
})

test('Discord routes cross-user, repeated, timed-out and stale choices through shared YieldManager', async t => {
  const f = await fixture(t)
  const delivered = Promise.withResolvers<YieldRequest>()
  let timeoutMs: number | null = null
  const manager = new YieldManager({
    getState: () => ({ sessionId: 'discord:100', segmentIndex: 0 } satisfies SessionState),
    getPolicy: () => ({ timeoutMs }),
    notifyUser: async value => { await f.channel.presentDecision('100', value, ''); delivered.resolve(value) },
    notifyParent: async () => assert.fail('Unexpected parent'),
  })
  t.after(() => manager.stop())
  let sharedCalls = 0
  f.channel.setDecisionHandler(async decision => {
    sharedCalls++
    const active = manager.get(`discord:${decision.chatId}`)
    if (decision.option === 'cancel') manager.cancelChannel(`discord:${decision.chatId}`, decision.requestId, 'discord', decision.senderId)
    else manager.answerChannel(`discord:${decision.chatId}`, decision.requestId, active?.options[decision.option - 1] ?? '', 'discord', decision.senderId)
    return 'Accepted'
  })
  const answer = manager.ask('discord:100', request, new AbortController().signal, { channel: 'discord', senderId: '400' })
  const active = await delivered.promise
  const payload = f.interaction({ data: { component_type: 2, custom_id: `yield:${active.id}:3` } })
  await f.dispatch({ ...payload, user: { id: '401' } })
  assert.ok(manager.get('discord:100'))
  await f.dispatch(payload)
  assert.equal((await answer).option, 'Third')
  await f.dispatch(payload)
  assert.equal(sharedCalls, 3)
  assert.match(f.calls.at(-1)!.body.content, /could not be accepted/)

  // A request that settles without a click still uses central validation on its old buttons.
  timeoutMs = 10
  const staleAnswer = manager.ask('discord:100', request, new AbortController().signal, { channel: 'discord', senderId: '400' })
  const stale = manager.get('discord:100')!
  assert.equal((await staleAnswer).answeredBy, 'timeout')
  await f.dispatch(f.interaction({
    message: { id: '501', author: { id: '300', bot: true } },
    data: { component_type: 2, custom_id: `yield:${stale.id}:1` },
  }))
  assert.equal(sharedCalls, 4)
  assert.match(f.calls.at(-1)!.body.content, /could not be accepted/)
})

test('Discord stop cancels pending acknowledgements and suppresses stale gateway callbacks', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  let answers = 0
  f.channel.setDecisionHandler(async () => { answers++; return 'Accepted' })
  const pending = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined
    return pending.promise
  })
  const staleGateway = f.socket.onmessage!
  f.socket.emit('INTERACTION_CREATE', f.interaction())
  await f.channel.stop()
  assert.equal(signal?.aborted, true)
  pending.resolve(new Response(null, { status: 204 }))
  await flush()
  staleGateway({ data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', d: f.interaction() }) } as MessageEvent)
  await flush()
  assert.equal(answers, 0)
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'text')
  await assert.rejects(f.channel.presentDecision('100', request, ''), /unavailable/)
})

test('Discord failed acknowledgements never execute a choice or disclose interaction tokens', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  let answers = 0
  f.channel.setDecisionHandler(async () => { answers++; return 'Accepted' })
  const logs: unknown[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic-interaction-token') })
  await f.dispatch()
  assert.equal(answers, 0)
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-interaction-token/)
})

test('Discord pending shared answers cannot edit messages after shutdown', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  const answer = Promise.withResolvers<string>()
  f.channel.setDecisionHandler(() => answer.promise)
  await f.dispatch()
  await f.channel.stop()
  const calls = f.calls.length
  answer.resolve('Accepted')
  await flush()
  assert.equal(f.calls.length, calls)
})

test('Discord restart drops decision delivery bindings', async t => {
  const f = await fixture(t)
  await f.channel.presentDecision('100', request, '')
  let answers = 0
  f.channel.setDecisionHandler(async () => { answers++; return 'Accepted' })
  await f.channel.stop()
  await f.channel.start(new Hono())
  f.socket.emit('READY', { session_id: 'new', user: { id: '300', bot: true }, application: { id: '301' } })
  await f.dispatch()
  assert.equal(answers, 0)
  assert.match(f.calls.at(-1)!.body.content, /could not be accepted/)
})

test('Discord missing application identity refuses buttons and text sends/overflow edits suppress mentions', async t => {
  const f = await fixture(t)
  f.socket.emit('READY', { session_id: 'new', user: { id: '300', bot: true } })
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'text')
  await assert.rejects(f.channel.presentDecision('100', request, ''), /unavailable/)
  await f.channel.send({ channel: 'discord', chatId: '100', content: '@everyone '.repeat(300), replyTo: '200', event: 'response', done: true })
  await f.channel.update('500', '100', '@everyone '.repeat(300))
  const writes = f.calls.filter(call => call.method !== 'GET')
  assert.equal(writes.length, 4)
  for (const call of writes) assert.deepEqual(call.body.allowed_mentions, { parse: [], replied_user: false })
  assert.deepEqual(writes[0].body.message_reference, { message_id: '200' })
})

test('Discord gateway permission changes invalidate cached capabilities and socket readiness stays live', async t => {
  const f = await fixture(t)
  const reads = () => f.calls.filter(call => call.path === '/channels/100').length
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'buttons')
  await f.channel.getCapabilities('100')
  assert.equal(reads(), 1)
  f.socket.readyState = 3
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'text')
  assert.equal(reads(), 1)
  f.socket.readyState = 1
  for (const event of ['CHANNEL_UPDATE', 'GUILD_ROLE_UPDATE', 'GUILD_MEMBER_UPDATE', 'THREAD_UPDATE', 'RESUMED']) {
    f.socket.emit(event, { id: '100' })
    assert.equal((await f.channel.getCapabilities('100')).decisions, 'buttons')
  }
  assert.equal(reads(), 6)
})

test('Discord native presentation refreshes permissions even when progressive capabilities are cached', async t => {
  const f = await fixture(t)
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'buttons')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '100', type: 3 }))
  await assert.rejects(f.channel.presentDecision('100', request, ''), /unavailable/)
  assert.equal((await f.channel.getCapabilities('100')).decisions, 'text')
  assert.equal(f.calls.some(call => call.method === 'POST'), false)
})

test('Discord inherited text fallback acknowledges delivery without taking over progressive updates', async t => {
  const f = await fixture(t)
  await f.channel.onMessage({ channel: 'discord', chatId: '100', content: 'Working', event: 'response', done: false })
  await f.channel.presentDecisionText('100', 'Choose @everyone')
  await f.channel.onMessage({ channel: 'discord', chatId: '100', content: 'Done', event: 'response', done: true })
  const posts = f.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body.content, 'Choose @everyone')
  assert.equal(posts[1].body.components, undefined)
  assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => call.path), ['/channels/100/messages/500'])
})

for (const failure of ['first', 'later', 'missing-id', 'invalid-id'] as const) {
  test(`Discord inherited text fallback rejects ${failure} receipt failure`, async t => {
    const f = await fixture(t)
    let posts = 0
    t.mock.method(globalThis, 'fetch', async () => {
      posts++
      if (failure === 'missing-id') return Response.json({})
      if (failure === 'invalid-id') return Response.json({ id: 500 })
      return posts === (failure === 'first' ? 1 : 2)
        ? new Response(null, { status: 403 }) : Response.json({ id: String(500 + posts) })
    })
    await assert.rejects(f.channel.presentDecisionText('100', 'x'.repeat(2500)), /not acknowledged/)
  })
}

async function managedFixture(t: TestContext) {
  const f = await fixture(t)
  await f.channel.stop()
  let manager: ChannelManager
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: value => manager.deliverDecision({
      channel: 'discord', chatId: '100', content: `${value.question}\n${value.options.join('\n')}`,
      event: 'response', done: true, yieldRequest: value,
    }),
    notifyParent: async () => assert.fail('Unexpected parent'),
  })
  const sessions: Pick<SessionManager, 'yields' | 'getActiveSession'> = { yields, getActiveSession: () => undefined }
  manager = new ChannelManager(
    ConfigSchema.parse({ channels: { discord: { enabled: true, token: 'synthetic-bot-token' } } }),
    new Bus(), sessions as SessionManager,
    async () => ({ status: 'accepted', sessionId: 'discord:100', inputId: 'input' }),
    () => f.channel,
  )
  await manager.init()
  await manager.startAll(new Hono())
  f.socket.emit('READY', { session_id: 'managed', user: { id: '300', bot: true }, application: { id: '301' } })
  t.after(async () => { yields.stop(); await manager.stopAll() })
  const ask = () => yields.ask('discord:100', request, new AbortController().signal, { channel: 'discord', senderId: '400' })
  return { ...f, manager, yields, ask }
}

test('Discord native gateway callbacks use the real manager-bound initiating sender handler', { timeout: 5000 }, async t => {
  const f = await managedFixture(t)
  assert.equal((await f.manager.getCapabilities('discord', '100')).decisions, 'buttons')
  const waiting = f.ask()
  await flush()
  const active = f.yields.get('discord:100')!
  const payload = f.interaction({ data: { component_type: 2, custom_id: `yield:${active.id}:2` } })
  await f.dispatch({ ...payload, user: { id: '401' } })
  assert.ok(f.yields.get('discord:100'))
  await f.dispatch(payload)
  assert.equal(f.yields.get('discord:100'), null)
  assert.equal((await waiting).option, 'Second')
  assert.equal(f.calls.at(-1)!.body.content, 'Selected: Second')
})

test('Discord native and default-text delivery failure rejects the actual managed yield waiter', { timeout: 5000 }, async t => {
  const f = await managedFixture(t)
  const originalFetch = globalThis.fetch
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return new Response(null, { status: 403 }) }
    return originalFetch(input, init)
  })
  await assert.rejects(f.ask(), /Yield delivery failed.*not acknowledged/)
  assert.equal(posts, 2)
  assert.equal(f.yields.get('discord:100'), null)
})
