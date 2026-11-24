import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { renderBehaviorMarkdown as render, snapshotBehaviorFragments } from './behavior-markdown.ts'
import { agentDraftScope, parseAgentPromptDraft, readAgentPromptDraft, saveAgentPromptDraft, SubOverrideStore } from './sub-override.ts'

const facts = { mode: 'session', channel: 'web', tools: new Set(['read', 'search']) }

test('behavior gates require all tools and match any listed channel or mode', () => {
  const markdown = `Intro\n\n<!-- when: tools=read,search; channels=web,discord; modes=session -->\nConditional\n<!-- /when -->\n\nEnd\n`
  assert.equal(render(markdown, facts), 'Intro\n\nConditional\n\nEnd\n')
  assert.match(render(markdown, { ...facts, channel: 'discord' }), /Conditional/)
  for (const context of [{ ...facts, tools: new Set(['read']) }, { ...facts, channel: 'qq' }, { ...facts, mode: 'call' }]) {
    assert.doesNotMatch(render(markdown, context), /Conditional|<!--/)
  }
  const example = '```md\n<!-- when: an example -->\n```\n'
  assert.equal(render(example, facts), example)
})

test('behavior fragments are explicit, bounded and do not resolve paths or recursive includes', () => {
  const markdown = 'Original\n\n<!-- include: evidence -->\n'
  const source = { evidence: '<!-- when: tools=read -->\nExample\n<!-- /when -->\n', unused: 'Ignore me' }
  assert.deepEqual(snapshotBehaviorFragments(markdown, source), { evidence: source.evidence })
  assert.equal(render(markdown, facts, source), 'Original\n\nExample\n')
  assert.throws(() => render(markdown, facts, {}), /Unknown behavior fragment/)
  assert.throws(() => render(markdown, facts, { evidence: '<!-- include: other -->\n' }), /Invalid behavior include/)
  for (const invalid of ['<!-- include: ../../private -->', '<!-- /when -->', '<!-- when: shell=cmd -->',
    '<!-- when: modes=other -->', '<!-- when: tools=, -->', '<!-- when: tools=read -->',
    '<!-- when: tools=read -->\n<!-- when: tools=write -->']) {
    assert.throws(() => render(invalid, facts), /behavior/i)
  }
})

test('all built-in Markdown bodies resolve their registered fragments', async () => {
  for (const agent of await getBuiltinAgentTypes()) {
    const result = render(agent.prompt, facts)
    assert.doesNotMatch(result, /<!-- (?:include:|when:|\/when|behavior-v2)/, agent.name)
  }
})

test('full body draft snapshots pin fragment bytes; legacy sub revisions remain distinct', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-behavior-'))
  try {
    const agent = (await getBuiltinAgentTypes()).find(role => role.name === 'sub')!
    const store = new SubOverrideStore(directory)
    const markdown = '# New complete role\n\n<!-- include: discovery -->'
    const revision = await saveAgentPromptDraft(store, agent, markdown)
    const draft = await readAgentPromptDraft(store, agent, revision)
    assert.equal(draft.markdown, markdown)
    assert.deepEqual(parseAgentPromptDraft(draft), draft)
    assert.match(render(markdown, facts, draft.fragments), /Tool discovery and recovery/)
    assert.throws(() => parseAgentPromptDraft({ ...draft, fragments: { discovery: 'Different bytes' } }), /Invalid pinned/)
    await assert.rejects(saveAgentPromptDraft(store, agent, '<!-- include: unknown -->'), /Unknown behavior fragment/)
    const legacy = await store.save(markdown)
    assert.notEqual(legacy, revision)
    assert.deepEqual(await readAgentPromptDraft(store, agent, legacy), { scope: JSON.stringify(agentDraftScope(agent)), revision: legacy, markdown })
    await assert.rejects(store.read(revision), /not found/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
