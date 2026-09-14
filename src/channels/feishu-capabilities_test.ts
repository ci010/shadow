import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import { YieldManager } from '../sessions/yield.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { FeishuChannel, type FeishuChannelOptions } from './feishu.ts'
import type { FeishuCardHandler } from './feishu-transport.ts'
import { ChannelManager } from './manager.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

async function fixture(t: TestContext, options: Partial<FeishuChannelOptions> = {}) {
  const requests: Array<{ path: string; body: Record<string, any> }> = []
  const received: InboundMessage[] = []
  const states: Record<string, SessionState> = {}
  let onEvent!: (data: Record<string, unknown>) => void
  let onCard!: FeishuCardHandler
  let promotionCode = 0
  let promotionThreadId: string | undefined = 'omt_topic'
  let permission = 'all'
  let chatApiFailure = false
  let chatReads = 0
  let failNative = false
  let failSends = false
  let stopped = false
  let sequence = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const path = url.pathname
    if (path.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } })
    if (path.includes('/contact/')) return Response.json({ code: 0, data: { user: { name: 'User' } } })
    if (path.includes('/reactions')) return Response.json({ code: 0 })
    if (path.includes('/resources/')) return new Response(new Uint8Array([1, 2, 3]))
    if (path.includes('/chats/')) {
      chatReads++
      return Response.json(chatApiFailure ? { code: 999 } : {
        code: 0, data: {
          chat_mode: path.endsWith('oc_direct') ? 'p2p' : 'group',
          chat_post_permission: permission, chat_status: 'normal',
        },
      })
    }
    requests.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} })
    if (path.endsWith('/messages') && (failSends || (failNative && String(requests.at(-1)?.body.content).includes('shadow_yield')))) {
      return Response.json({ code: 999 })
    }
    if (init?.method === 'PATCH') return Response.json({ code: 0 })
    if (path.endsWith('/reply')) {
      return Response.json({ code: promotionCode, data: { message_id: `om_reply_${++sequence}`, thread_id: promotionThreadId } })
    }
    if (path.endsWith('/messages')) return Response.json({ code: 0, data: { message_id: `om_root_${++sequence}` } })
    if (path.endsWith('/files')) return Response.json({ code: 0, data: { file_key: 'file_uploaded' } })
    if (path.endsWith('/images')) return Response.json({ code: 0, data: { image_key: 'image_uploaded' } })
    throw new Error(`Unexpected synthetic request ${path}`)
  })
  const channel = new FeishuChannel(new Bus(), {
    appId: 'fixture-app', appSecret: 'fixture-secret',
    sessionManager: { getSessionState: id => states[id] ?? null },
    ...options,
    transportFactory: (_options, event, status, card) => {
      onEvent = event
      onCard = card
      return { start: () => status('running'), stop: async () => { stopped = true } }
    },
  })
  channel.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: `feishu:${message.chatId}`, inputId: message.messageId }
  })
  t.after(() => channel.stop())
  await channel.start(new Hono())
  await flush()
  return {
    channel, received, requests, states,
    setPromotionCode: (code: number) => { promotionCode = code },
    setPromotionThreadId: (id?: string) => { promotionThreadId = id },
    setPermission: (value: string) => { permission = value },
    failChatApi: () => { chatApiFailure = true },
    isStopped: () => stopped,
    chatReads: () => chatReads,
    failNative: () => { failNative = true },
    failSends: () => { failSends = true },
    card: (event: Record<string, unknown>) => onCard(event),
    incoming: async (message: Record<string, unknown> = {}, senderId = 'ou_user') => {
      onEvent({
        sender: { sender_id: { open_id: senderId } },
        message: {
          message_id: `om_in_${++sequence}`, chat_id: 'oc_group', chat_type: 'group',
          message_type: 'text', content: '{"text":"continue"}', ...message,
        },
      })
      await flush()
    },
  }
}

