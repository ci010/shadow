import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdentityManager } from '../identity.ts'
import type { SessionPromptContext } from './builder.ts'
import { runtimeIdentityProvider } from './runtime.ts'
import type { ExecutionMode } from '../../sessions/execution-mode.ts'
import { unavailableCapabilities, type ChannelCapabilities } from '../../channels/capabilities.ts'

test('runtime identity uses explicit input source and target session, not sender prefixes or reply address', async (t) => {
  const identity = new IdentityManager('.')
  const lookup = t.mock.method(identity, 'lookupByAccount', async () => ({ personContext: 'Fixture user profile' }))
  const targets: string[] = []
  const provider = runtimeIdentityProvider({
    identity,
    getSkillsSummary: () => '',
    getAgentTypesSummary: () => '',
    getActiveSubagents: async (id) => { targets.push(id); return [] },
  })
  const ctx: SessionPromptContext = {
    behavior: {}, channel: 'discord', chatId: 'reply-address', sessionId: 'web:target',
    senderId: 'event:alice', senderName: 'Alice', inputSource: 'user',
    agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' },
  }
  const user = await provider.getPromptSection(ctx)
  assert(user?.includes('Fixture user profile'))
  assert(user?.includes('## Current User'))
  assert.equal(lookup.mock.callCount(), 1)
  assert.deepEqual(lookup.mock.calls[0].arguments, ['discord', 'event:alice'])

  for (const inputSource of ['event', 'session'] as const) {
    const prompt = await provider.getPromptSection({ ...ctx, inputSource, senderId: 'plain-sender' })
    assert(!prompt?.includes('Fixture user profile'))
    assert(!prompt?.includes('## Current User'))
  }
  assert.equal(lookup.mock.callCount(), 1)
  assert.deepEqual(targets, ['web:target', 'web:target', 'web:target'])
})

test('runtime advertises only mode-and-role permitted delegation', async () => {
  const provider = runtimeIdentityProvider({
    identity: new IdentityManager('.'),
    getSkillsSummary: () => '',
    getAgentTypesSummary: () => '<available_agent_types>Fixture roles</available_agent_types>',
  })

  test('runtime uses destination capabilities without granting delegation or raw platform tools', async () => {
    let capabilities: ChannelCapabilities = {
      ...unavailableCapabilities(), conversation: 'group', format: 'card',
      tables: true, codeBlocks: true, outboundMedia: ['image', 'file'],
      threads: 'topic', decisions: 'buttons', updates: 'replace',
    }
    const resolved: string[] = []
    const provider = runtimeIdentityProvider({
      identity: new IdentityManager('.'), getSkillsSummary: () => '', getAgentTypesSummary: () => '',
      getChannelCapabilities: (channel, chatId) => { resolved.push(`${channel}:${chatId}`); return capabilities },
    })
    const ctx: SessionPromptContext = {
      behavior: {}, channel: 'feishu', chatId: 'oc_room', sessionId: 'feishu:oc_room',
      agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' },
    }
    const root = await provider.getPromptSection(ctx)
    assert.match(root!, /Reusable subagent sessions can get a topic/)
    assert.match(root!, /native choices with text fallback/)
    assert.match(root!, /Output updates: replace/)
    assert.match(root!, /message tool communicates with other agent sessions/)
    assert.doesNotMatch(root!, /channel_send|channel_update|CardKit/)
    const call = await provider.getPromptSection({ ...ctx, mode: 'call', parentSessionId: 'feishu:parent' })
    assert.match(call!, /Allowed Delegation Modes\*\*: none/)
    assert.match(call!, /No new native thread\/topic/)
    assert.doesNotMatch(call!, /Ask decisions with yield/)
    assert.doesNotMatch(call!, /The message tool/)
    capabilities = unavailableCapabilities()
    const unavailable = await provider.getPromptSection(ctx)
    assert.match(unavailable!, /none verified/)
    assert.match(unavailable!, /numbered text choices/)
    assert.match(unavailable!, /use lists instead/)
    assert.deepEqual(resolved, ['feishu:oc_room', 'feishu:oc_room', 'feishu:oc_room'])
  })
  const context: SessionPromptContext = {
    behavior: {}, channel: 'test', sessionId: 'test:scope', chatId: 'scope',
    agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', root: true, source: 'builtin' },
  }
  const cases: Array<{ mode: ExecutionMode; parentSessionId?: string; expected: string }> = [
    { mode: 'session', expected: 'session, task' },
    { mode: 'session', parentSessionId: 'test:root', expected: 'task, call' },
    { mode: 'task', parentSessionId: 'test:root', expected: 'call' },
    { mode: 'call', parentSessionId: 'test:task', expected: 'none' },
  ]
  for (const { expected, ...scope } of cases) {
    const prompt = await provider.getPromptSection({ ...context, ...scope })
    assert(prompt?.includes(`**Allowed Delegation Modes**: ${expected}`))
    assert.equal(prompt?.includes('Fixture roles'), expected !== 'none')
  }
  const restricted = await provider.getPromptSection({
    ...context, mode: 'task', agent: { ...context.agent, allowedTools: ['read'] },
  })
  assert(restricted?.includes('**Allowed Delegation Modes**: none'))
  assert(!restricted?.includes('Fixture roles'))
})
