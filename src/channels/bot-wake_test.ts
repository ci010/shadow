import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { channelSessionId } from '../bus/events.ts'
import { MemoryDomains } from '../memory/domains.ts'
import { BotInstanceStore } from './bot-store.ts'
import { IntegrationStore } from './integration-store.ts'
import { DiscordIntegration } from './integration.ts'
import { Tools } from '../tools/registry.ts'
import type { DiscordBinding, DiscordIntegrationTransport, IntegrationChange } from './integration-contract.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { SessionInput } from '../sessions/input.ts'

async function fixture(t: TestContext, workspace: string) {
  const projectId = 'wake-test'
  const agents = new AgentTypesManager(workspace)
  await agents.load()
  t.after(() => agents.stopWatching())
  const bots = new BotInstanceStore({ projectId, path: join(workspace, 'synthetic-bots.json') })
  const bot = bots.create('discord', 'Synthetic', { token: 'fixture-token', enabled: true })
  const memory = new MemoryDomains(projectId, join(workspace, 'domains'))
  const store = new IntegrationStore({ projectId, workspace, directory: join(workspace, 'integration'), bots, agents, memory })
  const integration = new DiscordIntegration({ projectId, workspace, store, bots, memory, baseTools: new Tools(workspace) })
  let canSend = true, canView = true, inspectedActor = ''
  const transport: DiscordIntegrationTransport = {
    directory: async () => ({ botUserId: '900', guildId: null, guildCursor: null, guilds: [], channels: [], roles: [], synchronizedAt: new Date().toISOString(), completeness: 'guild-page', notice: 'Synthetic' }),
    members: async () => [], inspectTarget: async () => ({ botUserId: '900', roleIds: [] }),
    inspect: async (_botId, chatId, actor) => {
      inspectedActor = actor
      return { botUserId: '900', location: { id: chatId, name: 'Group', type: 0, guildId: '100', guildName: null, parentId: null, parentName: null, recipientId: null },
        actor: { id: actor, name: 'Synthetic', roleIds: [] }, canSend, canView, canReadHistory: true }
    },
  }
  const states = new Map<string, SessionState>()
  integration.attach({ getSessionState: (id: string) => states.get(id) ?? null, listSessions: () => [], invalidateChannelContexts: () => {} } as unknown as SessionManager, transport, async () => null)
  t.after(() => integration.stop())
  const owner = { kind: 'owner', id: 'synthetic-owner' } as const
  const approve = async (change: IntegrationChange) => {
    const draft = await store.propose(owner, change, store.snapshot().revision, new AbortController().signal)
    await store.commit(owner, draft.id, draft.hash, new AbortController().signal)
  }
  const profile = { id: randomUUID(), name: 'wake-helper', displayName: 'Wake helper', markdown: '---\nname: wake-helper\ndefaultMode: session\n---\nSynthetic helper.', execution: 'restricted' as const, tools: [], readDomains: [], skills: [] }
  await approve({ kind: 'agent.save', agent: profile })
  const binding: DiscordBinding = { id: randomUUID(), botInstanceId: bot.id, botUserId: '900', target: { kind: 'channel', guildId: '100', channelId: '201' },
    enabled: true, agentId: profile.id, trigger: 'mention', participants: { everyone: false, userIds: ['500'], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false }
  await approve({ kind: 'bindings.save', bindings: [binding] })
  const address = { projectId, platform: 'discord' as const, botInstanceId: bot.id, conversationId: '201' }
  const sessionId = channelSessionId(address)
  const wake = (): SessionInput => ({ kind: 'message', id: randomUUID(), timestamp: new Date().toISOString(), policy: 'queue',
    source: { kind: 'event', eventId: randomUUID(), type: 'bot-wake', source: 'bot-wake' },
    replyTo: { channel: 'discord', chatId: '201', channelAddress: address }, content: 'Synthetic scheduled tick' })
  const openBoundary = () => {
    const state = { sessionId, segmentIndex: -1 } as SessionState
    states.set(sessionId, state)
    const policy = integration.resolve(sessionId)!
    state.channelBoundary = integration.boundary(policy, sessionId, state)
    return integration.tools(policy, sessionId, state).boundary!
  }
  return { bot, integration, sessionId, wake, openBoundary, approve, binding,
    inspectedActor: () => inspectedActor, denySend: () => { canSend = false }, denyView: () => { canView = false } }
}

test('Discord wake admission requires opaque host proof; modified payload, binding and stale revision are rejected', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace)
    const input = f.wake()
    assert.throws(() => f.integration.authorize(f.sessionId, input), /verified platform|events cannot/)
    f.integration.admitBotWake(f.sessionId, input)
    assert.doesNotThrow(() => f.integration.authorize(f.sessionId, structuredClone(input)), 'exact queued copy retains its host proof')
    assert.throws(() => f.integration.authorize(f.sessionId, { ...input, content: 'changed' } as SessionInput))
    const other = f.sessionId.replace('201', '202')
    assert.throws(() => f.integration.authorize(other, input))
    await f.approve({ kind: 'bindings.save', bindings: [{ ...f.binding, trigger: 'all' }] })
    assert.throws(() => f.integration.authorize(f.sessionId, input), /verified platform|events cannot/)
  })
})

test('host-proven Discord wake rechecks live bot permissions before inference/output and releases admission on finish', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace)
    const input = f.wake()
    f.integration.admitBotWake(f.sessionId, input)
    const boundary = f.openBoundary()
    try {
      await boundary.begin(input, new AbortController().signal)
      assert.equal(f.inspectedActor(), '900', 'wake permission is inspected as the configured bot, not forged group owner')
      await boundary.beforeInference(new AbortController().signal)
      f.denySend()
      await assert.rejects(boundary.beforeOutput(new AbortController().signal), /permission/)
      boundary.finish()
      assert.throws(() => f.integration.authorize(f.sessionId, input), /verified platform|events cannot/)
    } finally { boundary.close() }
  })
})

test('host proof does not bypass lost Discord view permission or binding disablement', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace)
    const input = f.wake()
    f.integration.admitBotWake(f.sessionId, input)
    const boundary = f.openBoundary()
    try {
      f.denyView()
      await assert.rejects(boundary.begin(input, new AbortController().signal), /permission/)
      await f.approve({ kind: 'bindings.save', bindings: [{ ...f.binding, enabled: false }] })
      assert.throws(() => f.integration.authorize(f.sessionId, input), /disabled|not assigned/)
    } finally { boundary.finish(); boundary.close() }
  })
})

test('connection invalidation revokes an unconsumed host wake proof', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t, workspace)
    const input = f.wake()
    f.integration.admitBotWake(f.sessionId, input)
    f.integration.invalidateBot(f.bot.id)
    assert.throws(() => f.integration.authorize(f.sessionId, input), /verified platform|events cannot|changed/)
  })
})
