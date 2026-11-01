import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { channelInputFixture } from '../testing/channel-input.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { DiscordChannel } from './discord.ts'
import { DiscordIntegration } from './integration.ts'
import { IntegrationStore } from './integration-store.ts'
import { MemoryDomains } from '../memory/domains.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { Tools } from '../tools/registry.ts'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import { InputClassifier } from '../events/input-classifier.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionInput } from '../sessions/input.ts'
import { deriveSessionId } from '../bus/events.ts'

async function fixture(t: TestContext, workspace: string, observation: boolean, processor: boolean) {
  const projectId = 'policy-order', trace: string[] = []
  const bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
  const bot = bots.create('discord', 'fixture', { enabled: true, token: 'synthetic' })
  const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } })
  const directory = new DirectoryBots(deployments)
  const bindingId = randomUUID()
  const policy = { code: `export function run(){return {action:'emit'}}`, delayMs: 10 }
  const observationPolicy = { code: `export function run({classification}) { return classification ? {action:'emit',semantic:{type:'campaign',data:{}}} : {action:'ignore',classify:true}; }`, delayMs: 10,
    classifier: { model: 'classifier', instructions: 'Synthetic test', fields: ['content'], maxInputBytes: 1000, maxTokens: 32, maxRequests: 10, maxWindowTokens: 10000, windowMs: 1000, deadlineMs: 1500, minConfidence: 0.5 } }
  const binding = { platform: 'discord', id: bindingId, botInstanceId: bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: observation ? '299' : '201' }, enabled: true,
    trigger: 'mention', participants: { everyone: false, userIds: observation ? [] : ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false,
    ...(observation ? { observation: { enabled: true, guildId: '100', channelIds: ['201', '202'], audienceChannelId: '299', processor: observationPolicy } } : processor ? { processor: policy } : {}) }
  const deploy = async (subscriptions?: unknown[]) => {
    const frozen = deployments.freeze({ 'BOT.md': '---\nid: support\nconfig: bot.json\n---\nSupport', 'bot.json': JSON.stringify({ mode: 'service', allowedModules: [], tools: [], bindings: [binding], ...(subscriptions ? { subscriptions } : {}) }) })
    await deployments.deploy({ id: 'support', source: { folderId: 'fixture', directory: '' }, ...frozen, expectedRevision: deployments.read('support')?.deployment.revision })
  }
  await deploy()
  let routerOpen = true
  const subscriptions = directory.inputListeners.bind(directory)
  t.mock.method(directory, 'inputListeners', () => { trace.push('select'); return routerOpen ? subscriptions() : [] })
  const agents = new AgentTypesManager(workspace); await agents.load()
  const memory = new MemoryDomains(projectId, join(workspace, 'domains'))
  const store = new IntegrationStore({ projectId, workspace, directory: join(workspace, 'security'), bots, agents, memory, deployedBots: () => directory.discord() })
  const provider: LLMProvider = { name: 'fixture', listModels: () => ['classifier'], chat: async () => {
    trace.push('classifier'); return { content: '{"label":"semanticwake","confidence":1}', toolCalls: [] }
  } }
  const integration = new DiscordIntegration({ projectId, workspace, store, bots, memory, baseTools: new Tools(workspace),
    classifier: new InputClassifier(() => provider, join(workspace, 'classifier.json')) })
  const sessionInputs: SessionInput[] = []
  const sessions = { getSessionState: () => null, invalidateChannelContexts: () => {}, listSessions: () => [],
    deliver: async (sessionId: string, input: SessionInput) => { trace.push('wake:observation'); sessionInputs.push(input); return { status: 'accepted', sessionId, inputId: input.id } } } as unknown as SessionManager
  integration.attach(sessions, {
    directory: async () => { throw new Error('unused') }, inspectTarget: async () => ({ botUserId: '900', roleIds: [] }),
    inspect: async (_bot, chatId, senderId) => ({ botUserId: '900', location: { id: chatId, name: chatId, type: 0, guildId: '100', guildName: 'guild', parentId: null, parentName: null, recipientId: null },
      actor: { id: senderId, name: senderId, roleIds: [] }, canView: true, canSend: true, canReadHistory: true }),
  }, async () => { throw new Error('unused') })
  const observe = integration.observe.bind(integration)
  t.mock.method(integration, 'observe', (...args: Parameters<typeof observe>) => { trace.push('observation-receive'); return observe(...args) })
  const inputs = channelInputFixture({ projectId, bots, directory, receive: async message => {
    trace.push('wake:ordinary'); return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
  } })
  const bus = new Bus(), adapter = new DiscordChannel(bus, { token: 'synthetic', workspace, reactionEmoji: '' })
  Object.assign(adapter, { botUserId: '900' })
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions, inputs.receive, {
    projectId, instanceStore: bots, factory: () => adapter, discordIntegration: integration,
    routeInputPolicy: (message, run) => inputs.policy(message, async configuration => { trace.push('handler:ordinary'); await run(configuration) }),
    routeObservation: (connection, scopeId, run) => inputs.observation(connection, scopeId, async () => { trace.push('handler:observation'); await run() }),
  })
  await manager.init()
  const ordinaryAccept = adapter['inputProcessor'].accept.bind(adapter['inputProcessor'])
  let retryScope: Parameters<typeof ordinaryAccept>[0]['runPolicy']
  t.mock.method(adapter['inputProcessor'], 'accept', (input: Parameters<typeof ordinaryAccept>[0]) => { retryScope = input.runPolicy; trace.push('processor:ordinary'); return ordinaryAccept(input) })
  const observationAccept = adapter['observationProcessor'].accept.bind(adapter['observationProcessor'])
  t.mock.method(adapter['observationProcessor'], 'accept', (input: Parameters<typeof observationAccept>[0]) => { retryScope = input.runPolicy; trace.push('processor:observation'); return observationAccept(input) })
  const trigger = adapter['shouldRespond'].bind(adapter)
  adapter['shouldRespond'] = data => { trace.push('trigger'); return trigger(data) }
  let id = 0
  return { trace, sessionInputs, deploy, blockRouter: () => { routerOpen = false }, openRouter: () => { routerOpen = true },
    retryPolicy: async () => { assert.ok(retryScope); await retryScope(async () => { trace.push('stored-rule') }, new AbortController().signal) },
    send: () => adapter['handleDispatch']('MESSAGE_CREATE', { id: String(++id), channel_id: '201', guild_id: '100', author: { id: '500', bot: false }, content: '<@900> hello', mentions: [{ id: '900' }], attachments: [] }),
    stop: async () => { await manager.stopAll(); integration.stop(); bus.stopAll(); await agents.stopWatching() } }
}

