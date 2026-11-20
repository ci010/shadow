import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { guidelineProvider } from './guideline.ts'

test('role, personal BOT deployment and shared tool instructions retain distinct provenance', async () => {
  const builder = new ContextBuilder(process.cwd())
  builder.register(guidelineProvider())
  const ctx: SessionPromptContext = { channel: 'web', chatId: 'fixture', sessionId: 'web:fixture', behavior: {},
    agent: { name: 'general', description: '', source: 'builtin', defaultMode: 'session', prompt: '# Agent Guideline\nRole-only instructions' },
    personalBotPrompt: 'Personal deployment instructions' }
  const details = await builder.buildSystemPromptDetails(ctx)
  assert.deepEqual(details.sections.map(section => section.name), ['AGENT.md', 'BOT.md (personal deployment)', 'tool-guidance'])
  assert.match(details.sections[0]!.content, /Role-only instructions/)
  assert.doesNotMatch(details.sections[0]!.content, /Personal deployment instructions/)
  assert.match(details.sections[1]!.content, /Personal deployment instructions/)
  assert.equal(details.systemPrompt, details.sections.map(section => (section.separatorBefore ?? '') + section.content).join(''))
  for (const section of details.sections) assert.equal(section.characters, section.content.length)
  assert.equal((await builder.buildSystemPromptDetails({ ...ctx, personalBotPrompt: undefined })).sections.length, 2)
})

import { AgentTypesManager } from '../types/manager.ts'

// V1 must preserve trimming and provider order; V2 must retain exact source provenance.
test('both assembly paths reconstruct their canonical bytes for all role definitions', async () => {
  const roles = new AgentTypesManager(process.cwd())
  await roles.load()
  const provider = guidelineProvider()
  for (const agent of roles.all()) for (const personal of [undefined, '', '\n Personal BOT body \r\n']) {
    const ctx: SessionPromptContext = { channel: 'web', chatId: 'fixture', sessionId: 'web:fixture', behavior: {}, agent, personalBotPrompt: personal }
    const builder = new ContextBuilder(process.cwd())
    builder.register({ name: 'before', getPromptSection: () => ' \nBefore\r\n' })
    builder.register(provider)
    builder.register({ name: 'after', getPromptSection: () => '\nAfter  ' })
    const v1 = await builder.buildSystemPromptDetails({ ...ctx, promptVersion: 'v1' })
    const v2 = await builder.buildSystemPromptDetails({ ...ctx, promptVersion: 'v2' })
    const canonical = provider.getPromptSection({ ...ctx, promptVersion: 'v1' }) as string
    assert.equal(v1.systemPrompt, `Before\n\n---\n\n${canonical.trim()}\n\n---\n\nAfter`, `${agent.name}, personal=${JSON.stringify(personal)}`)
    assert.match(v2.systemPrompt, /^# Information/)
    for (const result of [v1, v2]) {
      assert.equal(result.sections.map(section => (section.separatorBefore ?? '') + section.content).join(''), result.systemPrompt)
    }
  }
})

test('mismatched annotations cannot change canonical provider bytes', async () => {
  const builder = new ContextBuilder(process.cwd())
  builder.register({ name: 'fixture', getPromptSection: () => '  Original\n\ntext  ',
    getPromptSections: () => [{ name: 'incorrect', content: 'replacement', characters: 11 }] })
  const ctx = { channel: 'web', chatId: 'fixture', sessionId: 'web:fixture', behavior: {}, agent: { name: 'fixture', prompt: '', defaultMode: 'session' } } as SessionPromptContext
  const built = await builder.buildSystemPromptDetails(ctx)
  assert.equal(built.systemPrompt, 'Original\n\ntext')
  assert.equal(built.sections[0]!.name, 'fixture')
})
