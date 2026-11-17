import assert from 'node:assert/strict'
import test from 'node:test'
import { promptSections } from './prompt-sections.ts'
import { formatPromptQuote } from './prompt-documents.ts'
import { parseAgentContext } from './agent-types.ts'

const sections = [{ name: 'AGENT.md', content: 'same', characters: 4 }, { name: 'BOT.md', content: 'same', characters: 4 }]
test('prompt provenance requires complete exact ordered coverage, not guessed headings', () => {
  const text = 'same\n\n---\n\nsame'
  assert.deepEqual(promptSections(text, sections), sections)
  assert.deepEqual(parseAgentContext({ systemPrompt: text, sections, tools: [] }).sections, sections)
  for (const metadata of [undefined, [], [{ name: 'AGENT.md', content: text, characters: 0 }], [{ ...sections[0], content: 'other' }]]) {
    assert.deepEqual(promptSections(text, metadata), [])
  }
  assert.deepEqual(promptSections(text + 'tail', sections), [])
  assert.deepEqual(promptSections('same\n\nunattributed\n\nsame', sections), [])
  assert.deepEqual(promptSections('same\n\nsame', sections), sections)
})
test('prompt quotes are ordinary multiline quotes with a stable source, not a new input contract', () => {
  assert.equal(formatPromptQuote('BOT.md / bot / deployed revision abc', 'a\nb'), '> BOT.md / bot / deployed revision abc\n>\n> a\n> b\n\n')
  assert.equal(formatPromptQuote('source\nline', 'a\r\nb'), '> source line\n>\n> a\n> b\n\n')
})

test('explicit separators preserve internal whitespace and survive parser round trips', () => {
  const sections = [
    { name: 'role', content: 'Role \r\n', characters: 7, separatorBefore: '' },
    { name: 'tools', content: '\nTools', characters: 6, separatorBefore: '\n\n' },
  ]
  const prompt = sections.map(section => section.separatorBefore + section.content).join('')
  const parsed = parseAgentContext({ systemPrompt: prompt, tools: [], sections })
  assert.deepEqual(parsed.sections, sections)
  assert.deepEqual(promptSections(prompt, parsed.sections), sections)
  assert.deepEqual(promptSections(prompt, [{ ...sections[0], separatorBefore: 'wrong' }, sections[1]]), [])
})
