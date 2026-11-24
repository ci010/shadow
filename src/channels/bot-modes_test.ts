import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type InboundMessage } from '../bus/events.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ChannelManager } from './manager.ts'
import { BotInstanceStore } from './bot-store.ts'
import { QQChannel } from './qq.ts'

async function fixture(workspace: string) {
  const bus = new Bus()
  const store = new BotInstanceStore({ projectId: 'p', path: join(workspace, 'connections.json') })
  const bot = store.create('qq', 'Shared transport', { appId: 'synthetic', secret: 'synthetic', enabled: true })
  const received: InboundMessage[] = [], receipts = new Set<string>()
  let afterReceipt: (() => Promise<void>) | undefined
  const assignments = new Map<string, string>()
  const sessions = {
    getSessionState: () => undefined,
    retireIdleConversationContexts: async (_matches: (id: string) => boolean) => {},
    recordPassiveChannel: async (_source: unknown, message: InboundMessage) => {
      const duplicate = receipts.has(message.messageId)
      receipts.add(message.messageId)
      await afterReceipt?.()
      return { status: 'accepted', disposition: duplicate ? 'filtered' : 'recorded' }
    },
  }
  let policyExecutions = 0
  const manager = new ChannelManager(ConfigSchema.parse({ agent: { workspace } }), bus, sessions as unknown as SessionManager, async message => {
    received.push(message)
    return { status: 'accepted', sessionId: 'test', inputId: message.messageId }
  }, {
    projectId: 'p', instanceStore: store,
    personalInboxAssigned: address => assignments.get(address.conversationId)?.startsWith('personal:') === true,
    serviceAssigned: address => assignments.get(address.conversationId)?.startsWith('service:') === true,
    serviceGeneration: address => assignments.get(address.conversationId),
    routeInputPolicy: async (_message, runPolicy) => { policyExecutions++; await runPolicy({ platform: 'qq', trigger: 'all' }) },
  })
  await manager.init()
  const adapter = manager['channels'].get(bot.id)
  assert.ok(adapter instanceof QQChannel)
  const send = (id: string, group = 'a') => adapter['handleDispatch']('GROUP_MESSAGE_CREATE', {
    id, content: 'Synthetic message', group_openid: group, author: { member_openid: 'arbitrary-sender' }, timestamp: new Date().toISOString(),
  })
  return { manager, store, bot, sessions, assignments, received, receipts, send, get policyExecutions() { return policyExecutions },
    onReceipt(callback: typeof afterReceipt) { afterReceipt = callback } }
}

test('roleless transport admits only receipt-time assigned inboxes without granting admin or replay', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      const recorded = Promise.withResolvers<void>(), flush = Promise.withResolvers<void>()
      f.onReceipt(async () => { recorded.resolve(); await flush.promise })
      const unbound = f.send('unbound')
      await recorded.promise
      f.assignments.set('group:a', 'personal:1')
      flush.resolve()
      await unbound
      f.onReceipt(undefined)
      await f.send('unbound') // platform re-delivery cannot revive an unbound receipt
      assert.equal(f.policyExecutions, 0)
      assert.equal(f.receipts.has('unbound'), true)
      await f.send('personal')
      f.assignments.set('group:b', 'service:1')
      await f.send('service', 'b')
      assert.deepEqual(f.received.map(message => [message.chatId, message.senderId, message.admin]), [
        ['group:a', 'arbitrary-sender', false], ['group:b', 'arbitrary-sender', false],
      ])
      const stale = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
      f.onReceipt(async () => { stale.resolve(); await resume.promise })
      const rejected = assert.rejects(f.send('stale'), /Arrival assignment changed/)
      await stale.promise
      f.assignments.set('group:a', 'personal:2')
      resume.resolve()
      await rejected
      assert.equal(f.received.length, 2)
    } finally { await f.manager.stopAll() }
  })
})

for (const operation of ['disable', 'delete'] as const) test(`${operation} fences transport receipt during retirement; failure releases fence`, async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace)
    try {
      f.assignments.set('group:a', 'personal:1')
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      const address = { projectId: 'p', botInstanceId: f.bot.id, platform: 'qq', conversationId: 'group:a' }
      f.sessions.retireIdleConversationContexts = async (matches) => {
        assert.equal(matches(channelSessionId(address)), true)
        assert.equal(matches(channelSessionId({ ...address, botInstanceId: 'sibling' })), false)
        entered.resolve()
        await release.promise
        throw Error('busy retirement')
      }
      const changing = operation === 'disable' ? f.manager.updateBot(f.bot.id, { config: { enabled: false } }) : f.manager.deleteBot(f.bot.id)
      const rejected = assert.rejects(changing, /busy retirement/)
      await entered.promise
      try {
        await assert.rejects(f.send('during'), /access change/)
        assert.equal(f.received.length, 0)
      } finally { release.resolve() }
      await rejected
      await f.send('after')
      assert.equal(f.received.length, 1)
    } finally { await f.manager.stopAll() }
  })
})
