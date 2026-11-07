import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { QQChannel } from './qq.ts'
import { FeishuChannel } from './feishu.ts'

class RestQQ extends QQChannel {
  override async start(_app: Hono): Promise<void> { this.setAccepting(true); this.reportState('running') }
}
async function fixture(t: TestContext, workspace: string, platform: 'qq' | 'feishu') {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  let response = () => Response.json(platform === 'qq' ? { id: 'qq-receipt' } : { code: 0, data: { message_id: 'om_receipt' } })
  let permission = 'all', assigned = true
  let beforeMetadata: (() => void) | undefined
  let beforeToken: (() => void) | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    init?.signal?.throwIfAborted()
    if (url.hostname === 'bots.qq.com') { beforeToken?.(); init?.signal?.throwIfAborted(); return Response.json({ access_token: 'synthetic', expires_in: 7200 }) }
    if (url.pathname.includes('/auth/')) { beforeToken?.(); init?.signal?.throwIfAborted(); return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 }) }
    if (url.pathname.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } })
    if (url.pathname.includes('/chats/')) { beforeMetadata?.(); return Response.json({ code: 0, data: { chat_mode: 'group', chat_status: 'normal', chat_post_permission: permission } }) }
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
    return response()
  })
  const projectId = 'project'
  const store = new BotInstanceStore({ projectId, path: join(workspace, 'bot-send-fixture.json') })
  const appId = `synthetic-${randomUUID()}`
  const config = platform === 'qq' ? { appId, secret: 'synthetic', enabled: true } : { appId, appSecret: 'synthetic', enabled: true }
  const bot = store.create(platform, 'synthetic', config, undefined, 'service')
  const address: ChannelAddress = { projectId, platform, botInstanceId: bot.id, conversationId: platform === 'qq' ? 'group:one' : 'oc_group' }
  const states: Record<string, SessionState> = {}
  const sessions = { getSessionState: (id: string) => states[id], listSessions: () => [], retireIdleConversationContexts: async () => {} } as unknown as SessionManager
  const bus = new Bus()
  let outbound = 0
  bus.on('message.outbound', () => { outbound++ })
  const adapter = platform === 'qq' ? new RestQQ(bus, { appId, secret: 'synthetic' })
    : new FeishuChannel(bus, { appId, appSecret: 'synthetic', sessionManager: sessions,
      transportFactory: (_options, _event, status) => ({ start: () => status('running'), stop: async () => {} }) })
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions,
    async message => ({ status: 'accepted', sessionId: 'fixture', inputId: message.messageId }), {
      projectId, instanceStore: store, factory: () => adapter,
      serviceAssigned: value => assigned && value.conversationId === address.conversationId,
    })
  await manager.init(); await manager.startAll(new Hono())
  t.after(() => manager.stopAll())
  return { manager, adapter, store, bot, address, requests, states, bus, outbound: () => outbound,
    fail: (value: () => Response) => { response = value }, permission: (value: string) => { permission = value },
    revoke: () => { assigned = false }, beforeMetadata: (value: () => void) => { beforeMetadata = value }, beforeToken: (value: () => void) => { beforeToken = value } }
}
const signal = () => new AbortController().signal

for (const platform of ['qq', 'feishu'] as const) {
  test(`${platform} explicit SDK adapter sends only original destination and returns actual receipt without bus output`, async t => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(t, workspace, platform)
      try {
        assert.deepEqual(await f.manager.sendBotText(f.address, 'hello', signal()), { id: platform === 'qq' ? 'qq-receipt' : 'om_receipt' })
        assert.equal(f.requests.length, 1)
        const request = f.requests[0]!
        assert.equal(request.path, platform === 'qq' ? '/v2/groups/one/messages' : '/open-apis/im/v1/messages')
        if (platform === 'qq') {
          assert.equal(request.body.msg_id, undefined); assert.equal(request.body.msg_seq, undefined)
          assert.deepEqual(request.body.markdown, { content: 'hello' })
        } else { assert.equal(request.body.receive_id, 'oc_group'); assert.deepEqual(JSON.parse(String(request.body.content)), { text: 'hello' }) }
        assert.equal(f.outbound(), 0)
        for (const address of [{ ...f.address, projectId: 'foreign' }, { ...f.address, botInstanceId: 'foreign' }, { ...f.address, conversationId: 'foreign' }, { ...f.address, platform: 'discord' as const }]) await assert.rejects(f.manager.sendBotText(address, 'must not send', signal()))
        assert.equal(f.requests.length, 1)
        f.revoke()
        await assert.rejects(f.manager.sendBotText(f.address, 'must not send', signal()), /assignment/)
        assert.equal(f.requests.length, 1)
      } finally { await f.manager.stopAll() }
    })
  })
  test(`${platform} explicit SDK adapter propagates platform errors and missing receipts without fallback`, async t => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(t, workspace, platform)
      try {
        f.fail(() => platform === 'qq' ? Response.json({ code: 304023, message: 'push quota denied' }, { status: 403 }) : Response.json({ code: 230002, msg: 'permission denied' }))
        await assert.rejects(f.manager.sendBotText(f.address, 'one', signal()))
        assert.equal(f.requests.length, 1, 'No formatting/reply fallback or retry')
        f.fail(() => platform === 'qq' ? Response.json({}) : Response.json({ code: 0, data: {} }))
        await assert.rejects(f.manager.sendBotText(f.address, 'two', signal()))
        assert.equal(f.requests.length, 2)
        assert.equal(f.outbound(), 0)
      } finally { await f.manager.stopAll() }
    })
  })
  test(`${platform} explicit SDK adapter honors cancellation and disconnected/disabled state`, async t => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(t, workspace, platform)
      try {
        const cancelled = new AbortController(); cancelled.abort()
        await assert.rejects(f.manager.sendBotText(f.address, 'cancelled', cancelled.signal), /abort/i)
        assert.equal(f.requests.length, 0)
        const inFlight = new AbortController()
        f.beforeToken(() => inFlight.abort())
        // QQ has not acquired a token during fixture startup; Feishu may have.
        if (platform === 'feishu') f.beforeMetadata(() => inFlight.abort())
        await assert.rejects(f.manager.sendBotText(f.address, 'cancel while authorizing', inFlight.signal), /abort/i)
        assert.equal(f.requests.length, 0)
        f.store.update(f.bot.id, { config: { enabled: false } })
        await assert.rejects(f.manager.sendBotText(f.address, 'disabled', signal()), /available/)
        assert.equal(f.requests.length, 0)
        await f.manager.stopAll()
        await assert.rejects(f.manager.sendBotText(f.address, 'disconnected', signal()))
        assert.equal(f.requests.length, 0)
      } finally { await f.manager.stopAll() }
    })
  })
}

