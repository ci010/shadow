import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentTypesManager } from '../types/manager.ts'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { executionContractProvider, guidelineProvider } from './guideline.ts'

test('built-in sub separates authorable behavior from fixed operations and execution contract', async () => {
  const roles = new AgentTypesManager(process.cwd())
  await roles.load()
  const agent = roles.all().find(role => role.name === 'sub')!
  const builder = new ContextBuilder(process.cwd())
  builder.register(executionContractProvider())
  builder.register(guidelineProvider())
  for (const mode of ['session', 'task', 'call'] as const) {
    const ctx: SessionPromptContext = { agent, mode, taskReviewable: true, execNodeOnly: true,
      parentSessionId: mode === 'session' ? undefined : 'web:parent',
      behavior: {}, channel: 'web', chatId: 'fixture', sessionId: 'web:fixture', personalBotPrompt: 'Personal behavior' }
    const { systemPrompt, sections } = await builder.buildSystemPromptDetails(ctx)
    assert.deepEqual(sections.map(({ name, kind, editability }) => [name, kind, editability]), [
      ['execution-contract', undefined, 'fixed'],
      ['AGENT.md', 'behavior', 'editable'],
      ['BOT.md (personal deployment)', 'behavior', 'editable'],
      ['sub-behavior.md', 'behavior', 'editable'],
      ['tool-discovery-reference', 'information', 'fixed'],
      ['tool-operations', undefined, 'fixed'],
    ])
    assert.equal(systemPrompt, sections.map(section => (section.separatorBefore ?? '') + section.content).join(''))
    assert.doesNotMatch(sections[1]!.content, /exact replacement|delegated assignment|parent-owned/)
    assert.match(sections[3]!.content, /exact replacement/)
    assert.doesNotMatch(sections[3]!.content, /timeout_ms|designated reviewer|report_to/)
    assert.match(sections[5]!.content, /Inline JavaScript only/)
    assert.equal(systemPrompt.includes('bounded independent result'), mode !== 'call')
    assert.equal(systemPrompt.includes('Task discovery title and description are parent-owned'), mode === 'task')
    assert.equal(systemPrompt.includes('submits a revision for review, not acceptance'), mode === 'task')
    assert.equal(systemPrompt.includes('local and foreground-only'), mode === 'call')
    assert.equal(systemPrompt.includes('Asynchronous creation admits an ID'), mode === 'session')
    assert.doesNotMatch(systemPrompt, /<!-- capability:/)
    const revision = 'a'.repeat(64)
    const overridden = await builder.buildSystemPromptDetails({ ...ctx, subDraft: { revision, markdown: 'Use a concise verification checklist.' } })
    assert.equal(overridden.sections[3]?.name, `sub-behavior.md@${revision}`)
    assert.match(overridden.sections[3]!.content, /concise verification checklist/)
    assert.doesNotMatch(overridden.sections[3]!.content, /exact replacement/)
    assert.deepEqual(overridden.sections.filter((_, i) => i !== 3), sections.filter((_, i) => i !== 3))
  }
  const restricted = await builder.buildSystemPromptDetails({ agent: { ...agent, allowedTools: ['read'] },
    mode: 'session', behavior: {}, channel: 'web', chatId: 'fixture', sessionId: 'web:fixture' })
  assert.doesNotMatch(restricted.systemPrompt, /bounded independent result|exact replacement|### Shell|For MCP recovery/)
})
