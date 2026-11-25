import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import type { ChannelSource } from '../channels/passive-contract.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { handleBotInput, projectInputListeners } from '../bots/input.ts'
import { ChannelManager } from '../channels/manager.ts'
import { WebChannel } from '../channels/web.ts'
import { ConfigSchema } from '../config/schema.ts'
import { InputRouter } from './router.ts'
import { channelMessageEnvelope, observationEnvelope, requireChannelReceipt, requirePolicyReceipt, type ChannelInputPayload, type ChannelInputResult } from '../channels/input.ts'
import { handleSessionInput } from '../sessions/input-listeners.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'

const post = (app: Hono, path: string, body: object, authorized = true) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { 'x-host-fixture': 'owner' } : {}) }, body: JSON.stringify(body),
})

test('real Web/ChannelManager ingress authenticates before preparation and uses the one host listener router', async () => {
  await withTempWorkspace(async workspace => {
    const projectId = 'web-listeners', bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
    const directory = new DirectoryBots(new BotDeployments({ projectId, directory: join(workspace, 'deployments') }))
    const states = new Map<string, SessionState>(), trace: string[] = [], received: InboundMessage[] = []
    let routerOpen = true, folderAllowed = true, hostAllowed = true
    const sessions = {
      getSessionState: (id: string) => states.get(id) ?? null,
      listSessions: () => [...states.values()].filter(s => !s.retirement),
      listRetiredSessions: () => [...states.values()].filter(s => s.retirement),
      assertFolderAccess: () => { if (!folderAllowed) throw new Error('Folder access revoked') },
      prepareCommandSession: async (id: string) => {
        trace.push('prepare')
        if (!states.has(id)) states.set(id, { sessionId: id, projectId, segmentIndex: 0 })
      },
      buildSession: async () => { assert.fail('Unauthenticated fork must not execute') },
      applySessionConfigPatch: async () => { assert.fail('Unauthenticated config must not execute') },
    } as unknown as SessionManager
    const bus = new Bus()
    const handlers = { sessions, bots, directory, receive: async (message: InboundMessage) => {
      trace.push('handler'); received.push(message)
      bus.emit('message.outbound', { channel: 'web', chatId: message.chatId, replyTo: message.messageId, event: 'response', content: 'response', done: true })
      return { status: 'accepted' as const, sessionId: `web:${message.chatId}`, inputId: message.messageId }
    } }
    const inputs = new InputRouter<ChannelInputPayload, ChannelInputResult>(projectId, {
      listeners: () => { trace.push('listeners'); return routerOpen ? projectInputListeners(projectId, handlers) : [] },
      deliver: (target, input) => target.kind === 'session' ? handleSessionInput(target.id, input, handlers) : handleBotInput(target.id, input, handlers),
    })
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions,
      async message => requireChannelReceipt(await inputs.route(channelMessageEnvelope(bots, message))), {
        projectId, instanceStore: bots,
        authorizeWebRequest: request => { trace.push('auth'); return hostAllowed && request.headers.get('x-host-fixture') === 'owner' },
        routeInputPolicy: async (message, run) => requirePolicyReceipt(await inputs.route(channelMessageEnvelope(bots, message, run))),
        routeObservation: async (connection, scope, run) => requirePolicyReceipt(await inputs.route(observationEnvelope(bots, connection, scope, run))),
      })
    const app = new Hono()
    try {
      await manager.init(); await manager.startAll(app)
      for (const path of ['/api/chat/send', '/api/chat/message']) {
        const denied = await post(app, path, { chatId: 'new', content: 'hello', parentChatId: 'parent', config: {}, admin: true, senderId: 'admin', source: { type: 'web' } }, false)
        assert.equal(denied.status, 401)
      }
      assert.equal(states.size, 0); assert.equal(received.length, 0); assert.deepEqual(trace, ['auth', 'auth'])
      const raw = { channel: 'web', chatId: 'unprepared', senderId: 'web-user', admin: true, content: 'hello', messageId: 'raw', timestamp: new Date().toISOString() }
      assert.equal(await inputs.route(channelMessageEnvelope(bots, raw)), undefined, 'A Web address alone does not establish a listener')
      assert.equal(states.size, 0); assert.equal(received.length, 0)
      trace.length = 0
      const first = await post(app, '/api/chat/send', { chatId: 'new', content: 'hello', senderId: 'impersonated', admin: false, source: { type: 'service', id: 'fake' }, listeners: [{ target: 'elsewhere' }], media: ['original-media'] })
      assert.equal(first.status, 200)
      assert.deepEqual(trace, ['auth', 'prepare', 'auth', 'listeners', 'handler'])
      assert.equal(states.size, 1); assert.equal(received[0]?.senderId, 'web-user'); assert.equal(received[0]?.admin, true)
      assert.deepEqual(received[0]?.media, ['original-media'])
      assert.equal(received[0]?.channelAddress, undefined)
      assert.equal((await post(app, '/api/chat/message', { chatId: 'new', content: 'sync' })).status, 200)
      assert.equal(states.size, 1, 'Repeated input reuses the established identity, not transient listeners')
      routerOpen = false
      assert.equal((await post(app, '/api/chat/send', { chatId: 'new', content: 'no listener' })).status, 403)
      assert.equal(received.length, 2)
      routerOpen = true
      const envelope = channelMessageEnvelope(bots, { ...raw, chatId: 'new' })
      await assert.rejects(inputs.route({ ...envelope, projectId: 'another' }), /Project/)
      // Live handler check denies an identity deleted or a folder revoked after enumeration.
      states.delete('web:new')
      await assert.rejects(handleSessionInput('web:new', envelope, handlers), /listener/)
      states.set('web:new', { sessionId: 'web:new', projectId, segmentIndex: 0 })
      folderAllowed = false
      await assert.rejects(handleSessionInput('web:new', envelope, handlers), /revoked/)
      folderAllowed = true; hostAllowed = false
      assert.equal((await post(app, '/api/chat/send', { chatId: 'another', content: 'revoked' })).status, 401)
      assert.equal(states.has('web:another'), false); assert.equal(received.length, 2)
    } finally { await manager.stopAll(); bus.stopAll() }
  })
})

