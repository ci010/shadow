import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema, type Config } from '../config/schema.ts'
import { ConfigStore } from '../config/store.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { GatewayClientAddressRegistry } from '../gateway/server.ts'
import { authorizeMainNodeInventory } from '../runtime/node-inventory.ts'
import { AbstractChannel } from './base.ts'
import { ChannelManager } from './manager.ts'
import { channelSetupPlugin, channelSetupStatus } from './setup.ts'
import type { ChannelId, ChannelSetupStatus, ChannelState } from './setup-contract.ts'

class FakeChannel extends AbstractChannel {
  update = undefined
  starts = 0
  stops = 0
  failStart = false
  failStop = false
  startGate?: Promise<void>
  constructor(readonly name: ChannelId, bus: Bus) { super(bus) }
  async start() {
    this.starts++
    await this.startGate
    if (this.failStart) throw new Error('synthetic-credential-bearing-sdk-error')
  }
  async stop() {
    this.stops++
    if (this.failStop) throw new Error('synthetic-credential-bearing-sdk-error')
    this.setAccepting(false)
    this.reportState('disconnected')
  }
  async send() { return null }
  state(state: ChannelState) { this.reportState(state) }
  incoming() { return this.handleIncoming('sender', 'chat', 'hello', 'message') }
}

async function fixture(t: TestContext, raw: Record<string, unknown> = {}, environment?: Partial<Config['channels']>) {
  const root = join(process.cwd(), '.test-data', `channels-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify({
    ...raw,
    providers: { fixture: { apiKey: 'synthetic-provider-secret' } },
    fixture: { preserve: true },
  }))
  let active = ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (environment) active = { ...active, channels: { ...active.channels, ...environment } }
  const created: FakeChannel[] = []
  const bus = new Bus()
  let configure: ((channel: FakeChannel) => void) | undefined
  let received = 0
  let invalidations = 0
  const sessions = { invalidateSystemPrompts: () => { invalidations++ } } as SessionManager
  const manager = new ChannelManager(active, bus, sessions, async () => {
    received++
    return { status: 'accepted', sessionId: 'fixture', inputId: 'message' }
  }, (id) => {
    const channel = new FakeChannel(id, bus)
    configure?.(channel)
    created.push(channel)
    return channel
  })
  const store = new ConfigStore({
    configPath: path,
    getConfig: () => active,
    onChanged: (config) => { active = config; manager.updateConfig(config) },
  })
  const app = new Hono()
  channelSetupPlugin({
    store, runtime: manager,
    authorize: (request) => request.headers.get('Authorization') === 'Bearer fixture-admin',
  })(app)
  await manager.init()
  await manager.startAll(app)
  t.after(async () => {
    for (const channel of created) channel.failStop = false
    await manager.stopAll()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    app, manager, created, store,
    active: () => active,
    received: () => received,
    invalidations: () => invalidations,
    configure: (callback: (channel: FakeChannel) => void) => { configure = callback },
    persisted: () => JSON.parse(readFileSync(path, 'utf8')),
    patch: (id: string, config: unknown, authorized = true) => app.request(`/api/channels/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer fixture-admin' } : {}) },
      body: JSON.stringify({ config }),
    }),
  }
}

