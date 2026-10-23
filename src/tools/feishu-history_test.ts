import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, deriveSessionId, type InboundMessage } from '../bus/events.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { FeishuChannel } from '../channels/feishu.ts'
import { Client } from '../channels/feishu/sdk.ts'
import { ChannelManager } from '../channels/manager.ts'
import { ConfigSchema } from '../config/schema.ts'
import { channelMessageInput, inputContext } from '../sessions/input.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { ChannelOperationsTool, FeishuHistoryTool, FeishuMessageGetTool, channelTools } from './channel.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { requireToolText } from './tool.ts'

function message(id = 'om_old', thread?: string, root?: string) {
  return {
    message_id: id, chat_id: 'oc_chat', root_id: root ?? '', parent_id: root ?? '', thread_id: thread ?? '',
    msg_type: 'text', create_time: '1791080000000', update_time: '1791080000000', deleted: false, updated: false,
    sender: { id: 'ou_actor', id_type: 'open_id', sender_type: 'user', tenant_key: 'not-returned' },
    body: { content: '{"text":"Historical message"}' }, mentions: [], secret_property: 'not-returned',
  }
}

async function fixture(t: TestContext, topic = false, direct = false) {
  const base = join(process.cwd(), '.test-data')
  await mkdir(base, { recursive: true })
  const workspace = await mkdtemp(join(base, 'feishu-history-'))
  const bus = new Bus()
  const store = new BotInstanceStore({ projectId: 'A', path: join(workspace, 'bots.json') })
  const bots = [0, 1].map(index => store.create('feishu', `Feishu ${index}`, {
    enabled: true, appId: `fixture-app-${index}`, appSecret: 'fixture-secret', allowFrom: ['ou_actor'],
  }))
  const states: Record<string, SessionState> = {}
  const address = (conversationId: string, bot = bots[0]) => ({
    projectId: 'A', botInstanceId: bot.id, platform: 'feishu', conversationId,
  })
  if (topic) {
    const id = channelSessionId(address('om_root'))
    states[id] = { sessionId: id, segmentIndex: 0, parentSessionId: channelSessionId(address('oc_chat')),
      parent: { id: channelSessionId(address('oc_chat')) } }
  }
  let source = message('om_source', topic ? 'omt_bound' : undefined, topic ? 'om_root' : undefined)
  let root: unknown = message('om_root', 'omt_bound')
  let history: unknown = { items: [message('om_old', topic ? 'omt_bound' : undefined, topic ? 'om_root' : undefined)], has_more: false }
  let selected: unknown = { items: [message('om_old', topic ? 'omt_bound' : undefined, topic ? 'om_root' : undefined)] }
  let members: (token: string | null) => unknown = () => ({
    items: [{ member_id_type: 'open_id', member_id: 'ou_actor', name: 'Actor', tenant_key: 'not-returned' }], has_more: false,
  })
  const calls: Array<{ url: URL; token: string | null; signal?: AbortSignal | null; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const token = new Headers(init?.headers).get('Authorization')
    calls.push({ url, token, signal: init?.signal, method: init?.method ?? 'GET' })
    if (url.pathname.includes('/auth/')) {
      const body = JSON.parse(String(init?.body))
      return Response.json({ code: 0, tenant_access_token: `token-${body.app_id}`, expire: 7200 })
    }
    if (url.pathname.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } })
    if (url.pathname.includes('/contact/')) return Response.json({ code: 0, data: { user: { name: 'Actor' } } })
    if (url.pathname.endsWith('/reactions')) return Response.json({ code: 0 })
    if (url.pathname.endsWith('/chats/oc_chat/members')) return Response.json({ code: 0, data: members(url.searchParams.get('page_token')) })
    if (url.pathname.endsWith('/chats/oc_chat')) return Response.json({ code: 0, data: { chat_mode: direct ? 'p2p' : 'group', chat_status: 'normal' } })
    if (url.pathname.endsWith('/messages/om_root')) return Response.json({ code: 0, data: { items: [root] } })
    if (url.pathname.endsWith('/messages/om_source')) return Response.json({ code: 0, data: { items: [source] } })
    if (url.pathname.endsWith('/messages/om_old')) return Response.json({ code: 0, data: selected })
    if (url.pathname.endsWith('/messages')) return Response.json({ code: 0, data: history })
    throw new Error(`Unexpected fixture URL ${url.pathname}`)
  })
  const events = new Map<string, (event: Record<string, unknown>) => void>()
  const channels = new Map<string, FeishuChannel>()
  let nextReceipt = Promise.withResolvers<InboundMessage>()
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, {} as SessionManager, async inbound => {
    nextReceipt.resolve(inbound)
    return { status: 'accepted', sessionId: deriveSessionId(inbound), inputId: inbound.messageId }
  }, { projectId: 'A', instanceStore: store, factory: (_name, config, bot) => {
    assert.ok(bot)
    const options = config.channels.feishu
    assert.ok(options?.appId && options.appSecret)
    const channel = new FeishuChannel(bus, {
      ...options, appId: options.appId, appSecret: options.appSecret, workspace,
      sessionManager: { getSessionState: id => states[id] ?? null },
      transportFactory: (_options, event, status) => {
        events.set(bot.id, event)
        return { start: () => status('running'), stop: async () => {} }
      },
    })
    channels.set(bot.id, channel)
    return channel
  } })
  t.after(async () => { await manager.stopAll(); await rm(workspace, { recursive: true, force: true }) })
  await manager.init()
  await manager.startAll(new Hono())
  const baseTools = new Tools(workspace)
  const tools = new SessionTools(baseTools, workspace)
  const importer = new ImportTool(new Map(), workspace)
  for (const tool of channelTools(manager)) importer.registerBuiltin(tool.name, tool)
  const invoke = new InvokeTool(importer)
  baseTools.register(invoke)
  t.after(() => tools.resetDynamic())
  async function incoming(bot = bots[0]): Promise<ExecutionContext> {
    nextReceipt = Promise.withResolvers<InboundMessage>()
    events.get(bot.id)!({
      sender: { sender_id: { open_id: 'ou_actor' } },
      message: { message_id: 'om_source', chat_id: 'oc_chat', chat_type: direct ? 'p2p' : 'group',
        message_type: 'text', content: '{"text":"@_user_1 read history"}',
        ...(topic ? { root_id: 'om_root', thread_id: 'omt_bound', parent_id: 'om_root' } : {}),
        mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1' }] },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const inbound = await Promise.race([nextReceipt.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native input was not admitted')), 2000)
      })])
      const id = deriveSessionId(inbound)
      return { ...inputContext(id, channelMessageInput(inbound)), projectId: 'A', sessionId: id,
        physicalSessionId: 'physical', inputSource: 'user', tools, signal: new AbortController().signal }
    } finally { clearTimeout(timer) }
  }
  const context = await incoming()
  await new Promise<void>(resolve => setImmediate(resolve))
  calls.length = 0
  return {
    manager, store, bots, states, address, channels, context, incoming, calls, importer, invoke,
    historyTool: new FeishuHistoryTool(manager), messageTool: new FeishuMessageGetTool(manager),
    discovery: new ChannelOperationsTool(manager),
    history(value: unknown) { history = value }, selected(value: unknown) { selected = value },
    root(value: unknown) { root = value }, source(value: typeof source) { source = value },
    members(value: typeof members) { members = value },
  }
}

