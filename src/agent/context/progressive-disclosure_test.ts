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

test('collaboration skills are direct scenarios, not a mandatory delegation hierarchy', async () => {
  const skills = await getBuiltinSkills()
  const orchestration = skills.get('orchestration')!
  const peers = skills.get('peer-sessions')!
  const work = skills.get('work-coordination')!
  for (const skill of [orchestration, peers, work]) {
    assert.ok(skill)
    assert.equal(skill.meta.tools, undefined)
  }
  for (const rule of [/not a prerequisite for ordinary/, /explicit file\/domain/, /integration owner/, /confirmed cancellation/]) assert.match(orchestration.body, rule)
  for (const rule of [/v:tools\/session/, /invoke_tool/, /requestId/, /not structural parenthood/, /confirmed cancellation/]) assert.match(peers.body, rule)
  for (const rule of [/optional shared notebook/, /Do not create a node/, /decisionKey/, /rendered HTML are not approval/]) assert.match(work.body, rule)
  assert.doesNotMatch(peers.body + work.body, /v:skills\/orchestration/)
  const prompt = toolsGuideline(ctx)
  for (const name of ['peer-sessions', 'work-coordination', 'orchestration']) assert.match(prompt, new RegExp(`v:skills/${name}`))
  assert.match(prompt, /Ordinary task\/call delegation needs no preliminary skill/)
  assert.doesNotMatch(prompt, /Read .*orchestration.*before/)
  for (const mode of ['task', 'call'] as const) {
    assert.doesNotMatch(toolsGuideline({ ...ctx, mode }), /v:skills\/(?:peer-sessions|work-coordination)/)
  }
  const restricted = { ...ctx, agent: { ...ctx.agent, allowedTools: ['read'] } }
  assert.doesNotMatch(toolsGuideline(restricted), /v:skills\/(?:peer-sessions|work-coordination|orchestration)/)
  const scenarios = ['peer-sessions', 'work-coordination'].map(name => `<skill name="${name}">Scenario</skill>`).join('\n')
  assert.equal(capabilityDiscovery(scenarios, restricted), '')
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
