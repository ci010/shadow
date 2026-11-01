import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { deriveSessionId, type InboundMessage } from '../bus/events.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { parseBot } from '../bots/sdk.ts'
import { channelMessageEnvelope } from '../channels/input.ts'

for (const platform of ['qq', 'feishu', 'discord'] as const) test(`${platform}: deployed subscriptions precede BOT filters and Session entry; no full-feature fallback`, async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'routing', bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
    const bot = bots.create(platform, 'fixture', { enabled: true, ...(platform === 'qq' ? { appId: 'test', secret: 'test' } : platform === 'feishu' ? { appId: 'test', appSecret: 'test' } : { token: 'test' }) })
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), validate: files => { parseBot({ ...files }) },  runGit: async () => { throw new Error('No git') } })
    const directory = new DirectoryBots(deployments)
    const binding = platform === 'discord' ? { platform, id: randomUUID(), botInstanceId: bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '201' },
      enabled: true, trigger: 'mention', participants: { everyone: false, userIds: ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: true, manage: false }
      : { platform, botInstanceId: bot.id, conversationId: 'group:one', tools: [], allowFrom: ['500'] }
    const received: InboundMessage[] = []
    const inputs = channelInputFixture({ projectId, bots, directory, receive: async message => {
      received.push(message); return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
    } })
    const chatId = platform === 'discord' ? '203' : 'group:one'
    const message: InboundMessage = { channel: platform, chatId, channelAddress: { projectId, botInstanceId: bot.id, platform, conversationId: chatId },
      senderId: '500', isGroup: true, admin: false, messageId: 'input', platformMessageId: 'native-reply', content: 'hello', media: ['fixture-image'], timestamp: new Date().toISOString(),
      ...(platform === 'discord' ? { channelAdmissionId: 'entry-proof', channelLocation: { id: chatId, name: 'thread', type: 11, parentId: '201', parentName: 'parent', guildId: '100', guildName: 'guild', recipientId: null } } : {}) }
    const deploy = async (subscriptions?: unknown[], id = 'support') => {
      const frozen = deployments.freeze({ 'BOT.md': `---\nid: ${id}\nconfig: bot.json\n---\nSupport`, 'bot.json': JSON.stringify({ mode: 'service', model: 'chosen', allowedModules: [], tools: [], bindings: [binding], ...(subscriptions ? { subscriptions } : {}) }) })
      await deployments.deploy({ id, source: { folderId: 'fixture', directory: '' }, ...frozen, expectedRevision: deployments.read(id)?.deployment.revision })
    }
    await assert.rejects(inputs.receive(message), /subscription/)
    assert.equal(received.length, 0)
    await deploy([])
    await assert.rejects(inputs.receive(message), /subscription/)
    assert.equal(directory.discord().bindings.every(binding => !binding.enabled), true)
    await deploy() // Legacy omission preserves the old exact binding, no new authority.
    assert.equal((await inputs.receive({ ...message, silent: true })).disposition, 'filtered')
    assert.equal(received.length, 0)
    if (platform !== 'discord') await assert.rejects(inputs.receive({ ...message, senderId: 'stranger' }), /not authorized/)
    await assert.rejects(inputs.receive({ ...message, channelAddress: { ...message.channelAddress!, projectId: 'other' } }), /Project/)
    assert.equal(received.length, 0)
    const receipt = await inputs.receive(message)
    assert.equal(receipt.sessionId, deriveSessionId(message))
    assert.equal(received[0], message, 'Reply identity, media, thread and native admission must not be reconstructed or lost')
    const definition = directory.definition('support')
    assert.ok(definition?.mode === 'service')
    assert.equal(definition.model, 'chosen')
    await inputs.receive({ ...message, messageId: 'forged-admin', admin: true })
    assert.equal(received[1]?.admin, false, 'Selected Service handler never imports payload admin authority')
    assert.equal(received[1]?.media, message.media)
    await deploy(undefined, 'competitor')
    await assert.rejects(inputs.receive(message), /conflicting/)
    assert.equal(received.length, 2)
  })
})

