import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type OutboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { DirectoryBots } from '../bots/runtime.ts'
import { stampPersonalOutput } from '../bots/personal-output.ts'
import { DirectoryBotService } from '../bots/conversation-policy.ts'
import { BotInstanceStore } from './bot-store.ts'
import { botConversationPolicies } from './bot-policies.ts'
import { AbstractChannel } from './base.ts'
import { ChannelManager } from './manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

class Adapter extends AbstractChannel {
  readonly name = 'qq'
  update = undefined
  beforeNetwork?: () => Promise<void>
  requests = 0
  async start() { this.reportState('connected') }
  async stop() { this.setAccepting(false) }
  async send(_msg: OutboundMessage) {
    await this.beforeNetwork?.() // uploads, token refresh, rate limit or another send
    await this.assertDelivery() // same SDK boundary as the production adapters
    this.requests++
    return 'synthetic-receipt'
  }
}

test('Personal output fences pause/re-enable ABA, redeploy and final asynchronous send', async () => {
  await withTempWorkspace(async home => {
    const config = ConfigSchema.parse({ agent: { workspace: home }, channels: { qq: { enabled: true, appId: 'synthetic', secret: 'synthetic' } } })
    const store = new BotInstanceStore({ projectId: 'p', path: join(home, 'connections.json') })
    const connection = store.create('qq', 'synthetic', { enabled: true, appId: 'synthetic', secret: 'synthetic' })
    const address = { projectId: 'p', botInstanceId: connection.id, platform: 'qq' as const, conversationId: 'group:10' }
    const deployments = new BotDeployments({ projectId: 'p', directory: join(home, 'deployments'), runGit: async () => { throw Error('synthetic unavailable') } })
    const source = { folderId: 'synthetic', directory: '' }
    const files = { 'BOT.md': '---\nid: personal\nmode: personal\nconfig: bot.json\nagent: general\n---\nOriginal instructions',
      'bot.json': JSON.stringify({ tools: [], allowedModules: [], bindings: [{ botInstanceId: connection.id, platform: address.platform, conversationId: address.conversationId, enabled: true, tools: [] }] }) }
    await deployments.deploy({ id: 'personal', source, ...deployments.freeze(files) })
    const bots = new DirectoryBots(deployments)
    let execution = { enabled: true, generation: '0' }
    bots.setExecutionPolicy(() => execution)
    const policies = botConversationPolicies(store, new DirectoryBotService({ projectId: 'p', workspace: home, folders: {} as never }, bots), bots)
    const id = channelSessionId(address)
    const capture = () => {
      const personal = policies.personal!(id)!
      assert.equal(personal.agent, 'general')
      return stampPersonalOutput({ channel: 'qq', chatId: address.conversationId, content: 'synthetic output', event: 'response', done: true,
        channelAddress: address }, personal.assertCurrent!)
    }
    const bus = new Bus(), adapter = new Adapter(bus)
    const manager = new ChannelManager(config, bus, { getSessionState: () => undefined, listSessions: () => [] } as unknown as SessionManager,
      async () => { throw Error('no input expected') }, { projectId: 'p', instanceStore: store, factory: () => adapter, personalInboxAssigned: input => bots.personalInbox(input)?.enabled === true })
    await manager.init(); await manager.startAll(new Hono())
    try {
      await assert.doesNotReject(manager.deliver({ channel: 'web', chatId: 'owner-web', event: 'response', content: 'synthetic Web output', done: true }), 'non-BOT Web delivery must not require a Personal lease')
      const original = capture()
      await manager.deliver(original)
      assert.equal(adapter.requests, 1)
      await assert.rejects(manager.deliver({ ...original }), /lease required/, 'serialized or copied output cannot fabricate a lease')
      execution = { enabled: false, generation: '1' }
      await assert.rejects(manager.deliver(original), /no longer active/)
      execution = { enabled: true, generation: '2' }
      await assert.rejects(manager.deliver(original), /execution changed/, 'ABA must not revive the queue')
      const beforeRedeploy = capture(), active = deployments.read('personal')!.deployment
      const changed = { ...files, 'BOT.md': files['BOT.md'].replace('Original instructions', 'New instructions') }
      await deployments.deploy({ id: 'personal', source, ...deployments.freeze(changed), expectedRevision: active.revision })
      await assert.rejects(manager.deliver(beforeRedeploy), /execution changed/)
      const changedRevision = deployments.read('personal')!.deployment.revision
      await deployments.deploy({ id: 'personal', source, ...deployments.freeze(files), expectedRevision: changedRevision })
      await assert.rejects(manager.deliver(beforeRedeploy), /execution changed/, 'source-hash ABA must not revive the lease')
      const pending = capture()
      adapter.beforeNetwork = async () => { execution = { enabled: true, generation: '4' } }
      await assert.rejects(manager.deliver(pending), /execution changed/)
      assert.equal(adapter.requests, 1, 'no final adapter request after generation changed while awaiting')
      adapter.beforeNetwork = undefined
      await manager.deliver(capture())
      assert.equal(adapter.requests, 2, 'new turn on current generation can send')
    } finally { await manager.stopAll() }
  })
})