test('Feishu capabilities distinguish p2p oc_ chats, eligible groups and managed root topics', async t => {
  const f = await fixture(t)
  const direct = await f.channel.getCapabilities('oc_direct')
  assert.equal(direct.conversation, 'direct')
  assert.equal(direct.threads, 'none')
  assert.equal(await f.channel.createThread('oc_direct', 'No DM topics'), null)
  assert.equal(await f.channel.createThread('ou_user', 'No arbitrary topics'), null)
  const group = await f.channel.getCapabilities('oc_group')
  assert.deepEqual(group, {
    conversation: 'group', format: 'card', codeBlocks: true, tables: true,
    outboundMedia: ['image', 'file'], updates: 'replace', threads: 'topic', decisions: 'buttons',
  })
  f.states['feishu:om_legacy'] = { sessionId: 'feishu:om_legacy', segmentIndex: 0, parent: { id: 'feishu:oc_group' } }
  const topic = await f.channel.getCapabilities('om_legacy')
  assert.equal(topic.conversation, 'thread')
  assert.equal(topic.threads, 'none')
  assert.equal(await f.channel.createThread('om_legacy', 'No nested topics'), null)
  assert.equal((await f.channel.getCapabilities('om_unmanaged')).conversation, 'unknown')
  f.setPermission('only_owner')
  assert.equal(await f.channel.createThread('oc_group', 'Cannot post'), null)
  assert.equal((await f.channel.getCapabilities('oc_group')).threads, 'none')
  await f.channel.stop()
  assert.equal((await f.channel.getCapabilities('oc_group')).conversation, 'unknown')
})

test('Feishu capability reads share a bounded expiring cache but topic creation refreshes permissions', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 8 }, () => f.channel.getCapabilities('oc_group')))
  assert.equal(f.chatReads(), 1)
  f.states['feishu:om_root'] = { sessionId: 'feishu:om_root', segmentIndex: 0, parentSessionId: 'feishu:oc_group' }
  await f.channel.getCapabilities('om_root')
  assert.equal(f.chatReads(), 1)
  f.setPermission('only_owner')
  assert.equal((await f.channel.getCapabilities('oc_group')).threads, 'topic')
  assert.equal(await f.channel.createThread('oc_group', 'Must recheck'), null)
  assert.equal(f.chatReads(), 2)
  assert.equal(f.requests.length, 0)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  now += 31_000
  assert.equal((await f.channel.getCapabilities('oc_group')).threads, 'none')
  assert.equal(f.chatReads(), 3)
  await Promise.all(Array.from({ length: 500 }, (_, index) => f.channel.getCapabilities(`oc_cache_${index}`)))
  await f.channel.getCapabilities('oc_group')
  assert.equal(f.chatReads(), 504)
})

test('Feishu inbound chat_type governs privileges even when p2p has an oc_ ID', async t => {
  const f = await fixture(t)
  await f.incoming({ chat_id: 'oc_direct', chat_type: 'p2p' })
  await f.incoming()
  assert.equal(f.received[0].chatId, 'oc_direct')
  assert.equal(f.received[0].admin, true)
  assert.equal(f.received[0].silent, false)
  assert.equal(f.received[1].admin, false)
  assert.equal(f.received[1].silent, true)
  f.failChatApi()
  assert.equal((await f.channel.getCapabilities('oc_group')).conversation, 'group')
  assert.equal((await f.channel.getCapabilities('oc_group')).threads, 'none')
  assert.equal((await f.channel.getCapabilities('oc_unknown')).conversation, 'unknown')
})

test('Feishu topics recover persisted root routing on a fresh adapter without a thread-ID map', async t => {
  const f = await fixture(t)
  f.states['feishu:om_legacy'] = {
    sessionId: 'feishu:om_legacy', segmentIndex: 0, parentSessionId: 'feishu:oc_group',
  }
  await f.incoming({ thread_id: 'omt_topic', root_id: 'om_legacy', parent_id: 'om_legacy' })
  assert.equal(f.received[0].chatId, 'om_legacy')
  assert.equal(f.received[0].silent, false)
  assert.equal(f.received[0].admin, false)
  await f.channel.send({ channel: 'feishu', chatId: f.received[0].chatId, content: 'reply', event: 'response', done: true })
  assert.equal(f.requests.at(-1)?.path, '/open-apis/im/v1/messages/om_legacy/reply')
  assert.equal(f.requests.at(-1)?.body.reply_in_thread, true)
})

test('Feishu ordinary replies, unrelated topics and cross-group roots do not gain child admission', async t => {
  const f = await fixture(t)
  f.states['feishu:om_legacy'] = { sessionId: 'feishu:om_legacy', segmentIndex: 0, parent: { id: 'feishu:oc_group' } }
  await f.incoming({ root_id: 'om_legacy', parent_id: 'om_legacy' })
  await f.incoming({ root_id: 'om_external', thread_id: 'omt_external', parent_id: 'om_external' })
  await f.incoming({ chat_id: 'oc_other', root_id: 'om_legacy', thread_id: 'omt_topic' })
  await f.incoming({
    root_id: 'om_external', thread_id: 'omt_external',
    mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1' }],
    content: '{"text":"@_user_1 hello"}',
  })
  assert.deepEqual(f.received.map(message => [message.chatId, message.silent]), [
    ['oc_group', true], ['oc_group', true], ['oc_other', true], ['oc_group', false],
  ])
  assert.equal(f.received[3].content, 'hello')
  assert.equal(f.states['feishu:om_external'], undefined)
})

