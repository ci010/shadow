import { test } from 'node:test'
import '../../testing/snapshot.ts'
import { getBuiltinAgentTypes } from '../agent-types/builtins.ts'
import type { AgentTypeDefinition } from '../agent-types/types.ts'
import type { SessionConfig } from '../../sessions/session-store.ts'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { guidelineProvider } from './guideline.ts'

/**
 * Pins the STATIC portion of the system prompt — the guideline section
 * (agent-type prompt + SAFETY.md + chat guidelines + TOOLS.md). This is the
 * part that is fully deterministic (no timestamps / workspace paths / identity
 * / memory), so it can be snapshotted safely. Dynamic providers (workspace,
 * runtime identity, project, memory) are intentionally NOT included here.
 *
 * Regenerate snapshots after an intentional change with:
 *   pnpm test:update
 */

function makeContext(
  agent: AgentTypeDefinition,
  isGroup: boolean,
): SessionPromptContext {
  return {
    behavior: {} as SessionConfig,
    channel: 'test',
    sessionId: 'test:pin',
    chatId: 'pin',
    isGroup,
    agent,
  }
}

test('system prompt — guideline section per builtin agent type (direct chat)', async (t) => {
  const builder = new ContextBuilder('/workspace')
  builder.register(guidelineProvider())

  const types = (await getBuiltinAgentTypes())
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const agent of types) {
    const prompt = await builder.buildSystemPrompt(makeContext(agent, false))
    await t.test(`guideline:${agent.name}:direct`, (st) => {
      st.assert.snapshot(prompt)
    })
  }
})

test('system prompt — guideline section for general agent in group chat', async (t) => {
  const builder = new ContextBuilder('/workspace')
  builder.register(guidelineProvider())

  const general = (await getBuiltinAgentTypes()).find((x) => x.name === 'general')
  if (!general) throw new Error('builtin agent type "general" not found')

  const prompt = await builder.buildSystemPrompt(makeContext(general, true))
  t.assert.snapshot(prompt)
})
