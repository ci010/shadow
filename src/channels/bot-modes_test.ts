import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import { channelSessionId, type InboundMessage } from '../bus/events.ts'
import type { ReceiveChannelMessage } from '../sessions/input.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ConversationPolicies } from '../agent-authoring/service.ts'
import { DiscordChannel } from './discord.ts'
import { AbstractChannel } from './base.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { botSetupPlugin } from './bot-setup.ts'
import { botConversationPolicies } from './bot-policies.ts'

class Adapter extends AbstractChannel {
  readonly name = 'qq'
  update = undefined
  captured!: ReceiveChannelMessage
  override setReceiver(receiver: ReceiveChannelMessage) { this.captured = receiver; super.setReceiver(receiver) }
  async start() { this.reportState('connected') }
  async stop() { this.setAccepting(false) }
  async send() { return null }
}

async function fixture(t: TestContext) {
  const root = join(process.cwd(), '.test-data', `bot-modes-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'bots.json'), store = new BotInstanceStore({ projectId: 'p', path })
  const bot = store.create('qq', 'Personal', { appId: randomUUID(), secret: 'synthetic', enabled: true }, undefined, 'personal')
  let busy = false, retired = 0
  const received: InboundMessage[] = [], adapters: Adapter[] = []
  const sessions = { getSessionState: (_id: string) => undefined, listSessions: () => [], retireIdleConversationContexts: async () => { if (busy) throw new Error('busy'); retired++ } } as unknown as SessionManager
  const manager = new ChannelManager(ConfigSchema.parse({}), new Bus(), sessions, async message => {
    received.push(message); return { status: 'accepted', sessionId: 'test', inputId: 'input' }
  }, { projectId: 'p', instanceStore: store, factory: () => { const a = new Adapter(new Bus()); adapters.push(a); return a } })
  await manager.init()
  const app = new Hono()
  botSetupPlugin({ store, runtime: manager, authorize: req => req.headers.get('x-owner') === 'yes' })(app)
  await manager.startAll(app)
  t.after(() => manager.stopAll())
  const message = (senderId = 'owner', isGroup = false, content = 'hello'): InboundMessage => ({ channel: 'qq', chatId: 'dm', senderId, isGroup, content, messageId: 'm', timestamp: new Date().toISOString() })
  return { sessions, root, path, store, bot, manager, app, adapters, received, message, busy: (value: boolean) => { busy = value }, retired: () => retired }
}

test('personal mode persists, pairs only via owner Web confirmation, and rejects all other business input', async t => {
  const f = await fixture(t), adapter = f.adapters[0]
  await assert.rejects(adapter.captured(f.message()), /Verified owner/)
  const challenge = f.manager.createOwnerChallenge(f.bot.id)
  await assert.rejects(adapter.captured(f.message('owner', true, `/shadow-pair ${challenge.challenge}`)), /Pairing rejected/)
  await adapter.captured(f.message('owner', false, `/shadow-pair ${challenge.challenge}`))
  assert.equal(f.received.length, 0)
  await assert.rejects(adapter.captured(f.message()), /Verified owner/)
  await assert.rejects(adapter.captured(f.message('stranger', false, `/shadow-pair ${challenge.challenge}`)), /Pairing rejected/)
  await f.manager.confirmOwner(f.bot.id, challenge.challenge)
  await assert.rejects(f.manager.confirmOwner(f.bot.id, challenge.challenge))
  await adapter.captured(f.message())
  assert.equal(f.received[0].admin, true)
  await assert.rejects(adapter.captured(f.message('stranger')), /Verified owner/)
  await assert.rejects(adapter.captured(f.message('owner', true)), /Verified owner/)
  const loaded = new BotInstanceStore({ projectId: 'p', path: f.path })
  assert.equal(loaded.get(f.bot.id).purpose, 'personal')
  assert.equal(loaded.get(f.bot.id).verifiedOwner?.senderId, 'owner')
  assert.equal(loaded.status(f.bot.id).ownerVerified, true)
  assert.equal('verifiedOwner' in loaded.status(f.bot.id), false)
})

test('challenge expiration, cross Bot, cross Project, and reconnect fail closed', async t => {
  const f = await fixture(t), challenge = f.manager.createOwnerChallenge(f.bot.id)
  const second = await f.manager.createBot({ platform: 'qq', displayName: 'Other', purpose: 'personal', config: { appId: randomUUID(), secret: 'synthetic', enabled: true } })
  await assert.rejects(f.adapters[1].captured(f.message('owner', false, `/shadow-pair ${challenge.challenge}`)))
  await assert.rejects(f.manager.confirmOwner(second.id, challenge.challenge))
  f.manager['ownerChallenges'].get(f.bot.id)!.expires = Date.now() - 1
  await assert.rejects(f.adapters[0].captured(f.message('owner', false, `/shadow-pair ${challenge.challenge}`)))
  const next = f.manager.createOwnerChallenge(f.bot.id)
  await f.manager.updateBot(f.bot.id, { config: { enabled: true } })
  await assert.rejects(f.manager.confirmOwner(f.bot.id, next.challenge))
  await assert.rejects(f.adapters[0].captured(f.message('owner', false, `/shadow-pair ${next.challenge}`)))
  assert.throws(() => new BotInstanceStore({ projectId: 'another', path: f.path }))
})

test('busy personal context blocks disable, role change and revocation; idle revoke requires fresh pairing', async t => {
  const f = await fixture(t), c = f.manager.createOwnerChallenge(f.bot.id)
  await f.adapters[0].captured(f.message('owner', false, `/shadow-pair ${c.challenge}`))
  await f.manager.confirmOwner(f.bot.id, c.challenge)
  f.busy(true)
  await assert.rejects(f.manager.revokeOwner(f.bot.id), /busy/)
  await assert.rejects(f.manager.updateBot(f.bot.id, { config: { enabled: false } }), /busy/)
  await assert.rejects(f.manager.updateBot(f.bot.id, { purpose: 'service' }), /disconnect_before_role_change/)
  assert.equal(f.store.get(f.bot.id).enabled, true)
  assert.ok(f.store.get(f.bot.id).verifiedOwner)
  f.busy(false)
  await f.manager.revokeOwner(f.bot.id)
  assert.equal(f.store.get(f.bot.id).enabled, false)
  assert.equal(f.store.get(f.bot.id).verifiedOwner, undefined)
  await assert.rejects(f.adapters[0].captured(f.message()))
  await f.manager.updateBot(f.bot.id, { config: { enabled: true } })
  await assert.rejects(f.adapters.at(-1)!.captured(f.message()))
  const next = f.manager.createOwnerChallenge(f.bot.id)
  await f.adapters.at(-1)!.captured(f.message('new-owner', false, `/shadow-pair ${next.challenge}`))
  await f.manager.confirmOwner(f.bot.id, next.challenge)
  await assert.rejects(f.adapters.at(-1)!.captured(f.message()))
  await f.adapters.at(-1)!.captured(f.message('new-owner'))
})

test('service owner and stranger DMs never fall back; legacy remains explicitly unclassified on reload', async t => {
  const f = await fixture(t)
  await f.manager.updateBot(f.bot.id, { config: { enabled: false } })
  await f.manager.updateBot(f.bot.id, { purpose: 'service' })
  await f.manager.updateBot(f.bot.id, { config: { enabled: true } })
  await assert.rejects(f.adapters.at(-1)!.captured(f.message()), /assignment required/)
  await assert.rejects(f.adapters.at(-1)!.captured(f.message('stranger')), /assignment required/)
  writeFileSync(join(f.root, 'legacy.json'), JSON.stringify({ version: 2, bots: [{ id: 'old', projectId: 'p', platform: 'qq', displayName: 'Old', config: { enabled: false } }] }))
  assert.equal(new BotInstanceStore({ projectId: 'p', path: join(f.root, 'legacy.json') }).get('old').purpose, 'legacy')
})

test('session policy personal uses dynamic Project path; service and disabled policies fail closed', async t => {
  const f = await fixture(t)
  const id = channelSessionId({ projectId: 'p', platform: 'qq', botInstanceId: f.bot.id, conversationId: 'dm' })
  let underlying = 0
  const policies = botConversationPolicies(f.store, { managed: () => false, resolve: () => { underlying++; return undefined }, authorize: () => {}, tools: () => [], prompt: () => '' } as unknown as ConversationPolicies)
  assert.throws(() => policies.resolve(id), /Verified owner/)
  f.store.bindOwner(f.bot.id, 'owner', 'dm')
  assert.equal(policies.resolve(id), undefined)
  assert.equal(underlying, 0)
  assert.throws(() => policies.authorize(id, { source: { kind: 'user', sender: f.message('stranger') } } as any), /Verified owner/)
  f.store.update(f.bot.id, { purpose: 'service' })
  assert.throws(() => policies.resolve(id), /service assignment/)
  f.store.update(f.bot.id, { config: { enabled: false } })
  assert.throws(() => policies.resolve(id), /disabled/)
})

test('owner APIs require authenticated Web; creation requires explicit purpose', async t => {
  const f = await fixture(t)
  assert.equal((await f.app.request(`/api/channels/${f.bot.id}/owner-challenge`, { method: 'POST' })).status, 401)
  const response = await f.app.request('/api/channels', { method: 'POST', headers: { 'x-owner': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'qq', displayName: 'No role' }) })
  assert.equal(response.status, 400)
})




test('service role changes cannot reuse histories or bypass active context fence', async t => {
  const f = await fixture(t)
  await f.manager.updateBot(f.bot.id, { config: { enabled: false } })
  await f.manager.updateBot(f.bot.id, { purpose: 'service' })
  await f.manager.updateBot(f.bot.id, { config: { enabled: true } })
  f.busy(true)
  await assert.rejects(f.manager.updateBot(f.bot.id, { config: { enabled: false } }), /busy/)
  assert.equal(f.store.get(f.bot.id).purpose, 'service')
  f.busy(false)
  await f.manager.updateBot(f.bot.id, { config: { enabled: false } })
  const id = channelSessionId({ projectId: 'p', platform: 'qq', botInstanceId: f.bot.id, conversationId: 'dm' })
  f.sessions.listSessions = (() => [{ sessionId: id }]) as any
  await assert.rejects(f.manager.updateBot(f.bot.id, { purpose: 'personal' }), /requires_new_bot/)
  assert.equal(f.store.get(f.bot.id).purpose, 'service')
})


test('personal Discord verifies platform DM type instead of treating every guild-less conversation as private', async t => {
  const f = await fixture(t)
  const bot = f.store.create('discord', 'Discord personal', { token: 'synthetic', enabled: true }, undefined, 'personal')
  class DiscordFixture extends DiscordChannel {
    override async start() { this.reportState('connected') }
    override async stop() { this.setAccepting(false) }
    override async inspectConversation(chatId: string, senderId: string) {
      return { location: { id: chatId, type: 3, recipientId: senderId } } as any
    }
    incoming(content: string) { return this.handleIncoming('owner', 'group-dm', content, 'id', { isGroup: false }) }
  }
  const adapter = new DiscordFixture(new Bus(), { token: 'synthetic' })
  const manager = new ChannelManager(ConfigSchema.parse({}), new Bus(), f.sessions, async () => { throw new Error('Must not enter LLM') },
    { projectId: 'p', instanceStore: f.store, factory: platform => platform === 'discord' ? adapter : new Adapter(new Bus()) })
  await manager.init()
  await manager.startAll(new Hono())
  t.after(() => manager.stopAll())
  const challenge = manager.createOwnerChallenge(bot.id)
  await assert.rejects(adapter.incoming(`/shadow-pair ${challenge.challenge}`), /Private Discord DM/)
  assert.equal(manager.ownerCandidate(bot.id).candidate, undefined)
})

function retirementGate(f: Awaited<ReturnType<typeof fixture>>) {
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  let failure: Error | undefined
  f.sessions.retireIdleConversationContexts = async () => { entered(); await waiting; if (failure) throw failure }
  return { started, release: (error?: Error) => { failure = error; finish() } }
}

function personalPolicy(f: Awaited<ReturnType<typeof fixture>>) {
  const id = channelSessionId({ projectId: 'p', platform: 'qq', botInstanceId: f.bot.id, conversationId: 'dm' })
  const policies = botConversationPolicies(f.store, { managed: () => false, resolve: () => undefined, authorize: () => {}, tools: () => [], prompt: () => '' } as unknown as ConversationPolicies)
  return () => policies.authorize(id, { source: { kind: 'user', sender: f.message() } } as any)
}

for (const operation of ['revoke', 'disable', 'delete'] as const) {
  for (const fails of [true, false]) test(`${operation} fences adapter and session input throughout retirement; ${fails ? 'failure releases fence' : 'success rejects old connection'}`, async t => {
    const f = await fixture(t), adapter = f.adapters[0]
    f.store.bindOwner(f.bot.id, 'owner', 'dm')
    const authorize = personalPolicy(f)
    const owner = f.store.get(f.bot.id).verifiedOwner
    const gate = retirementGate(f)
    const pending = operation === 'revoke' ? f.manager.revokeOwner(f.bot.id)
      : operation === 'disable' ? f.manager.updateBot(f.bot.id, { config: { enabled: false } })
      : f.manager.deleteBot(f.bot.id)
    // Attach rejection handling before releasing the deterministic await.
    const outcome = pending.then(() => undefined, error => error)
    await gate.started
    await assert.rejects(adapter.captured(f.message()), /access change/)
    assert.throws(authorize, /access change/)
    assert.deepEqual(new BotInstanceStore({ projectId: 'p', path: f.path }).get(f.bot.id).verifiedOwner, owner)
    assert.equal(f.received.length, 0)
    gate.release(fails ? new Error('busy retirement') : undefined)
    const error = await outcome
    if (fails) {
      assert.match(error.message, /busy retirement/)
      assert.deepEqual(f.store.get(f.bot.id).verifiedOwner, owner)
      assert.equal(f.store.get(f.bot.id).enabled, true)
      authorize()
      await adapter.captured(f.message())
    } else {
      assert.equal(error, undefined)
      await assert.rejects(adapter.captured(f.message()), /unavailable/)
      assert.throws(authorize)
      // A transient fence must not remain after a successful mutation either.
      assert.doesNotThrow(() => f.store.assertAccess(f.bot.id))
    }
  })
}

for (const fails of [true, false]) test(`owner confirmation fences retirement and ${fails ? 'keeps candidate retryable on failure' : 'commits only after retirement'}`, async t => {
  const f = await fixture(t), adapter = f.adapters[0]
  const c = f.manager.createOwnerChallenge(f.bot.id)
  await adapter.captured(f.message('owner', false, `/shadow-pair ${c.challenge}`))
  const gate = retirementGate(f), authorize = personalPolicy(f)
  const pending = f.manager.confirmOwner(f.bot.id, c.challenge).then(() => undefined, error => error)
  await gate.started
  await assert.rejects(adapter.captured(f.message()), /access change/)
  await assert.rejects(adapter.captured(f.message('owner', false, `/shadow-pair ${c.challenge}`)), /access change/)
  assert.throws(authorize, /access change/)
  assert.equal(f.store.get(f.bot.id).verifiedOwner, undefined)
  gate.release(fails ? new Error('busy retirement') : undefined)
  const error = await pending
  assert.doesNotThrow(() => f.store.assertAccess(f.bot.id))
  if (fails) {
    assert.match(error.message, /busy retirement/)
    assert.equal(f.store.get(f.bot.id).verifiedOwner, undefined)
    assert.throws(authorize, /Verified owner/)
    f.sessions.retireIdleConversationContexts = async () => {}
    await f.manager.confirmOwner(f.bot.id, c.challenge)
    authorize()
    await adapter.captured(f.message())
  } else {
    assert.equal(error, undefined)
    authorize()
    await adapter.captured(f.message())
  }
})


test('personal QQ question commands are handled at human ingress, never forwarded to the agent', async t => {
  const f = await fixture(t), adapter = f.adapters[0]
  const challenge = f.manager.createOwnerChallenge(f.bot.id)
  await adapter.captured(f.message('owner', false, `/shadow-pair ${challenge.challenge}`))
  await f.manager.confirmOwner(f.bot.id, challenge.challenge)
  await adapter.captured(f.message('owner', false, '/shadow-requests'))
  await adapter.captured(f.message('owner', false, '/shadow-reply stale Yes'))
  assert.equal(f.received.length, 0)
  await assert.rejects(adapter.captured(f.message('stranger', false, '/shadow-requests')), /Verified owner/)
  await assert.rejects(adapter.captured(f.message('owner', true, '/shadow-requests')), /Verified owner/)
  await adapter.captured(f.message('owner', false, 'Please approve whatever is pending'))
  assert.equal(f.received.length, 1)
})