test('QQ explicit group/C2C path never fabricates passive credentials; unsupported guild fails before request', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, 'qq')
    try {
      assert.deepEqual(await (f.adapter as QQChannel).sendExplicitText('c2c:alice', 'direct', signal()), 'qq-receipt')
      assert.equal(f.requests[0]!.path, '/v2/users/alice/messages')
      assert.equal(f.requests[0]!.body.msg_id, undefined)
      await assert.rejects((f.adapter as QQChannel).sendExplicitText('channel:guild', 'unsupported', signal()), /only original group\/C2C/)
      assert.equal(f.requests.length, 1)
    } finally { await f.manager.stopAll() }
  })
})

test('Feishu refreshes posting permission and never falls back from an invalid original thread', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, 'feishu')
    try {
      f.permission('only_owner')
      await assert.rejects(f.manager.sendBotText(f.address, 'denied', signal()), /permission/)
      assert.equal(f.requests.length, 0)
      f.permission('all')
      const thread = { ...f.address, conversationId: 'om_root' }
      f.states[channelSessionId(thread)] = { sessionId: channelSessionId(thread), segmentIndex: 0, parentSessionId: channelSessionId(f.address) }
      f.fail(() => Response.json({ code: 230001, msg: 'invalid thread' }))
      await assert.rejects((f.adapter as FeishuChannel).sendExplicitText('om_root', 'thread', signal()))
      assert.equal(f.requests.length, 1)
      assert.equal(f.requests[0]!.path, '/open-apis/im/v1/messages/om_root/reply')
      assert.equal(f.requests[0]!.body.reply_in_thread, true)
      assert.equal(f.requests[0]!.body.receive_id, undefined)
      await assert.rejects((f.adapter as FeishuChannel).sendExplicitText('om_unknown', 'unknown', signal()), /original chat/)
      assert.equal(f.requests.length, 1)
    } finally { await f.manager.stopAll() }
  })
})

test('Feishu service assignment revoked while metadata resolves prevents the platform mutation', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, 'feishu')
    try {
      f.beforeMetadata(() => f.revoke())
      await assert.rejects(f.manager.sendBotText(f.address, 'must not send', signal()), /assignment/)
      assert.equal(f.requests.length, 0)
    } finally { await f.manager.stopAll() }
  })
})

for (const platform of ['qq', 'feishu'] as const) test(`${platform} connection loss after a platform reply never returns success`, async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, platform)
    try {
      f.fail(() => { void f.adapter.stop(); return Response.json(platform === 'qq' ? { id: 'late-id' } : { code: 0, data: { message_id: 'om_late' } }) })
      await assert.rejects(f.manager.sendBotText(f.address, 'late response', signal()))
      assert.equal(f.requests.length, 1)
      assert.equal(f.outbound(), 0)
    } finally { await f.manager.stopAll() }
  })
})

test('QQ assignment revoked while token resolves is rechecked before POST', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, 'qq')
    try {
      f.beforeToken(() => f.revoke())
      await assert.rejects(f.manager.sendBotText(f.address, 'must not send', signal()), /assignment/)
      assert.equal(f.requests.length, 0)
    } finally { await f.manager.stopAll() }
  })
})
