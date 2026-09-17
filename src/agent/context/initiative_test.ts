import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionPromptContext } from './builder.ts'
import { initiativeProvider, type InitiativeContextStore } from './initiative.ts'

function context(initiativeId?: string): SessionPromptContext & { initiativeId?: string } {
  return {
    behavior: {},
    channel: 'web',
    sessionId: 'web:actor',
    chatId: 'actor',
    agent: { name: 'general', description: '', prompt: '', source: 'builtin', defaultMode: 'session' },
    initiativeId,
  }
}

test('initiative provider uses the explicit linkage and warns that prompt state is a snapshot', async () => {
  const calls: string[] = []
  const store: InitiativeContextStore = {
    getSummary(id, actor) { calls.push(`${id}:${actor}`); return 'Item one: needs handoff' },
    getSessionSummary() { throw new Error('Must not broaden explicit context') },
  }
  const result = await initiativeProvider(store).getPromptSection(context('cleanup'))
  assert.deepEqual(calls, ['cleanup:web:actor'])
  assert.match(result ?? '', /Item one: needs handoff/)
  assert.match(result ?? '', /snapshot/)
})

test('unlinked sessions receive only their participation summary, not every visible initiative', async () => {
  const calls: string[] = []
  const provider = initiativeProvider({
    getSummary() { throw new Error('No explicit linkage') },
    getSessionSummary(actor) { calls.push(actor); return null },
  })
  assert.equal(await provider.getPromptSection(context()), null)
  assert.deepEqual(calls, ['web:actor'])
})

test('missing explicitly linked initiatives fail instead of silently dropping shared context', async () => {
  const provider = initiativeProvider({ getSummary: () => null, getSessionSummary: () => null })
  await assert.rejects(async () => provider.getPromptSection(context('missing')), /not available in this Project/)
})