test('Feishu advertises native reads and lazily reads bounded chat history with its own pagination', async t => {
  const f = await fixture(t)
  assert.deepEqual(JSON.parse(await f.discovery.execute({}, f.context)).operations, ['feishu_history', 'feishu_message_get'])
  f.history({ items: [message()], has_more: true, page_token: 'next+/=' })
  const result = JSON.parse(requireToolText(await f.invoke.execute({ name: 'feishu_history', args: { limit: 1, pageToken: 'previous+/=' } }, f.context)))
  assert.equal(result.nextPageToken, 'next+/=')
  assert.equal(result.messages[0].id, 'om_old')
  assert.equal(result.messages[0].sender.tenant_key, undefined)
  assert.equal(result.messages[0].secret_property, undefined)
  assert.match(result.contentNotice, /not a human OAuth grant/)
  const call = f.calls.at(-1)!
  assert.equal(call.url.searchParams.get('container_id_type'), 'chat')
  assert.equal(call.url.searchParams.get('container_id'), 'oc_chat')
  assert.equal(call.url.searchParams.get('page_size'), '1')
  assert.equal(call.url.searchParams.get('page_token'), 'previous+/=')
  assert.equal(call.url.searchParams.get('sort_type'), 'ByCreateTimeDesc')
  assert.ok(f.calls.every(call => call.token === 'Bearer token-fixture-app-0' && call.signal))
  assert.equal(f.calls.every(call => call.method === 'GET'), true)
})

