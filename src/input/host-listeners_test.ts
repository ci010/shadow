import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { handleBotInput } from '../bots/input.ts'
import { ChannelManager } from '../channels/manager.ts'
import { WebChannel } from '../channels/web.ts'
import { ConfigSchema } from '../config/schema.ts'
import { InputRouter } from './router.ts'
import { channelMessageEnvelope, observationEnvelope, requireChannelReceipt, requirePolicyReceipt, type ChannelInputPayload, type ChannelInputResult } from '../channels/input.ts'
import { handleSessionInput, sessionInputListeners } from '../sessions/input-listeners.ts'
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
      listeners: () => { trace.push('listeners'); return routerOpen ? [...sessionInputListeners(projectId, sessions, bots), ...directory.inputListeners()] : [] },
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

test('real Personal QQ strategy waits for its pairing listener; a pairing proof alone installs no listener', async () => {
  const { QQChannel } = await import('../channels/qq.ts')
  const { channelInputFixture } = await import('../testing/channel-input.ts')
  await withTempWorkspace(async workspace => {
    const projectId = 'personal-policy', bots = new BotInstanceStore({ projectId, path: join(workspace, 'bots.json') })
    const bot = bots.create('qq', 'owner', { enabled: true, appId: 'synthetic', secret: 'synthetic' }, undefined, 'personal')
    const directory = new DirectoryBots(new BotDeployments({ projectId, directory: join(workspace, 'deployments') }))
    const sessions = { listSessions: () => [], listRetiredSessions: () => [], getSessionState: () => null, assertFolderAccess() {},
      async retireIdleConversationContexts() {} } as unknown as SessionManager
    const trace: string[] = [], bus = new Bus()
    const inputs = channelInputFixture({ projectId, bots, directory, sessions, receive: async message => {
      trace.push('session'); return { status: 'accepted', sessionId: message.chatId, inputId: message.messageId }
    } })
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions, inputs.receive, {
      projectId, instanceStore: bots, routeInputPolicy: (message, run) => {
        trace.push('route')
        return inputs.policy(message, async config => { trace.push('policy'); await run(config) })
      },
    })
    try {
      await manager.init()
      const adapter = manager['channels'].get(bot.id)
      assert.ok(adapter instanceof QQChannel)
      let id = 0
      const send = (sender: string, content: string) => adapter['handleDispatch']('C2C_MESSAGE_CREATE', {
        id: String(++id), content, author: { user_openid: sender }, timestamp: new Date().toISOString(),
      })
      await assert.rejects(send('owner', 'before pairing'), /owner/)
      assert.deepEqual(trace, ['route'])
      trace.length = 0
      const challenge = manager.createOwnerChallenge(bot.id).challenge
      await send('owner', `/shadow-pair ${challenge}`)
      assert.deepEqual(trace, [], 'Control-plane proof does not execute an Agent strategy')
      assert.equal(manager.ownerCandidate(bot.id).candidate, 'owner')
      assert.equal(bots.get(bot.id).verifiedOwner, undefined)
      assert.deepEqual(sessionInputListeners(projectId, sessions, bots), [])
      await manager.confirmOwner(bot.id, challenge)
      assert.equal(sessionInputListeners(projectId, sessions, bots).length, 1)
      await send('owner', 'after host confirmation')
      assert.deepEqual(trace, ['route', 'policy', 'session'])
      trace.length = 0
      await assert.rejects(send('stranger', 'not the owner'), /owner/)
      assert.deepEqual(trace, ['route'])
      trace.length = 0; bots.bindOwner(bot.id)
      await assert.rejects(send('owner', 'revoked'), /owner/)
      assert.deepEqual(trace, ['route'])
    } finally { await manager.stopAll(); bus.stopAll() }
  })
})