for (const platform of ['qq', 'feishu', 'discord', 'wechat'] as const) test(`${platform}: personal listener requires exact current verified owner DM before ordinary Session delivery`, async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', bots = new BotInstanceStore({ projectId, path: join(workspace, 'bots.json') })
    const config = platform === 'qq' ? { appId: 'test', secret: 'test' } : platform === 'feishu' ? { appId: 'test', appSecret: 'test' } : platform === 'discord' ? { token: 'test' } : {}
    const bot = bots.create(platform, 'owner', { enabled: true, ...config }, undefined, 'personal')
    bots.bindOwner(bot.id, 'owner', 'c2c:owner')
    const directory = new DirectoryBots(new BotDeployments({ projectId, directory: join(workspace, 'deployments') }))
    let received = 0
    const inputs = channelInputFixture({ projectId, bots, directory, receive: async message => { received++; return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId } } })
    const message: InboundMessage = { channel: platform, chatId: 'c2c:owner', channelAddress: { projectId, platform, botInstanceId: bot.id, conversationId: 'c2c:owner' }, senderId: 'owner', isGroup: false, messageId: 'one', content: 'hello', timestamp: new Date().toISOString() }
    let policies = 0
    const policy = async () => { policies++ }
    for (const changed of [{ senderId: 'stranger' }, { isGroup: true }, { chatId: 'another', channelAddress: { ...message.channelAddress!, conversationId: 'another' } }]) {
      await assert.rejects(inputs.receive({ ...message, ...changed }), /owner/)
      await assert.rejects(inputs.policy({ ...message, ...changed }, policy), /owner/)
    }
    assert.equal(received, 0); assert.equal(policies, 0)
    await inputs.policy(message, async configuration => { assert.equal(configuration, undefined); policies++ })
    assert.equal(policies, 1); assert.equal(received, 0, 'Personal strategy is selected before any normalized Session message')
    await inputs.receive(message)
    assert.equal(received, 1)
    const admitted = channelMessageEnvelope(bots, message)
    bots.bindOwner(bot.id)
    assert.equal(await inputs.router.route(admitted), undefined, 'Revoked pairing removes the host listener without needing another message')
    await assert.rejects(inputs.receive(message), /owner/)
    bots.bindOwner(bot.id, 'new-owner', 'new-dm')
    assert.equal(await inputs.router.route(admitted), undefined)
    bots.bindOwner(bot.id, 'owner', 'c2c:owner')
    bots.update(bot.id, { config: { enabled: false } })
    assert.equal(await inputs.router.route(admitted), undefined)
    await assert.rejects(inputs.receive(message), /connection/)
    if (platform !== 'wechat') {
      bots.update(bot.id, { purpose: 'service', config: { enabled: true } })
      assert.equal(await inputs.router.route(admitted), undefined, 'A former Personal address is not a Service fallback')
    }
    assert.equal(received, 1)
  })
})


test('Discord observation wakes use the same subscription router and never run an unsubscribed handler', async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'p', bots = new BotInstanceStore({ projectId, path: join(workspace, 'bots.json') })
    const bot = bots.create('discord', 'observer', { enabled: true, token: 'test' })
    const bindingId = randomUUID()
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } })
    const config = { mode: 'service', allowedModules: [], tools: [], bindings: [{ platform: 'discord', id: bindingId, botInstanceId: bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '201' }, enabled: true,
      trigger: 'mention', participants: { everyone: false, userIds: [], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false,
      observation: { enabled: true, guildId: '100', channelIds: ['201', '202'], audienceChannelId: '201', processor: { code: 'export default function(){return {action:"drop"}}', delayMs: 10 } } }] }
    const deploy = async (subscriptions?: unknown[]) => {
      const frozen = deployments.freeze({ 'BOT.md': '---\nid: observer\nconfig: bot.json\n---\nObserve', 'bot.json': JSON.stringify({ ...config, ...(subscriptions ? { subscriptions } : {}) }) })
      await deployments.deploy({ id: 'observer', source: { folderId: 'fixture', directory: '' }, ...frozen, expectedRevision: deployments.read('observer')?.deployment.revision })
    }
    const inputs = channelInputFixture({ projectId, bots, directory: new DirectoryBots(deployments), receive: async () => { throw new Error('Observation cannot fall back to ordinary channel input') } })
    let wakes = 0
    const wake = async () => { wakes++ }
    await deploy([])
    await assert.rejects(inputs.observation(bot.id, bindingId, wake), /subscription/)
    assert.equal(wakes, 0)
    await deploy()
    await inputs.observation(bot.id, bindingId, wake)
    assert.equal(wakes, 1)
    await assert.rejects(inputs.observation(bot.id, randomUUID(), wake), /subscription/)
    assert.equal(wakes, 1)
  })
})