test('channel API authorizes both GET and PATCH and exposes only the three selected channels', async (t) => {
  const f = await fixture(t, {
    channels: { qq: { appId: 'public-app-id', secret: 'synthetic-qq-secret', token: 'synthetic-legacy-token' } },
  })
  assert.equal((await f.app.request('/api/channels')).status, 401)
  assert.equal((await f.patch('qq', { enabled: false }, false)).status, 401)
  const response = await f.app.request('/api/channels', { headers: { Authorization: 'Bearer fixture-admin' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json() as { channels: ChannelSetupStatus[] }
  assert.deepEqual(body.channels.map((channel) => channel.id), ['qq', 'feishu', 'discord'])
  assert.equal(body.channels[0].configured, true)
  assert.equal(body.channels[0].state, 'disabled')
  assert.equal(body.channels[0].config.appId, 'public-app-id')
  assert.deepEqual(body.channels[0].secrets, { secret: true, token: true })
  assert.doesNotMatch(JSON.stringify(body), /synthetic-|config\.json|access_token/)
  assert.equal((await f.patch('wechat', { enabled: true })).status, 404)
  assert.equal((await f.patch('__proto__', { enabled: true })).status, 404)
})

test('strict partial patches validate required credentials and never blank stored secrets', async (t) => {
  const f = await fixture(t)
  for (const id of ['qq', 'feishu', 'discord']) {
    assert.equal((await f.patch(id, { enabled: true })).status, 400)
    assert.equal((await f.patch(id, { unknown: 'value' })).status, 400)
    assert.equal((await f.patch(id, { enabled: 'true' })).status, 400)
    assert.equal((await f.patch(id, [])).status, 400)
  }
  for (const patch of [
    { secret: '' }, { secret: '   ' }, { secret: '__SHADOW_REDACTED__' },
    { intents: -1 }, { intents: 1.5 }, { intents: 0x1_0000_0000 }, { sandbox: 1 },
    { allowFrom: [123] }, { adminChats: 'admin' }, { appId: 'line\nbreak' },
    { trustedChats: 'room' }, { trustedChats: [123] }, { trustedChats: [' '] },
    { trustedChats: ['room\n'] }, { trustedChats: Array(1001).fill('room') },
  ]) assert.equal((await f.patch('qq', patch)).status, 400)
  assert.equal((await f.patch('discord', { triggerMode: 'invalid' })).status, 400)
  assert.equal(f.created.length, 0)
  assert.equal(f.persisted().channels, undefined)
})

test('persisted config reconnects immediately; only transport events mark connected, with stale callback isolation', async (t) => {
  const f = await fixture(t)
  const saved = await f.patch('qq', {
    appId: 'app', secret: 'synthetic-secret', token: 'synthetic-token', enabled: true,
    markdown: false, sandbox: true, intents: 123, allowFrom: ['allowed'], adminChats: ['admin'],
  })
  assert.equal(saved.status, 200)
  const first = f.created[0]
  assert.equal(first.starts, 1)
  assert.equal((await saved.json()).channel.state, 'connecting')
  await first.incoming()
  assert.equal(f.received(), 1)
  first.state('connected')
  assert.equal(f.manager.status('qq').state, 'connected')
  const reconnect = await f.patch('qq', { enabled: true })
  assert.equal(reconnect.status, 200)
  assert.equal(first.stops, 1)
  assert.equal(f.created.length, 2)
  first.state('error')
  assert.equal(f.manager.status('qq').state, 'connecting')
  await assert.rejects(first.incoming(), /disconnected/)
  f.created[1].state('disconnected')
  assert.equal(f.manager.status('qq').state, 'disconnected')
  f.created[1].state('connected')
  assert.equal((await f.patch('qq', { enabled: false })).status, 200)
  assert.equal(f.created[1].stops, 1)
  assert.equal(f.manager.status('qq').state, 'disabled')
  assert.equal(f.manager.status('qq').configured, true)
  assert.equal(f.persisted().channels.qq.secret, 'synthetic-secret')
  assert.equal(f.persisted().channels.qq.token, 'synthetic-token')
  assert.equal(f.persisted().channels.qq.markdown, false)
  assert.deepEqual(f.persisted().fixture, { preserve: true })
  assert.equal(f.persisted().providers.fixture.apiKey, 'synthetic-provider-secret')
  assert.doesNotMatch(JSON.stringify(f.manager.status('qq')), /synthetic-/)
})

test('trusted audience configuration is independent, persisted and revocable', async t => {
  const f = await fixture(t)
  assert.equal((await f.patch('discord', { allowFrom: ['alice'], adminChats: ['room'] })).status, 200)
  assert.equal(f.manager.isTrustedConversation('discord', 'room'), false)
  assert.equal(f.invalidations(), 0)
  const response = await f.patch('discord', { trustedChats: [' room '] })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).channel.config.trustedChats, ['room'])
  assert.deepEqual(f.persisted().channels.discord.trustedChats, ['room'])
  assert.equal(f.manager.isTrustedConversation('discord', 'room'), true)
  assert.equal(f.manager.isTrustedConversation('discord', 'thread'), false)
  assert.equal(f.manager.isTrustedConversation('qq', 'room'), false)
  assert.equal(f.invalidations(), 1)
  assert.equal((await f.patch('discord', { trustedChats: [] })).status, 200)
  assert.equal(f.manager.isTrustedConversation('discord', 'room'), false)
  assert.equal(f.invalidations(), 2)
  assert.deepEqual(f.persisted().channels.discord.adminChats, ['room'])
})

test('concurrent channel and provider saves preserve independent fields and serialize lifecycle', async (t) => {
  const f = await fixture(t)
  const responses = await Promise.all([
    f.patch('discord', { token: 'synthetic-discord', enabled: true }),
    f.patch('discord', { reactionEmoji: '', allowFrom: ['one'] }),
    f.patch('qq', { appId: 'qq-app', secret: 'synthetic-qq', enabled: true }),
    f.store.update((raw) => ({
      ...raw, providers: { ...(raw.providers as object), added: { apiKey: 'synthetic-added' } },
    })),
  ])
  for (const response of responses.slice(0, 3)) assert.equal((response as Response).status, 200)
  const saved = f.persisted()
  assert.equal(saved.channels.discord.token, 'synthetic-discord')
  assert.equal(saved.channels.discord.reactionEmoji, '')
  assert.deepEqual(saved.channels.discord.allowFrom, ['one'])
  assert.equal(saved.channels.qq.secret, 'synthetic-qq')
  assert.equal(saved.providers.added.apiKey, 'synthetic-added')
  assert.equal(f.created[0].stops, 1)
})

test('environment-only channel credentials survive save but are not copied to disk', async (t) => {
  const f = await fixture(t, {}, {
    discord: { enabled: true, token: 'synthetic-environment-token', triggerMode: 'mention', reactionEmoji: '' },
  })
  assert.equal((await f.patch('discord', { enabled: true })).status, 200)
  assert.equal(f.persisted().channels.discord.token, undefined)
  assert.equal(f.active().channels.discord?.token, 'synthetic-environment-token')
  assert.equal(f.manager.status('discord').secrets.token, true)
  await f.store.update((raw) => ({ ...raw, agent: { model: 'fixture-model' } }))
  assert.equal(f.active().channels.discord?.token, 'synthetic-environment-token')
  assert.equal((await f.patch('discord', { token: 'synthetic-replacement' })).status, 200)
  assert.equal(f.persisted().channels.discord.token, 'synthetic-replacement')
})

test('startup failures are explicit, sanitized, persisted, and retryable', async (t) => {
  const f = await fixture(t)
  f.configure((channel) => { channel.failStart = true })
  const response = await f.patch('discord', { token: 'synthetic-token', enabled: true })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.channel.configured, true)
  assert.equal(result.channel.enabled, true)
  assert.equal(result.channel.state, 'error')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-/)
  assert.equal(f.created[0].stops, 1)
  f.configure(() => {})
  assert.equal((await f.patch('discord', { enabled: true })).status, 200)
  assert.equal(f.created.length, 2)
})

