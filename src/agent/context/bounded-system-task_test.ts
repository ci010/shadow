import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { guidelineProvider, executionContractProvider } from './guideline.ts'

for (const name of ['work-organizer']) test(`${name} uses only its actual bounded contract, not environment providers`, async () => {
  const agent = (await getBuiltinAgentTypes()).find(role => role.name === name)!
  const context: SessionPromptContext = { agent, channel: name, chatId: 'run', sessionId: `${name}:run`, mode: 'task', behavior: {} }
  const builder = new ContextBuilder('.')
  builder.register({ name: 'runtime', getPromptSection() { throw new Error('Must not discover shell/device/workspace capabilities') } })
  builder.register(executionContractProvider())
  builder.register(guidelineProvider())
  const result = await builder.buildSystemPromptDetails(context)
  assert.deepEqual(result.sections.map(section => section.name), ['bounded-system-task'])
  assert.match(result.systemPrompt, /untrusted data/)
  assert.match(result.systemPrompt, /acceptance/)
  assert.doesNotMatch(result.systemPrompt, /PowerShell|Platform|Working directory|### Shell|Tool discovery|skill_read|microphone|Delegation Parent/)
  assert.match(result.systemPrompt, /organization_finish/)
  // Name alone must not shrink a tool-capable/ordinary session's context.
  const ordinary = new ContextBuilder('.')
  ordinary.register({ name: 'runtime', getPromptSection: () => 'FULL ENVIRONMENT' })
  assert.equal(await ordinary.buildSystemPrompt({ ...context, channel: 'web' }), 'FULL ENVIRONMENT')
  assert.equal(await ordinary.buildSystemPrompt({ ...context, agent: { ...agent, allowedTools: ['exec'] } }), 'FULL ENVIRONMENT')
})
