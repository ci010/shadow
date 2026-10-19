import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BotInstanceStore } from './bot-store.ts'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { AbstractChannel } from './base.ts'
import { ChannelManager } from './manager.ts'
import { updateBackendNetwork } from '../execution/network/backend.ts'

class Adapter extends AbstractChannel {
  readonly name = 'discord'
  update = undefined
  constructor(bus: Bus, private fail: boolean) { super(bus) }
  async start() {
    if (this.fail) throw new Error('synthetic connection failure')
    this.reportState('connected')
  }
  async stop() { this.reportState('disconnected') }
  async send() { return null }
}

test('proxy policy change retries failed Discord starts, without restarting healthy or stopped channels', async t => {
  const bus = new Bus()
  let starts = 0
  const manager = new ChannelManager(
    ConfigSchema.parse({ channels: { discord: { enabled: true, token: 'synthetic' } } }),
    bus, {} as SessionManager, async () => ({ status: 'accepted', sessionId: 'test', inputId: 'test' }),
    () => new Adapter(bus, ++starts === 1),
  )
  t.after(() => manager.stopAll())
  await manager.init()
  await manager.startAll(new Hono())
  assert.equal(manager.status('discord').state, 'error')
  // Disabling then enabling proxy must publish a change even if both routes are direct.
  await updateBackendNetwork(false)
  await manager['operations']
  assert.equal(starts, 2)
  assert.equal(manager.status('discord').state, 'connected')
  await manager.refreshFailedDiscordConnections()
  assert.equal(starts, 2)
  manager.beginShutdown()
  await manager.refreshFailedDiscordConnections()
  assert.equal(starts, 2)
})

test('saved enabled Discord Bots retry even after failed adapter was removed', async t => {
  const root = join(process.cwd(), '.test-data', `discord-network-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BotInstanceStore({ projectId: 'network-test', path: join(root, 'bots.json') })
  const bot = store.create('discord', 'Test', { enabled: true, token: 'synthetic' }, undefined, 'personal')
  const bus = new Bus()
  let starts = 0
  const manager = new ChannelManager(ConfigSchema.parse({}), bus, {} as SessionManager,
    async () => ({ status: 'accepted', sessionId: 'test', inputId: 'test' }), {
      projectId: 'network-test', instanceStore: store,
      factory: () => new Adapter(bus, ++starts === 1),
    })
  t.after(() => manager.stopAll())
  await manager.init()
  await manager.startAll(new Hono())
  assert.equal(manager['health'].get(bot.id)?.state, 'error')
  assert.equal(manager['channels'].has(bot.id), false)
  await manager.refreshFailedDiscordConnections()
  assert.equal(starts, 2)
  assert.equal(manager['health'].get(bot.id)?.state, 'connected')
  // A disabled saved Bot must not be resurrected by a network change.
  store.update(bot.id, { config: { enabled: false } })
  manager['health'].set(bot.id, { state: 'disconnected' })
  await manager.refreshFailedDiscordConnections()
  assert.equal(starts, 2)
})