test('failed cleanup requires restart rather than creating duplicate clients', async (t) => {
  const f = await fixture(t)
  await f.patch('feishu', { appId: 'app', appSecret: 'synthetic-secret', enabled: true })
  f.created[0].failStop = true
  const response = await f.patch('feishu', { enabled: false })
  assert.equal((await response.json()).channel.state, 'restart-required')
  f.created[0].state('connected')
  assert.equal(f.manager.status('feishu').state, 'restart-required')
  assert.equal((await f.patch('feishu', { enabled: true })).status, 503)
  assert.equal(f.created.length, 1)
})

test('shutdown waits for admitted updates and rejects queued saves without writing', async (t) => {
  const f = await fixture(t)
  const gate = Promise.withResolvers<void>()
  f.configure((channel) => { channel.startGate = gate.promise })
  const first = f.patch('qq', { appId: 'app', secret: 'synthetic-qq', enabled: true })
  while (!f.created.length) await new Promise((resolve) => setImmediate(resolve))
  const stop = f.manager.stopAll()
  const second = f.patch('discord', { token: 'synthetic-late', enabled: true })
  gate.resolve()
  await first
  await stop
  assert.equal((await second).status, 503)
  assert.equal(f.persisted().channels.discord, undefined)
  assert.equal(f.created[0].stops, 1)
})

test('configured is independent from enabled and transport state', () => {
  const config = ConfigSchema.parse({ channels: { feishu: { enabled: true, appId: 'app' } } })
  const status = channelSetupStatus('feishu', config.channels, { state: 'connected' })
  assert.equal(status.configured, false)
  assert.equal(status.state, 'unconfigured')
})

test('out-of-band config changes remain restart-required until Channels applies the new settings', async (t) => {
  const f = await fixture(t)
  await f.patch('discord', { enabled: true, token: 'synthetic-token' })
  f.created[0].state('connected')
  await f.store.update((raw) => ({
    ...raw, channels: { discord: { enabled: false, token: 'synthetic-token' } },
  }))
  f.created[0].state('connected')
  assert.equal(f.manager.status('discord').state, 'restart-required')
  assert.equal(f.manager.status('discord').enabled, false)
  await f.patch('discord', { enabled: false })
  assert.equal(f.created[0].stops, 1)
  assert.equal(f.manager.status('discord').state, 'disabled')
})

test('invalid envelopes, oversized bodies and persistence errors never expose payloads or alter live clients', async (t) => {
  const f = await fixture(t)
  for (const body of ['{', '{"config":{},"unexpected":true}', 'null']) {
    const response = await f.app.request('/api/channels/qq', {
      method: 'PATCH', headers: { Authorization: 'Bearer fixture-admin' }, body,
    })
    assert.equal(response.status, 400)
  }
  assert.equal((await f.patch('qq', { secret: 'x'.repeat(300_000) })).status, 413)
  await f.patch('discord', { enabled: true, token: 'synthetic-token' })
  t.mock.method(f.store, 'update', async () => { throw new Error('synthetic-secret in config.json') })
  const response = await f.patch('discord', { enabled: false })
  assert.equal(response.status, 500)
  assert.doesNotMatch(await response.text(), /synthetic-|config\.json/)
  assert.equal(f.created[0].stops, 0)
  assert.equal(f.manager.status('discord').enabled, true)
})

