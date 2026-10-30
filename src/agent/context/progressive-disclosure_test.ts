import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { getBuiltinSkills } from '../../skills/builtins.ts'
import { capabilityDiscovery } from './capability-prompt.ts'
import { toolsGuideline } from './tools-guideline.ts'

const ctx: SessionPromptContext = {
  behavior: {}, channel: 'web', chatId: 'fixture', sessionId: 'fixture',
  agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' },
}

test('explicit skill links deduplicate discovery regardless of provider order, without mutating providers', async () => {
  const catalog = '<available_skills>\n  <skill name="orchestration">Teams</skill>\n  <skill name="other">Other</skill>\n</available_skills>'
  for (const reverse of [false, true]) {
    const builder = new ContextBuilder('/workspace')
    const providers = [
      { name: 'catalog', getPromptSection: () => catalog },
      { name: 'guide', getPromptSection: () => 'For teams read `v:skills/orchestration`.' },
    ]
    for (const provider of reverse ? providers.reverse() : providers) builder.register(provider)
    const result = await builder.buildSystemPromptDetails(ctx)
    assert.doesNotMatch(result.systemPrompt, /<skill name="orchestration">/)
    assert.match(result.systemPrompt, /<skill name="other">/)
    assert.match(result.systemPrompt, /v:skills\/orchestration/)
    for (const section of result.sections) assert.equal(section.characters, section.content.length)
    assert.match(catalog, /<skill name="orchestration">/)
  }
})

test('generic directories and resource links do not suppress a skill hint', async () => {
  const builder = new ContextBuilder('/workspace')
  builder.register({ name: 'fixture', getPromptSection: () => '`v:skills/` and `v:skills/other/reference.md`\n<available_skills>\n<skill name="other">Read v:skills/other</skill>\n</available_skills>' })
  assert.match(await builder.buildSystemPrompt(ctx), /<skill name="other">/)
})

test('orchestration is bundled, searchable guidance without tool declarations or new authority', async () => {
  const skills = await getBuiltinSkills()
  const skill = skills.get('orchestration')!
  assert.ok(skill)
  assert.match(skill.meta.description, /agent teams/)
  assert.equal(skill.meta.tools, undefined)
  for (const rule of [/Do not create a node for every tool call/, /explicit file\/domain ownership/, /only PASS delivers success/, /confirmed cancellation/, /creator metadata is not structural parenthood/, /not a new teams runtime/, /LAST message a non-silent request/, /decisionKey/, /without a response, active-context injection or wakeup/]) {
    assert.match(skill.body, rule)
  }
  // Discovery remains capability-gated; the skill itself does not add tools.
  const entry = '<skill name="orchestration">Teams</skill>'
  assert.equal(capabilityDiscovery(entry, { ...ctx, mode: 'call' }), '')
  assert.equal(capabilityDiscovery(entry, { ...ctx, agent: { ...ctx.agent, allowedTools: ['read'] } }), '')
  assert.match(capabilityDiscovery(entry, ctx), /orchestration/)
})


test('compact coordination retains boundaries and moves Work fields and messaging tutorials out of the prompt', () => {
  const prompt = toolsGuideline(ctx)
  assert.match(prompt, /Convention writes require genuine human instructions or decisions, never inferred approval/)
  assert.match(prompt, /historical conventions are not current rules/)
  assert.match(prompt, /silent is FYI only, never required materials, corrections or unblockers/)
  assert.match(prompt, /Use reply for pending requests; final addresses the current reader/)
  assert.match(prompt, /Reassignment does not stop running operations/)
  assert.doesNotMatch(prompt, /workKey identifies|decisionKey identifies|LAST message|attention: "blocker"/)
  assert.doesNotMatch(toolsGuideline({ ...ctx, agent: { ...ctx.agent, allowedTools: ['read'] } }), /### Project rules|### Messaging/)
})

test('advanced answering skills keep syntax and safety on demand and cross-link by explanatory purpose', async () => {
  const skills = await getBuiltinSkills()
  const html = skills.get('answer-html')!
  const flow = skills.get('answer-flow')!
  assert.ok(html)
  assert.equal(html.meta.tools, undefined)
  for (const rule of [/Prefer ordinary Markdown/, /spatial grouping/, /v:skills\/answer-flow/, /data-md/, /no scripts, inline styles\/events/, /Do not imitate approval controls/, /implemented, proposed and unverified/]) assert.match(html.body, rule)
  assert.match(flow.body, /v:skills\/answer-html/)
  assert.match(flow.body, /Do not load both skills unless both formats help/)
  const builder = new ContextBuilder('/workspace')
  builder.register({ name: 'fixture', getPromptSection: () => 'Read `v:skills/answer-flow` or `v:skills/answer-html` when useful.\n<available_skills>\n<skill name="answer-flow">Flow</skill>\n<skill name="answer-html">HTML</skill>\n</available_skills>' })
  assert.doesNotMatch(await builder.buildSystemPrompt(ctx), /<skill name="answer-(?:flow|html)">/)
})
