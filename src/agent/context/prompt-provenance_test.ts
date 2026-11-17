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

// Compare against the pre-provenance formula, not a refreshed prompt snapshot.
import { readFileSync } from 'node:fs'
import { AgentTypesManager } from '../types/manager.ts'
import { capabilityPrompt } from './capability-prompt.ts'
import { toolsGuideline } from './tools-guideline.ts'

test('provenance preserves legacy assembly bytes for every built-in role and personal BOT whitespace', async () => {
  const roles = new AgentTypesManager(process.cwd())
  await roles.load()
  const tools = readFileSync(new URL('./AGENTS.tools.md', import.meta.url), 'utf8')
  for (const agent of roles.all()) for (const personal of [undefined, '', '\n Personal BOT body \r\n']) {
    const ctx: SessionPromptContext = { channel: 'web', chatId: 'fixture', sessionId: 'web:fixture', behavior: {}, agent, personalBotPrompt: personal }
    const legacyRole = personal === undefined ? agent.prompt : `${agent.prompt}\n\n# Personal BOT instructions\n${personal}`
    const legacy = [capabilityPrompt(legacyRole, ctx), capabilityPrompt(tools, ctx), toolsGuideline(ctx)].join('\n\n').trim()
    const builder = new ContextBuilder(process.cwd())
    builder.register({ name: 'before', getPromptSection: () => ' \nBefore\r\n' })
    builder.register(guidelineProvider())
    builder.register({ name: 'after', getPromptSection: () => '\nAfter  ' })
    const built = await builder.buildSystemPromptDetails(ctx)
    assert.equal(built.systemPrompt, `Before\n\n---\n\n${legacy}\n\n---\n\nAfter`, `${agent.name}, personal=${JSON.stringify(personal)}`)
    assert.equal(built.sections.map(section => (section.separatorBefore ?? '') + section.content).join(''), built.systemPrompt)
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
