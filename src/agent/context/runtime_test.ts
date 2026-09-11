import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdentityManager } from '../identity.ts'
import type { SessionPromptContext } from './builder.ts'
import { runtimeIdentityProvider } from './runtime.ts'

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
    agent: { name: 'general', description: '', prompt: '', ephemeral: false, source: 'builtin' },
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