for (const processor of [false, true]) test(`real Discord ingress selects BOT before ${processor ? 'processor' : 'mention trigger'} and Session delivery`, async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, false, processor)
    try {
      f.blockRouter()
      await assert.rejects(f.send(), /subscription/)
      assert.deepEqual(f.trace, ['select'], 'Source proof may run, but no business strategy runs without a subscriber')
      f.trace.length = 0; f.openRouter()
      await f.send()
      const policyStep = processor ? 'processor:ordinary' : 'trigger'
      assert.ok(f.trace.indexOf('select') < f.trace.indexOf('handler:ordinary'))
      assert.ok(f.trace.indexOf('handler:ordinary') < f.trace.indexOf(policyStep))
      assert.ok(f.trace.indexOf(policyStep) < f.trace.indexOf('wake:ordinary'))
      if (processor) {
        f.trace.length = 0; f.blockRouter()
        await assert.rejects(f.retryPolicy(), /subscription/)
        assert.deepEqual(f.trace, ['select'], 'A buffered attempt cannot reuse the earlier handler scope')
        f.openRouter()
      }
      f.trace.length = 0
      await f.deploy([])
      await assert.rejects(f.send(), /disabled|assigned/)
      assert.equal(f.trace.some(step => step.startsWith('processor') || step === 'trigger' || step.startsWith('wake')), false)
    } finally { await f.stop() }
  })
})

