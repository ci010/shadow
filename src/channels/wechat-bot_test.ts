import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { InboundMessage } from '../bus/events.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { botSetupPlugin } from './bot-setup.ts'
import { WeChatChannel } from './wechat.ts'
import { WeixinMessageItemType, WeixinMessageType } from './wechat/sdk.ts'
import { createBotSettingsClient, parseBotStatus, wechatLoginQr } from '../../app/src/bot-settings.ts'

function directory() {
  const root = join(process.cwd(), '.test-data', `wechat-bot-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  return root
}

test('WeChat store rejects service/default creation, role patches and persisted service records', () => {
  const root = directory(), path = join(root, 'bots.json')
  try {
    const store = new BotInstanceStore({ projectId: 'p', path })
    assert.throws(() => store.create('wechat', 'Invalid', {}, undefined, 'service'), /wechat_personal_bot_required/)
    assert.throws(() => store.create('wechat', 'Invalid default', {}), /wechat_personal_bot_required/)
    const bot = store.create('wechat', 'Owner', { enabled: false }, undefined, 'personal')
    assert.throws(() => store.update(bot.id, { purpose: 'service' }), /wechat_personal_bot_required/)
    assert.equal(store.get(bot.id).purpose, 'personal')
    assert.equal(parseBotStatus(store.status(bot.id), 'p').platform, 'wechat')
    writeFileSync(path, JSON.stringify({ version: 2, bots: [{ ...bot, enabled: undefined, purpose: 'service' }] }))
    assert.throws(() => new BotInstanceStore({ projectId: 'p', path }), /wechat_personal_bot_required/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('WeChat authenticated scoped QR flow feeds only paired owner DMs into existing Bot routing', async () => {
  const root = directory(), store = new BotInstanceStore({ projectId: 'p', path: join(root, 'bots.json') })
  const bus = new Bus(), received: InboundMessage[] = [], adapters: WeChatChannel[] = []
  const sessions = { listSessions: () => [], getSessionState: () => undefined, retireIdleConversationContexts: async () => {} } as unknown as SessionManager
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace: root } }), bus, sessions, async message => {
    received.push(message)
    return { status: 'accepted', sessionId: 'fixture', inputId: 'fixture' }
  }, { projectId: 'p', instanceStore: store, factory: (_platform, _config, bot) => {
    const adapter = new WeChatChannel(bus, { workspace: root, storageDirectory: join(root, bot!.id), scoped: true })
    adapter['_startMonitor'] = () => {} // No external network or parallel polling in this fixture.
    adapter['apiClient'].fetchQrCode = async () => ({ qrcode: 'synthetic', qrcode_img_content: 'https://fixture.invalid/qr.png' })
    adapter['apiClient'].fetchQrStatus = async () => ({ status: 'confirmed', ilink_bot_id: 'synthetic-account', bot_token: 'synthetic-secret', ilink_user_id: 'owner' })
    adapters.push(adapter)
    return adapter
  } })
  try {
    await manager.init()
    const app = new Hono()
    botSetupPlugin({ store, runtime: manager, authorize: req => req.headers.get('x-admin') === 'yes' })(app)
    await manager.startAll(app)
    const post = (path: string, body?: unknown, admin = true) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin': 'yes' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    assert.equal((await post('/api/channels', { platform: 'wechat', purpose: 'service', displayName: 'Invalid', config: {} })).status, 400)
    const bot = await manager.createBot({ platform: 'wechat', purpose: 'personal', displayName: 'Owner', config: { enabled: true } })
    assert.equal((await app.request('/wechat/login', { method: 'POST' })).status, 404)
    const base = `/api/channels/${bot.id}/wechat`
    assert.equal((await post(`${base}/login`, undefined, false)).status, 401)
    const qrResponse = await post(`${base}/login`)
    assert.equal(qrResponse.status, 200)
    assert.match(wechatLoginQr(await qrResponse.json()), /^data:image\/gif;base64,/)
    const login = await post(`${base}/wait`)
    assert.equal((await login.json()).connected, true)
    const adapter = adapters[0]
    const incoming = (content: string, message_id: number, from_user_id = 'owner') => adapter['_processMessage']({ message_id, from_user_id, message_type: WeixinMessageType.USER, item_list: [{ type: WeixinMessageItemType.TEXT, text_item: { text: content } }] }, 'owner')
    await assert.rejects(incoming('Before pairing', 1), /Verified owner/)
    const challenge = manager.createOwnerChallenge(bot.id)
    await incoming(`/shadow-pair ${challenge.challenge}`, 2)
    assert.equal(received.length, 0)
    await manager.confirmOwner(bot.id, challenge.challenge)
    await incoming('Hello', 3)
    await incoming('Stranger', 4, 'stranger')
    assert.equal(received.length, 1)
    assert.equal(received[0].isGroup, false)
    assert.equal(received[0].channelAddress?.botInstanceId, bot.id)
    assert.equal(received[0].admin, true)
    assert.equal(JSON.stringify(manager.botStatuses()).includes('synthetic-secret'), false)
    assert.equal((await post(`${base}/login`)).status, 400)
    const duplicate = await manager.createBot({ platform: 'wechat', purpose: 'personal', displayName: 'Duplicate', config: { enabled: true } })
    await post(`/api/channels/${duplicate.id}/wechat/login`)
    assert.equal((await post(`/api/channels/${duplicate.id}/wechat/wait`)).status, 400)
    assert.equal(adapters[1]['repository'].getLatestAccount(), null)
    assert.equal(adapter['repository'].getLatestAccount()?.accountId, 'synthetic-account')
    await manager.updateBot(bot.id, { config: { enabled: false } })
    await assert.rejects(manager.updateBot(bot.id, { purpose: 'service' }), /wechat_personal_bot_required/)
  } finally {
    await manager.stopAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('frontend refuses WeChat service creation before sending a request', async () => {
  let calls = 0
  const client = createBotSettingsClient('http://fixture', 'p', async () => { calls++; return Response.json({}) })
  await assert.rejects(client.create('wechat', 'Invalid', undefined, 'service'), /personal Bots only/)
  assert.equal(calls, 0)
  assert.throws(() => wechatLoginQr({ qrcodeUrl: '' }), /Invalid WeChat QR content/)
  assert.match(wechatLoginQr({ qrcodeUrl: 'https://fixture.invalid/scan?token=synthetic' }), /^data:image\/gif;base64,/)
})