test('a persisted bound topic child reads its exact omt_ thread, never its parent chat or another bot', async t => {
  const f = await fixture(t, true)
  assert.equal(f.context.chatId, 'om_root')
  assert.ok(f.states[f.context.sessionId].parent)
  const result = JSON.parse(await f.historyTool.execute({}, f.context))
  assert.equal(result.conversationId, 'om_root')
  assert.equal(result.threadId, 'omt_bound')
  assert.equal(f.calls.at(-1)?.url.searchParams.get('container_id_type'), 'thread')
  assert.equal(f.calls.at(-1)?.url.searchParams.get('container_id'), 'omt_bound')
  assert.equal(f.calls.at(-1)?.url.searchParams.get('page_size'), '20')
  assert.ok(f.calls.every(call => call.token === 'Bearer token-fixture-app-0'))
  assert.equal(JSON.parse(await f.messageTool.execute({ messageId: 'om_old' }, f.context)).message.threadId, 'omt_bound')
  f.states[f.context.sessionId].parentSessionId = channelSessionId(f.address('oc_chat', f.bots[1]))
  await assert.rejects(f.historyTool.execute({}, f.context), /explicit current-bot parent binding/)
  f.states[f.context.sessionId].parentSessionId = channelSessionId(f.address('oc_chat'))
  f.root({ ...message('om_root', 'omt_bound'), chat_id: 'oc_other' })
  await assert.rejects(f.historyTool.execute({}, f.context), /root message/)
  f.root(message('om_root'))
  await assert.rejects(f.historyTool.execute({}, f.context), /root message/)
})

test('Feishu rejects cross-chat, cross-topic and merged-forward results without widening the topic binding', async t => {
  const f = await fixture(t, true)
  for (const item of [{ ...message('om_old', 'omt_bound'), chat_id: 'oc_other' },
    message('om_old', 'omt_other'), message('om_old'),
    message('om_old', 'omt_bound', 'om_other_root')]) {
    f.history({ items: [item], has_more: false })
    await assert.rejects(f.historyTool.execute({}, f.context), /outside/)
    f.selected({ items: [item] })
    await assert.rejects(f.messageTool.execute({ messageId: 'om_old' }, f.context), /outside/)
  }
  f.selected({ items: [message('om_old', 'omt_bound'), { ...message('om_forwarded', 'omt_bound'), chat_id: 'oc_other' }] })
  await assert.rejects(f.messageTool.execute({ messageId: 'om_old' }, f.context), /outside/)
  f.selected({ items: [message('om_wrong', 'omt_bound')] })
  await assert.rejects(f.messageTool.execute({ messageId: 'om_old' }, f.context), /requested message/)
})

test('Feishu verifies source identity and fresh group membership, including pagination and malformed cursors', async t => {
  const f = await fixture(t)
  f.members(token => token ? { items: [{ member_id_type: 'open_id', member_id: 'ou_actor' }], has_more: false }
    : { items: [], has_more: true, page_token: 'member-next' })
  await f.historyTool.execute({}, f.context)
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/members')).length, 2)
  f.members(() => ({ items: [], has_more: false }))
  f.calls.length = 0
  await assert.rejects(f.historyTool.execute({}, { ...f.context, admin: true }), /no longer a member/)
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/messages')), false)
  f.members(() => ({ items: [], has_more: true, page_token: 'same' }))
  await assert.rejects(f.historyTool.execute({}, f.context), /membership pagination/)
  f.source({ ...message('om_source'), sender: { ...message().sender, id: 'ou_other' } })
  await assert.rejects(f.historyTool.execute({}, f.context), /current sender/)
  await assert.rejects(f.historyTool.execute({}, { ...f.context, platformMessageId: undefined }), /native user message/)
})

test('a direct chat verifies its native source without pretending to have Discord role permissions', async t => {
  const f = await fixture(t, false, true)
  assert.equal(JSON.parse(await f.historyTool.execute({}, f.context)).threadId, null)
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/members')), false)
  f.source({ ...message('om_source'), chat_id: 'oc_other' })
  await assert.rejects(f.historyTool.execute({}, f.context), /outside/)
})

test('native thread scope does not grant internal virtual subagents, peers or event inputs read access', async t => {
  const f = await fixture(t, true)
  for (const context of [
    { ...f.context, sessionId: 'virtual:child', inputSource: 'session' as const },
    { ...f.context, inputSource: 'session' as const }, { ...f.context, inputSource: 'event' as const },
    { ...f.context, channelAddress: { ...f.context.channelAddress!, conversationId: 'oc_chat' } },
    { ...f.context, projectId: 'B' },
  ]) await assert.rejects(f.historyTool.execute({}, context))
  assert.equal(f.calls.length, 0)
  f.source(message('om_source', 'omt_bound', 'om_root'))
  const parent = { ...f.context, chatId: 'oc_chat', channelAddress: f.address('oc_chat'), sessionId: channelSessionId(f.address('oc_chat')) }
  await assert.rejects(f.historyTool.execute({}, parent), /cannot read parent-chat/)
})