test('real observation ingress selects BOT before receive rules, processor and classifier; unsubscribed means zero classifier calls', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace, true, false)
    try {
      f.blockRouter()
      await assert.rejects(f.send(), /subscription/)
      assert.deepEqual(f.trace, ['select'], 'Even observe() must not execute before subscriber selection')
      f.trace.length = 0; f.openRouter()
      await f.send()
      for (const [before, after] of [['select', 'handler:observation'], ['handler:observation', 'observation-receive'], ['observation-receive', 'processor:observation'], ['processor:observation', 'classifier'], ['classifier', 'wake:observation']])
        assert.ok(f.trace.indexOf(before!) >= 0 && f.trace.indexOf(before!) < f.trace.indexOf(after!), JSON.stringify(f.trace))
      assert.equal(f.sessionInputs.length, 1)
      assert.equal(f.sessionInputs[0]?.source.kind, 'event', 'Observation evidence is not a human request')
      f.trace.length = 0; f.blockRouter()
      await assert.rejects(f.retryPolicy(), /subscription/)
      assert.deepEqual(f.trace, ['select'], 'A pending observation must reselect before stored rule/classifier execution')
      f.openRouter()
      f.trace.length = 0
      await f.deploy([])
      await assert.rejects(f.send(), /disabled|assigned/)
      assert.equal(f.trace.some(step => step.includes('processor') || step === 'classifier' || step === 'observation-receive' || step.startsWith('wake')), false)
    } finally { await f.stop() }
  })
})


for (const connectionTrigger of ['mention', 'all'] as const) test(`two directory BOTs share one QQ connection but own independent triggers (legacy connection=${connectionTrigger})`, async t => {
  const { QQChannel } = await import('./qq.ts')
  await withTempWorkspace(async workspace => {
    const projectId = 'qq-trigger', bus = new Bus()
    const bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
    const connection = bots.create('qq', 'shared', { enabled: true, appId: 'synthetic', secret: 'synthetic', triggerMode: connectionTrigger })
    const deployments = new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } })
    for (const trigger of ['mention', 'all'] as const) {
      const id = `reply-${trigger}`
      const frozen = deployments.freeze({ 'BOT.md': `---\nid: ${id}\nconfig: bot.json\n---\nSupport`, 'bot.json': JSON.stringify({ mode: 'service', allowedModules: [], tools: [],
        bindings: [{ platform: 'qq', botInstanceId: connection.id, conversationId: `group:${trigger}`,
          // Exercise an old package with no trigger while its connection is all.
          ...(trigger === 'mention' && connectionTrigger === 'all' ? {} : { trigger }), tools: [] }] }) })
      await deployments.deploy({ id, source: { folderId: 'fixture', directory: '' }, ...frozen })
    }
    const directory = new DirectoryBots(deployments), delivered: string[] = [], configured: string[] = []
    const inputs = channelInputFixture({ projectId, bots, directory, receive: async message => {
      delivered.push(message.chatId); assert.equal(message.channelAddress?.botInstanceId, connection.id)
      return { status: 'accepted', sessionId: deriveSessionId(message), inputId: message.messageId }
    } })
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, {} as SessionManager, inputs.receive, {
      projectId, instanceStore: bots, serviceAssigned: directory.serviceAssigned,
      routeInputPolicy: (message, run) => inputs.policy(message, async configuration => {
        assert.ok(configuration?.platform === 'qq' && Object.isFrozen(configuration))
        configured.push(`${message.chatId}:${configuration.trigger}`)
        await run(configuration)
      }),
    })
    try {
      await manager.init()
      const adapter = manager['channels'].get(connection.id)
      assert.ok(adapter instanceof QQChannel)
      Object.defineProperty(adapter, 'triggerMode', { get: () => { throw new Error('Service read a connection trigger instead of BOT configuration') } })
      let id = 0
      const send = (group: string, mentioned = false) => adapter['handleDispatch'](mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', {
        id: String(++id), content: 'ordinary message', group_openid: group, author: { member_openid: '500' }, timestamp: new Date().toISOString(), triggerMode: 'all',
      })
      await Promise.all([send('mention'), send('all')])
      assert.deepEqual(delivered, ['group:all'])
      assert.deepEqual(configured, ['group:mention:mention', 'group:all:all'])
      await send('mention', true)
      assert.deepEqual(delivered, ['group:all', 'group:mention'])
      const saved = bots.get(connection.id).config
      assert.ok('triggerMode' in saved)
      assert.equal(saved.triggerMode, connectionTrigger, 'Compatibility configuration is not rewritten or used as Service policy')
    } finally { await manager.stopAll(); bus.stopAll() }
  })
})
