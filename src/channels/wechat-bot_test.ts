import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { channelSessionId, type InboundMessage, type OutboundMessage } from '../bus/events.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { parseBot } from '../bots/sdk.ts'
import { assignChannelSource } from '../bots/channel-assignment.ts'
import { validateServiceAssignments } from '../bots/assignment-validation.ts'
import { stampPersonalOutput } from '../bots/personal-output.ts'
import { botConversationPolicies } from './bot-policies.ts'
import { passiveChannelId, type ChannelSource } from './passive-contract.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { channelMessageInput } from '../sessions/input.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { botSetupPlugin } from './bot-setup.ts'
import { WeChatChannel } from './wechat.ts'
import { WeixinMessageItemType, WeixinMessageType } from './wechat/sdk.ts'
import { parseBotStatus, wechatLoginQr } from '../../app/src/bot-settings.ts'

function directory() {
  const root = join(process.cwd(), '.test-data', `wechat-bot-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  return root
}

test('WeChat QR plus exact Personal direct assignment routes fresh verified arrivals and leases replies', async () => {
  const root = directory(), store = new BotInstanceStore({ projectId: 'p', path: join(root, 'bots.json') })
  const bus = new Bus(), received: InboundMessage[] = [], adapters: WeChatChannel[] = []
  const recorded: string[] = [], sources = new Map<string, ChannelSource>(), seen = new Set<string>()
  const captureStarted = Promise.withResolvers<void>(), finishCapture = Promise.withResolvers<void>()
  const deployments = new BotDeployments({ projectId: 'p', directory: join(root, 'deployments'), runGit: async () => { throw new Error('No git') } })
  const bots = new DirectoryBots(deployments)
  let execution = { enabled: true, generation: '0' }
  bots.setExecutionPolicy(() => execution)
  const policies = botConversationPolicies(store, { resolve: () => undefined } as never, bots)
  const sessions = { listSessions: () => [], getSessionState: () => undefined, retireIdleConversationContexts: async () => {},
    recordPassiveChannel: async (source: ChannelSource, message: InboundMessage) => {
      const sessionId = passiveChannelId(source), key = JSON.stringify([sessionId, message.messageId])
      if (seen.has(key)) return { status: 'accepted', inputId: message.messageId, disposition: 'filtered' }
      seen.add(key); sources.set(sessionId, source); recorded.push(message.content)
      if (message.messageId === '1') { captureStarted.resolve(); await finishCapture.promise }
      return { status: 'accepted', inputId: message.messageId }
    },
  } as unknown as SessionManager
  const strategies: string[] = [], sent: string[] = []
  const inputs = channelInputFixture({ projectId: 'p', bots: store, directory: bots, receive: async message => {
    const id = channelSessionId(message.channelAddress!)
    policies.authorize(id, channelMessageInput(message))
    received.push(message)
    return { status: 'accepted', sessionId: id, inputId: message.messageId }
  } })
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace: root } }), bus, sessions, inputs.receive, {
    projectId: 'p', instanceStore: store,
    personalInboxAssigned: address => bots.personalInbox(address)?.enabled === true,
    serviceGeneration: address => bots.personalInbox(address)?.generation,
    routeInputPolicy: (message, run) => inputs.policy(message, async configuration => {
      assert.deepEqual(configuration, { platform: 'wechat' }); strategies.push(message.messageId); await run(configuration)
    }),
    factory: (_platform, _config, bot) => {
    const adapter = new WeChatChannel(bus, { workspace: root, storageDirectory: join(root, bot!.id), scoped: true })
    adapter['_startMonitor'] = () => {} // No external network or parallel polling in this fixture.
    adapter['apiClient'].fetchQrCode = async () => ({ qrcode: 'synthetic', qrcode_img_content: 'https://fixture.invalid/qr.png' })
    adapter['apiClient'].fetchQrStatus = async () => ({ status: 'confirmed', ilink_bot_id: 'synthetic-account', bot_token: 'synthetic-secret', ilink_user_id: 'owner' })
    adapter['apiClient'].sendMessage = async (_url, _token, body) => {
      assert.equal(body.msg.context_token, 'context-3'); sent.push(body.msg.to_user_id ?? '')
    }
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
    const bot = await manager.createBot({ platform: 'wechat', displayName: 'WeChat', config: { enabled: true } })
    assert.equal(parseBotStatus(bot, 'p').platform, 'wechat')
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
    const unassigned = incoming('Linked user', 1)
    await captureStarted.promise
    const source = [...sources.values()][0]!, id = passiveChannelId(source)
    const files = { 'BOT.md': '---\nid: personal\nmode: personal\nagent: general\nconfig: bot.json\n---\nPersonal instructions.',
      'bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }) }
    const policy = { enabled: true, trigger: 'mention', tools: [] }
    assert.throws(() => assignChannelSource(files, { ...source, kind: 'group' }, policy), /direct/)
    assert.throws(() => assignChannelSource({ ...files, 'BOT.md': files['BOT.md'].replace('mode: personal\nagent: general', 'mode: service') }, source, policy), /Personal BOT/)
    const assigned = assignChannelSource(files, source, policy)
    const definition = parseBot(assigned.files)
    assert.throws(() => parseBot({ ...assigned.files, 'BOT.md': assigned.files['BOT.md'].replace('mode: personal\nagent: general', 'mode: service') }), /Personal BOT/)
    const validate = (lookup?: (id: string) => ChannelSource | undefined) => validateServiceAssignments('p', store, definition, [], async () => {}, lookup)
    await assert.rejects(validate(), /host-recorded direct inbox/)
    await assert.rejects(validate(() => ({ ...source, connectionId: 'different' })), /origin mismatch/)
    await validate(sessionId => sources.get(sessionId))
    const deploymentSource = { folderId: 'fixture', directory: '' }
    await deployments.deploy({ id: definition.id, source: deploymentSource, ...deployments.freeze(assigned.files) })
    finishCapture.resolve(); await unassigned
    await incoming('Replayed receipt', 1)
    await incoming('Other sender', 2, 'stranger')
    assert.deepEqual(recorded, ['Linked user', 'Other sender'])
    assert.equal(received.length, 0, 'Neither a replay nor a different unbound private inbox may execute')
    assert.deepEqual(strategies, [])
    await adapter['_processMessage']({ message_id: 3, from_user_id: 'owner', message_type: WeixinMessageType.USER, context_token: 'context-3',
      item_list: [{ type: WeixinMessageItemType.TEXT, text_item: { text: 'Assigned next arrival' } }] })
    assert.deepEqual(strategies, ['3'])
    assert.equal(received.length, 1)
    assert.equal(received[0]?.admin, false)
    assert.equal(received[0]?.isGroup, false)
    assert.equal(channelSessionId(received[0]!.channelAddress!), id)
    assert.equal(policies.personal?.(id)?.agent, 'general')
    await assert.rejects(inputs.receive({ ...received[0]!, isGroup: true }), /verified direct arrival/)
    await assert.rejects(inputs.receive({ ...received[0]!, senderId: 'different' }), /verified direct arrival/)
    await assert.rejects(inputs.receive({ ...received[0]!, channelInputGuard: undefined }), /verified direct arrival/)
    const room = { message_id: 4, from_user_id: 'owner', message_type: WeixinMessageType.USER, group_id: 'room', context_token: 'group-token' }
    await adapter['_processMessage'](room)
    assert.equal(received.length, 1)
    await adapter['_processMessage']({ message_id: 5, from_user_id: 'synthetic-account', to_user_id: 'owner', message_type: WeixinMessageType.BOT,
      item_list: [{ type: WeixinMessageItemType.TEXT, text_item: { text: 'Own platform echo' } }] }, 'owner')
    assert.equal(recorded.includes('Own platform echo'), true)
    assert.equal(received.length, 1, 'Own echoes are recorded without a BOT feedback loop')
    const address = received[0]!.channelAddress!, guard = policies.personal?.(id)?.assertCurrent
    assert.ok(guard)
    const reply: OutboundMessage = { channel: 'wechat', channelAddress: address, chatId: address.conversationId, event: 'response', content: 'reply', done: true }
    await assert.rejects(manager.deliver(reply), /lease required/)
    const leased = stampPersonalOutput(reply, guard)
    await manager.deliver(leased)
    execution = { enabled: false, generation: '1' }
    await assert.rejects(manager.deliver(leased), /no longer active/)
    execution = { enabled: true, generation: '2' }
    await assert.rejects(manager.deliver(leased), /execution changed/)
    await assert.rejects(inputs.receive(received[0]!), /Arrival assignment changed/)
    const currentGuard = policies.personal?.(id)?.assertCurrent
    assert.ok(currentGuard)
    const atSend = Promise.withResolvers<void>(), finishSend = Promise.withResolvers<void>()
    const check = adapter['assertDelivery'].bind(adapter)
    adapter['assertDelivery'] = async () => { atSend.resolve(); await finishSend.promise; await check() }
    const pending = manager.deliver(stampPersonalOutput(reply, currentGuard))
    const rejectedSend = assert.rejects(pending, /WeChat delivery failed: local_failure/)
    await Promise.race([atSend.promise, pending.then(() => assert.fail('Expected the final iLink delivery guard'))])
    execution = { enabled: true, generation: '3' }
    finishSend.resolve()
    await rejectedSend
    assert.deepEqual(sent, ['owner'], 'a stale or absent lease never crosses the iLink send boundary')
    assert.equal(JSON.stringify(manager.botStatuses()).includes('synthetic-secret'), false)
    const duplicate = await manager.createBot({ platform: 'wechat', displayName: 'Duplicate', config: { enabled: true } })
    await post(`/api/channels/${duplicate.id}/wechat/login`)
    assert.equal((await post(`/api/channels/${duplicate.id}/wechat/wait`)).status, 400)
    assert.equal(adapters[1]['repository'].getLatestAccount(), null)
    adapter['apiClient'].fetchQrStatus = async () => ({ status: 'confirmed', ilink_bot_id: 'different-account', bot_token: 'different-secret' })
    await post(`${base}/login`)
    assert.equal((await post(`${base}/wait`)).status, 400, 'A different account cannot inherit an assigned inbox')
    assert.equal(adapter['repository'].getLatestAccount()?.accountId, 'synthetic-account')
    await manager.updateBot(bot.id, { config: { enabled: false } })
  } finally {
    finishCapture.resolve()
    await manager.stopAll(); bus.stopAll()
    rmSync(root, { recursive: true, force: true })
  }
})