test('Feishu argument, response and pagination contracts keep platform limits and surface malformed data', async t => {
  const f = await fixture(t)
  for (const args of [{ limit: 51 }, { limit: 0 }, { limit: 1.5 }, { before: '800' }, { threadId: 'omt_other' },
    { botInstanceId: f.bots[1].id }, { pageToken: '' }, { pageToken: 'x'.repeat(4097) }, { start_time: '1' }]) {
    await assert.rejects(f.historyTool.execute(args, f.context))
  }
  for (const args of [{ messageId: '../om_old' }, { messageId: 'om_old', chatId: 'oc_other' }]) {
    await assert.rejects(f.messageTool.execute(args, f.context))
  }
  assert.equal(f.calls.length, 0)
  f.history({ items: Array.from({ length: 50 }, (_, i) => message(`om_${i}`)), has_more: false })
  assert.equal(JSON.parse(await f.historyTool.execute({ limit: 50 }, f.context)).messages.length, 50)
  await assert.rejects(f.historyTool.execute({ limit: 49 }, f.context), /Invalid Feishu history/)
  for (const data of [{ items: [], has_more: true }, { items: [], has_more: true, page_token: 'repeat' },
    { items: [{}], has_more: false }, { items: [], has_more: 'false' },
    { items: [message(), message()], has_more: false },
    { items: [{ ...message('om_first'), create_time: '1' }, { ...message('om_second'), create_time: '2' }], has_more: false }]) {
    f.history(data)
    await assert.rejects(f.historyTool.execute({ pageToken: 'repeat' }, f.context), /Invalid Feishu history/)
  }
})

test('Feishu scope failures and API errors stay sanitized failures rather than empty history', async t => {
  const f = await fixture(t)
  for (const response of [
    () => Response.json({ code: 230027, msg: 'fixture-secret-private-message' }),
    () => Response.json({ code: 230073, msg: 'fixture-secret-private-message' }, { status: 403 }),
    () => Response.json({ code: 'fixture-secret-private-message', msg: 'private' }, { status: 403 }),
    () => new Response('fixture-secret-private-message', { status: 200 }),
    () => new Response('fixture-secret-private-message', { status: 429 }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response())
    await assert.rejects(f.historyTool.execute({}, f.context), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes('fixture-secret'))
      assert.match(error.message, /Feishu/)
      return true
    })
  }
})

test('read cancellation does not wait for shared token acquisition, and disconnect aborts the credential request', async t => {
  const response = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  let signal: AbortSignal | null | undefined
  let calls = 0
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    calls++
    signal = init?.signal
    entered.resolve()
    return response.promise
  })
  const connection = new AbortController()
  const invocation = new AbortController()
  const client = new Client({ appId: 'fixture', appSecret: 'fixture-secret', signal: connection.signal })
  const pending = client.im.message.get({ path: { message_id: 'om_source' }, signal: invocation.signal })
  const rejected = assert.rejects(pending, /cancelled/)
  await entered.promise
  invocation.abort(new Error('cancelled'))
  await rejected
  assert.equal(calls, 1)
  connection.abort()
  assert.equal(signal?.aborted, true)
  response.resolve(Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
})

for (const action of ['cancel', 'replace', 'stop'] as const) {
  test(`Feishu ${action} rejects a late native history response and preserves exact bot ownership`, async t => {
    const f = await fixture(t, true)
    const original = globalThis.fetch
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/messages')) {
        signal = init?.signal
        entered.resolve()
        return response.promise
      }
      return original(input, init)
    })
    const controller = new AbortController()
    const pending = f.historyTool.execute({}, { ...f.context, signal: controller.signal })
    const rejected = assert.rejects(pending, /abort|connection|unavailable/i)
    await entered.promise
    if (action === 'cancel') controller.abort()
    else if (action === 'replace') await f.manager.updateBot(f.bots[0].id, { config: { enabled: false } })
    else await f.manager.stopAll()
    assert.equal(signal?.aborted, true)
    response.resolve(Response.json({ code: 0, data: { items: [message('om_old', 'omt_bound')], has_more: false } }))
    await rejected
    assert.ok(f.calls.filter(call => call.url.pathname.includes('/messages/')).every(call => call.token === 'Bearer token-fixture-app-0'))
  })
}