test('standalone Web denies input by default and body authority cannot install authorization', async () => {
  const app = new Hono(), channel = new WebChannel(new Bus(), {})
  channel.setReceiver(async () => { throw new Error('Unauthorized input reached receiver') })
  await channel.start(app)
  try {
    for (const path of ['/api/chat/send', '/api/chat/message']) {
      assert.equal((await post(app, path, { chatId: 'known', content: 'hello', senderId: 'web-user', admin: true })).status, 401)
    }
  } finally { await channel.stop() }
})

test('one QQ connector routes exact Personal and Service inboxes without pairing, and honors group triggers', async () => {
  const { QQChannel } = await import('../channels/qq.ts')
  const { channelInputFixture } = await import('../testing/channel-input.ts')
  const { assignChannelSource } = await import('../bots/channel-assignment.ts')
  const { parseChannelSource } = await import('../channels/passive-contract.ts')
  await withTempWorkspace(async workspace => {
    const projectId = 'service-dm', bots = new BotInstanceStore({ projectId, path: join(workspace, 'connections.json') })
    const bot = bots.create('qq', 'shared', { enabled: true, appId: 'synthetic', secret: 'synthetic' })
    const directory = new DirectoryBots(new BotDeployments({ projectId, directory: join(workspace, 'deployments'), runGit: async () => { throw new Error('No git') } }))
    const archived: ChannelSource[] = [], received: InboundMessage[] = []
    const firstRecorded = Promise.withResolvers<void>(), finishFirstReceipt = Promise.withResolvers<void>()
    const sessions = { async recordPassiveChannel(source: ChannelSource, message: InboundMessage) {
      archived.push(source)
      if (archived.length === 1) { firstRecorded.resolve(); await finishFirstReceipt.promise }
      return { status: 'accepted', sessionId: 'inbox', inputId: message.messageId }
    } } as unknown as SessionManager
    const inputs = channelInputFixture({ projectId, bots, directory, receive: async message => {
      received.push(message); return { status: 'accepted', sessionId: message.chatId, inputId: message.messageId }
    } })
    const bus = new Bus()
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions, inputs.receive, {
      projectId, instanceStore: bots, serviceAssigned: directory.serviceAssigned,
      personalInboxAssigned: address => directory.personalInbox(address)?.enabled === true,
      serviceGeneration: address => directory.personalInbox(address)?.generation ?? directory.resolve(address)?.generation,
      routeInputPolicy: inputs.policy,
    })
    try {
      await manager.init()
      const adapter = manager['channels'].get(bot.id)
      assert.ok(adapter instanceof QQChannel)
      let id = 0
      const send = (sender: string) => adapter['handleDispatch']('C2C_MESSAGE_CREATE', {
        id: String(++id), content: 'plain message without a mention', author: { user_openid: sender }, timestamp: new Date().toISOString(),
      })
      const unassignedArrival = send('one')
      await firstRecorded.promise
      assert.equal(received.length, 0)
      const source = parseChannelSource(archived[0], undefined, projectId)!
      assert.equal(source.kind, 'direct')
      const files = { 'BOT.md': '---\nid: support\nconfig: bot.json\nmode: service\n---\nSupport.',
        'bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }) }
      const updated = assignChannelSource(files, source, { enabled: true, trigger: 'mention', tools: [] })
      await directory.deployments.deploy({ id: 'support', ...directory.deployments.freeze(updated.files), source: { folderId: 'test', directory: 'support' } })
      finishFirstReceipt.resolve()
      await unassignedArrival
      assert.equal(received.length, 0, 'Publishing during receipt cannot admit the older arrival')
      await send('two')
      assert.equal(received.length, 0, 'An unrelated private inbox is not bound')
      await send('one')
      assert.deepEqual(received.map(message => [message.messageId, message.chatId, message.admin]), [['3', 'c2c:one', false]])
      assert.equal(archived.length, 3)
      const personal = { ...files, 'BOT.md': '---\nid: assistant\nconfig: bot.json\nmode: personal\nagent: general\n---\nPrivate assistant.' }
      const personalInbox = assignChannelSource(personal, archived[1]!, { enabled: true, trigger: 'mention', tools: [] })
      const { parseBot } = await import('../bots/sdk.ts')
      const { validateServiceAssignments } = await import('../bots/assignment-validation.ts')
      const service = parseBot(updated.files)
      await validateServiceAssignments(projectId, bots, parseBot(personalInbox.files), [service], async () => {})
      const conflict = assignChannelSource(personal, source, { enabled: true, trigger: 'mention', tools: [] })
      await assert.rejects(() => validateServiceAssignments(projectId, bots, parseBot(conflict.files), [service], async () => {}), /another BOT/)
      await directory.deployments.deploy({ id: 'assistant', ...directory.deployments.freeze(personalInbox.files), source: { folderId: 'test', directory: 'assistant' } })
      await send('two'); await send('one')
      const { channelSessionId } = await import('../bus/events.ts')
      const { botConversationPolicies } = await import('../channels/bot-policies.ts')
      const policies = botConversationPolicies(bots, { resolve: () => undefined } as never, directory)
      assert.equal(policies.personal?.(channelSessionId(received[1]!.channelAddress!))?.agent, 'general')
      assert.equal(directory.resolve(received[2]!.channelAddress!)?.runtimeOrigin?.id, 'support')
      assert.deepEqual(received.map(message => message.chatId), ['c2c:one', 'c2c:two', 'c2c:one'])
      const sendGroup = (mentioned: boolean) => adapter['handleDispatch'](mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', {
        id: String(++id), content: 'group message', group_openid: 'team', author: { member_openid: 'any-member' }, timestamp: new Date().toISOString(),
      })
      await sendGroup(false)
      assert.equal(received.length, 3)
      const group = archived.at(-1)!
      const deployPersonal = async (trigger: 'mention' | 'all') => {
        const assigned = assignChannelSource(personalInbox.files, group, { enabled: true, trigger, tools: [] })
        await directory.deployments.deploy({ id: 'assistant', ...directory.deployments.freeze(assigned.files), source: { folderId: 'test', directory: 'assistant' }, expectedRevision: directory.deployments.read('assistant')!.deployment.revision })
      }
      await deployPersonal('mention')
      await sendGroup(false)
      assert.equal(received.filter(message => !message.silent).length, 3)
      await sendGroup(true)
      assert.equal(received.at(-1)?.chatId, 'group:team')
      assert.equal(received.at(-1)?.silent, false)
      const guard = policies.personal?.(channelSessionId(received.at(-1)!.channelAddress!))?.assertCurrent
      assert.ok(guard)
      await deployPersonal('all')
      assert.throws(guard, /execution changed/)
      await sendGroup(false)
      assert.equal(received.at(-1)?.silent, false)
    } finally { finishFirstReceipt.resolve(); await manager.stopAll(); bus.stopAll() }
  })
})