test('runtime authorization requires the main launch credential or a verified loopback connection', async (t) => {
  const f = await fixture(t)
  const addresses = new GatewayClientAddressRegistry()
  const secured = new Hono()
  channelSetupPlugin({
    store: f.store, runtime: f.manager,
    authorize: (request) => authorizeMainNodeInventory(request, 'synthetic-main-admin', addresses),
  })(secured)
  for (const credential of ['', 'synthetic-child-credential']) {
    const response = await secured.request('/api/channels', {
      headers: { Authorization: `Bearer ${credential}` },
    })
    assert.equal(response.status, 401)
  }
  assert.equal((await secured.request('/api/channels', {
    headers: { Authorization: 'Bearer synthetic-main-admin' },
  })).status, 200)
  const local = new Hono()
  channelSetupPlugin({
    store: f.store, runtime: f.manager,
    authorize: (request) => authorizeMainNodeInventory(request, undefined, addresses),
  })(local)
  const unknown = new Request('http://localhost/api/channels')
  assert.equal((await local.fetch(unknown)).status, 401)
  const remote = new Request('http://localhost/api/channels')
  addresses.capture(remote, { transport: 'tcp', hostname: '192.0.2.1' })
  assert.equal((await local.fetch(remote)).status, 401)
  const trusted = new Request('http://localhost/api/channels')
  addresses.capture(trusted, { transport: 'tcp', hostname: '127.0.0.1' })
  assert.equal((await local.fetch(trusted)).status, 200)
})

test('real channel GET and PATCH responses round-trip through the frontend parsers with every public field intact', async (t) => {
  const { parseChannelList, parseChannelStatus } = await import('../../app/src/channel-settings.ts')
  const f = await fixture(t)
  const publicConfig: Record<ChannelId, ChannelSetupStatus['config']> = {
    qq: { appId: 'qq-app', sandbox: true, markdown: false, intents: 0xffffffff, allowFrom: ['qq-sender'], adminChats: ['qq-admin'], trustedChats: ['qq-room'] },
    feishu: { appId: 'feishu-app', allowFrom: ['feishu-sender'], adminChats: ['feishu-admin'], trustedChats: ['feishu-room'] },
    discord: { triggerMode: 'all', reactionEmoji: '', allowFrom: ['discord-sender'], adminChats: ['discord-admin'], trustedChats: ['discord-room'] },
  }
  const credentials: Record<ChannelId, Record<string, string>> = {
    qq: { secret: 'synthetic-qq-secret', token: 'synthetic-qq-token' },
    feishu: { appSecret: 'synthetic-feishu-secret', encryptKey: 'synthetic-encryption', verificationToken: 'synthetic-verification' },
    discord: { token: 'synthetic-discord-token' },
  }
  const get = async () => {
    const response = await f.app.request('/api/channels', { headers: { Authorization: 'Bearer fixture-admin' } })
    assert.equal(response.status, 200)
    const wire = await response.json()
    const parsed = parseChannelList(wire)
    assert.deepEqual(parsed, wire.channels)
    return parsed
  }
  assert.equal((await get()).length, 3)
  for (const id of ['qq', 'feishu', 'discord'] as const) {
    const response = await f.patch(id, { ...publicConfig[id], ...credentials[id], enabled: true })
    assert.equal(response.status, 200)
    const wire = await response.json()
    const parsed = parseChannelStatus(wire.channel)
    assert.deepEqual(parsed, wire.channel)
    assert.deepEqual(parsed.config, publicConfig[id])
    assert.deepEqual(parsed.secrets, Object.fromEntries(Object.keys(credentials[id]).map((key) => [key, true])))
    assert.equal(parsed.state, 'connecting')
    assert.doesNotMatch(JSON.stringify(parsed), /synthetic-/)
    f.created.at(-1)!.state(id === 'feishu' ? 'running' : 'connected')
  }
  const list = await get()
  for (const channel of list) {
    assert.deepEqual(channel.config, publicConfig[channel.id])
    assert.equal(channel.state, channel.id === 'feishu' ? 'running' : 'connected')
    const response = await f.patch(channel.id, { enabled: false })
    const parsed = parseChannelStatus((await response.json()).channel)
    assert.equal(parsed.state, 'disabled')
    assert.deepEqual(parsed.config, publicConfig[channel.id])
  }
})