test('Feishu topic promotion must succeed; legacy root ID is returned only for an actual topic', async t => {
  const f = await fixture(t)
  f.setPromotionCode(123)
  assert.equal(await f.channel.createThread('oc_group', 'Failure'), null)
  const failedRoot = f.requests[1].path.split('/').at(-2)!
  await f.incoming({ root_id: failedRoot, thread_id: 'omt_no_topic' })
  assert.equal(f.received.at(-1)?.chatId, 'oc_group')
  assert.equal(f.received.at(-1)?.silent, true)
  f.setPromotionCode(0)
  f.setPromotionThreadId()
  assert.equal(await f.channel.createThread('oc_group', 'Missing topic verification'), null)
  f.setPromotionThreadId('omt_topic')
  const root = await f.channel.createThread('oc_group', 'Success')
  assert.ok(root?.startsWith('om_'))
  await f.incoming({ root_id: root, thread_id: 'omt_topic', parent_id: root })
  assert.equal(f.received.at(-1)?.chatId, root)
  assert.equal(f.received.at(-1)?.silent, false)
  await f.incoming({ root_id: root, parent_id: root })
  assert.equal(f.received.at(-1)?.chatId, 'oc_group')
  assert.equal(f.received.at(-1)?.silent, false)
})

test('Feishu topic uploads and outbound files use the effective shared session workspace', async t => {
  const base = join(process.cwd(), '.test-data')
  mkdirSync(base, { recursive: true })
  const workspace = mkdtempSync(join(base, 'feishu-topic-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const f = await fixture(t, { workspace })
  f.states['feishu:om_legacy'] = {
    sessionId: 'feishu:om_legacy', segmentIndex: 0, parent: { id: 'feishu:oc_group' }, workspaceRoot: 'feishu:oc_group',
  }
  await f.incoming({
    root_id: 'om_legacy', thread_id: 'omt_topic', message_type: 'file',
    content: '{"file_key":"file_fixture","file_name":"../fixture.txt"}',
  })
  for (let i = 0; i < 50 && !f.received.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(f.received[0].media, ['uploads/fixture.txt'])
  assert.equal(f.received[0].chatId, 'om_legacy')
  assert.deepEqual(readFileSync(join(sessionWorkspacePath(workspace, 'feishu:oc_group'), 'uploads', 'fixture.txt')), Buffer.from([1, 2, 3]))
  await f.channel.send({ channel: 'feishu', chatId: 'om_legacy', content: '', media: ['uploads/fixture.txt'], event: 'response', done: true })
  assert.equal(f.requests.at(-1)?.path, '/open-apis/im/v1/messages/om_legacy/reply')
  assert.equal(f.requests.at(-1)?.body.reply_in_thread, true)
  assert.equal(f.requests.at(-1)?.body.msg_type, 'file')
})

test('Feishu topic media never falls back to Main for a remote workdir', async t => {
  const f = await fixture(t)
  f.states['feishu:om_remote'] = {
    sessionId: 'feishu:om_remote', segmentIndex: 0, parentSessionId: 'feishu:oc_group',
    workdir: { version: 1, nodeId: 'remote-node', capabilityId: 'remote-capability', displayPathSnapshot: 'C:\\not-a-local-path' },
  }
  assert.deepEqual((await f.channel.getCapabilities('om_remote')).outboundMedia, [])
  await f.incoming({
    root_id: 'om_remote', thread_id: 'omt_remote', message_type: 'file',
    content: '{"file_key":"file_fixture","file_name":"fixture.txt"}',
  })
  assert.equal(f.received[0].chatId, 'om_remote')
  assert.equal(f.received[0].content, '[file]')
  assert.equal(f.received[0].media, undefined)
})

const request: YieldRequest = {
  id: 'yield-fixture', sessionId: 'feishu:oc_direct', recipient: { kind: 'user', sessionId: 'feishu:oc_direct' },
  question: 'Choose?', options: ['First', 'Second', 'Third'], defaultOption: 'Second',
  createdAt: '2026-09-14T00:00:00.000Z', deadline: null,
}
const action = (value: Record<string, unknown> = {}, sender = 'ou_user', outer = 'oc_direct') => ({
  operator: { open_id: sender }, context: { open_chat_id: outer, open_message_id: 'om_card' },
  action: { tag: 'button', value: { kind: 'shadow_yield', requestId: request.id, chatId: 'oc_direct', option: 2, ...value } },
})

test('Feishu yield cards carry only validated decisions and route through the shared authorization handler', async t => {
  const f = await fixture(t, { allowFrom: ['ou_user'] })
  await f.channel.presentDecision('oc_direct', request, 'Choose?\n1. First\n2. Second\n3. Third')
  const payload = JSON.parse(f.requests.at(-1)!.body.content)
  const buttons = payload.elements.at(-1).actions
  assert.deepEqual(buttons.map((button: any) => button.value.option), [1, 2, 3, 'cancel'])
  assert.equal(buttons[1].type, 'primary')
  assert.equal(buttons[0].text.tag, 'plain_text')
  const answers: unknown[] = []
  f.channel.setDecisionHandler(async decision => { answers.push(decision); return 'Accepted' })
  assert.equal((await f.card(action())).toast.type, 'success')
  assert.deepEqual(answers, [{ chatId: 'oc_direct', senderId: 'ou_user', requestId: request.id, option: 2 }])
  assert.equal((await f.card(action({ option: 'cancel' }))).toast.type, 'success')
  for (const invalid of [{ option: '2' }, { option: '/shell echo injected' }, { option: 4 }, { kind: 'command' }, { chatId: 'oc_other' }]) {
    assert.equal((await f.card(action(invalid))).toast.type, 'error')
  }
  assert.equal((await f.card(action({}, 'ou_denied'))).toast.type, 'error')
  assert.equal(answers.length, 2)
  assert.equal(f.received.length, 0)
  f.channel.setDecisionHandler(async () => { throw new Error('fixture-secret: unauthorized or expired') })
  const rejected = await f.card(action())
  assert.equal(rejected.toast.type, 'error')
  assert.doesNotMatch(JSON.stringify(rejected), /fixture-secret/)
  await f.channel.stop()
  assert.equal((await f.card(action())).toast.type, 'error')
  assert.equal(f.isStopped(), true)
})

test('Feishu topic decision card callbacks bind the root destination to the platform outer chat', async t => {
  const f = await fixture(t)
  f.states['feishu:om_legacy'] = { sessionId: 'feishu:om_legacy', segmentIndex: 0, parent: { id: 'feishu:oc_group' } }
  await f.channel.presentDecision('om_legacy', request, 'Topic decision')
  assert.equal(f.requests.at(-1)?.body.reply_in_thread, true)
  const answers: unknown[] = []
  f.channel.setDecisionHandler(async decision => { answers.push(decision); return 'Accepted' })
  assert.equal((await f.card(action({ chatId: 'om_legacy' }, 'ou_user', 'oc_group'))).toast.type, 'success')
  assert.equal((await f.card(action({ chatId: 'om_legacy' }, 'ou_user', 'oc_other'))).toast.type, 'error')
  assert.equal((await f.card(action({ chatId: 'om_unmanaged' }, 'ou_user', 'oc_group'))).toast.type, 'error')
  assert.equal(answers.length, 1)
})

test('Feishu native decisions leave the active progressive message isolated and unchanged', async t => {
  const f = await fixture(t)
  await f.channel.onMessage({ channel: 'feishu', chatId: 'oc_direct', event: 'response', content: 'Before', done: false })
  const progressiveRoot = 'om_root_1'
  await f.channel.presentDecision('oc_direct', request, 'Choose?')
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].path, '/open-apis/im/v1/messages')
  assert.equal(JSON.parse(f.requests[1].body.content).elements.at(-1).tag, 'action')
  await f.channel.onMessage({ channel: 'feishu', chatId: 'oc_direct', event: 'response', content: 'After', done: true })
  assert.equal(f.requests[2].path, `/open-apis/im/v1/messages/${progressiveRoot}`)
  assert.doesNotMatch(f.requests[2].body.content, /Choose|shadow_yield/)
  assert.equal(f.chatReads(), 1)
})

test('Feishu recovery and card authorization use structural parent A, never completion recipient B', async t => {
  const f = await fixture(t)
  const answers: unknown[] = []
  f.channel.setDecisionHandler(async decision => { answers.push(decision); return 'Accepted' })
  for (const structural of [
    { parentSessionId: 'feishu:oc_A', parent: { id: 'feishu:oc_B' } },
    { parent: { id: 'feishu:oc_A' } },
  ]) {
    f.states['feishu:om_legacy'] = {
      sessionId: 'feishu:om_legacy', segmentIndex: 0, ...structural, reportTo: 'feishu:oc_B',
    }
    await f.incoming({ chat_id: 'oc_A', root_id: 'om_legacy', thread_id: 'omt_verified' })
    assert.equal(f.received.at(-1)?.chatId, 'om_legacy')
    assert.equal(f.received.at(-1)?.silent, false)
    await f.incoming({ chat_id: 'oc_B', root_id: 'om_legacy', thread_id: 'omt_verified' })
    assert.equal(f.received.at(-1)?.chatId, 'oc_B')
    assert.equal(f.received.at(-1)?.silent, true)
    assert.equal((await f.card(action({ chatId: 'om_legacy' }, 'ou_user', 'oc_A'))).toast.type, 'success')
    assert.equal((await f.card(action({ chatId: 'om_legacy' }, 'ou_user', 'oc_B'))).toast.type, 'error')
  }
  f.states['feishu:om_legacy'] = { sessionId: 'feishu:om_legacy', segmentIndex: 0, reportTo: 'feishu:oc_B' }
  await f.incoming({ chat_id: 'oc_B', root_id: 'om_legacy', thread_id: 'omt_verified' })
  assert.equal(f.received.at(-1)?.chatId, 'oc_B')
  assert.equal(f.received.at(-1)?.silent, true)
  assert.equal((await f.channel.getCapabilities('om_legacy')).conversation, 'unknown')
  assert.equal((await f.card(action({ chatId: 'om_legacy' }, 'ou_user', 'oc_B'))).toast.type, 'error')
  assert.equal(answers.length, 2)
})

test('Feishu acknowledges a pending decision before three seconds without waiting for model work', async t => {
  const f = await fixture(t)
  const pending = Promise.withResolvers<string>()
  f.channel.setDecisionHandler(() => pending.promise)
  const started = performance.now()
  const response = await f.card(action())
  assert.equal(response.toast.type, 'info')
  assert.ok(performance.now() - started < 2_500)
  pending.resolve('Accepted later')
})

test('Feishu manager integration selects cards, authorizes the initiating sender, and validates fallback receipts', async t => {
  const f = await fixture(t, { allowFrom: ['ou_user', 'ou_other'] })
  await f.channel.stop()
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }),
    getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => {}, notifyParent: async () => {},
  })
  const sessions: Pick<SessionManager, 'yields' | 'getActiveSession'> = { yields, getActiveSession: () => undefined }
  const config = ConfigSchema.parse({ channels: { feishu: { enabled: true, appId: 'fixture', appSecret: 'fixture' } } })
  const manager = new ChannelManager(config, new Bus(), sessions as SessionManager,
    async () => ({ status: 'accepted', sessionId: request.sessionId, inputId: 'fixture' }), () => f.channel)
  await manager.init()
  await manager.startAll(new Hono())
  t.after(async () => { yields.stop(); await manager.stopAll() })
  const ask = () => {
    const waiting = yields.ask(request.sessionId, request, new AbortController().signal, { channel: 'feishu', senderId: 'ou_user' })
    const pending = yields.get(request.sessionId)!
    return {
      waiting, pending,
      outbound: { channel: 'feishu', chatId: 'oc_direct', event: 'response' as const, content: 'Text choices', done: true, yieldRequest: pending },
    }
  }
  const first = ask()
  await manager.deliverDecision(first.outbound)
  assert.equal(JSON.parse(f.requests.at(-1)!.body.content).elements.at(-1).tag, 'action')
  assert.equal((await f.card(action({ requestId: first.pending.id }, 'ou_other'))).toast.type, 'error')
  assert.equal((await f.card(action({ requestId: first.pending.id }))).toast.type, 'success')
  assert.equal((await first.waiting).option, 'Second')
  assert.equal((await f.card(action({ requestId: first.pending.id }))).toast.type, 'error')

  f.failNative()
  const second = ask()
  const count = f.requests.length
  await manager.deliverDecision(second.outbound)
  assert.equal(f.requests.length, count + 2)
  assert.doesNotMatch(f.requests.at(-1)!.body.content, /shadow_yield/)
  assert.equal((await f.card(action({ requestId: second.pending.id }))).toast.type, 'success')
  await second.waiting

  f.failSends()
  const third = ask()
  await assert.rejects(manager.deliverDecision(third.outbound), /not acknowledged/)
  const cancelled = assert.rejects(third.waiting, { name: 'AbortError' })
  yields.cancelChannel(request.sessionId, third.pending.id, 'feishu', 'ou_user')
  await cancelled
})
