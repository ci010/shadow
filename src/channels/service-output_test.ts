import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { stampServiceOutput } from '../bots/service-output.ts'
import { BotInstanceStore } from './bot-store.ts'
import { ChannelManager } from './manager.ts'
import { QQChannel } from './qq.ts'
import { Bus } from '../bus/bus.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { OutboundMessage } from '../bus/events.ts'

test('real manager delivery rechecks service lease after queuing and immediately before the transport request', async t => {
  await withTempWorkspace(async workspace => {
    const bots = new BotInstanceStore({ projectId: 'p', path: join(workspace, 'connections.json') })
    const bot = bots.create('qq', 'fixture', { enabled: true, appId: 'synthetic', secret: 'synthetic' }, undefined, 'service')
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let assigned = true, requests = 0
    class Transport extends QQChannel {
      override async onMessage(_message: OutboundMessage): Promise<void> {
        entered.resolve(); await release.promise
        await this.request('https://fixture.invalid/send', { method: 'POST' })
      }
    }
    const bus = new Bus(), adapter = new Transport(bus, { appId: 'synthetic', secret: 'synthetic' })
    const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, {} as SessionManager, async () => { throw new Error('No input expected') }, { projectId: 'p', instanceStore: bots, factory: () => adapter, serviceAssigned: () => assigned })
    await manager.init(); manager['health'].set(bot.id, { state: 'connected' })
    t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ ok: true }) })
    const message = stampServiceOutput({ channel: 'qq', chatId: 'group:one', channelAddress: { projectId: 'p', botInstanceId: bot.id, platform: 'qq', conversationId: 'group:one' }, content: 'reply', event: 'response', done: true }, () => { if (!assigned) throw new Error('Revoked') })
    try {
      const delivery = manager.deliver(message)
      await entered.promise
      assigned = false; release.resolve()
      await assert.rejects(delivery, /Channel request failed|Revoked|active/)
      assert.equal(requests, 0)
      await assert.rejects(() => manager.deliver(message), /active/)
      assigned = true
      await assert.rejects(() => manager.deliver(JSON.parse(JSON.stringify(message))), /lease/)
      assert.equal(requests, 0)
    } finally { release.resolve(); await manager.stopAll(); bus.stopAll() }
  })
})
