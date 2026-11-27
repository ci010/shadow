import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPACT_DRAFT_PATH,
  COMPACT_EVENT_SOURCE,
  COMPACT_EVENT_TYPE,
  CompactDraft,
  compactEvent,
} from './current-context.ts'

function draftText(summary = 'Finished collecting evidence.', objective = 'No action remains.'): string {
  return `## Summary\n\n${summary}\n\n## Current Objective\n\n${objective}\n`
}

test('compaction event describes a draft-only workflow', () => {
  const event = compactEvent('compact-1', '2026-03-16T12:00:00Z')
  assert.deepEqual(event.content[0], {
    type: 'text',
    text: `<event type="${COMPACT_EVENT_TYPE}" source="${COMPACT_EVENT_SOURCE}" event-id="compact-1" />`,
  })
  const instructions = event.content[1]
  assert.equal(instructions.type, 'text')
  assert.ok(instructions.text.includes(COMPACT_DRAFT_PATH))
  assert.match(instructions.text, /invoke_tool\(\{name:"handoff_submit", args:\{\}\}\)/)
  assert.match(instructions.text, /read v:sessions to discover the available segment paths/)
  assert.match(instructions.text, /in-flight external operations and uncertain outcomes/)
  assert.doesNotMatch(instructions.text, /handoff_summary/)

})

test('parses a Markdown continuation without flattening its summary', () => {
  const draft = new CompactDraft()
  const summary = [
    '### Constraints and decisions',
    '- The owner requested no restart; use logs from the running instance.',
    '- Use the existing service because the alternate endpoint timed out.',
    '',
    '### Open operations',
    '- Import `job-515` is in flight. Inspect the receipt before any retry.',
  ].join('\n')
  const objective = 'Check `job-515` and report whether it completed.'
  const recent = ['User: Verify the import without restarting.', 'Tool: Import request accepted.']
  const markdown = `${draftText(summary, objective)}\n## Recent Transcript\n\n${recent.map(line => `- ${line}`).join('\n')}\n`
    .replaceAll('\n', '\r\n')
  draft.replace(markdown)
  assert.equal(draft.content, markdown)
  assert.deepEqual(draft.finalize(), { summary, currentObjective: objective, recentTranscript: recent })
})

test('requires a current draft and never falls back to a replaced draft', () => {
  const draft = new CompactDraft()
  assert.equal(draft.content, '')
  assert.throws(() => draft.finalize(), /Write a nonempty Markdown draft/)
  draft.replace(draftText())
  assert.deepEqual(draft.finalize(), {
    summary: 'Finished collecting evidence.',
    currentObjective: 'No action remains.',
    recentTranscript: [],
  })
  draft.replace(draftText('   ', 'Do another check.'))
  assert.throws(() => draft.finalize(), /Add a nonempty ## Summary/)
  draft.replace('  \r\n  ')
  assert.throws(() => draft.finalize(), /Write a nonempty Markdown draft/)
  draft.replace(draftText('The second check passed.'))
  assert.equal(draft.finalize().summary, 'The second check passed.')
})

test('rejects malformed, unordered, or duplicated sections with correction guidance', () => {
  const draft = new CompactDraft()
  for (const [markdown, error] of [
    [draftText('Evidence collected.', ' '), /Add a nonempty ## Current Objective/],
    ['## Summary\nOnly summary', /Add a nonempty ## Current Objective/],
    ['## Current Objective\nFinish\n\n## Summary\nSummary', /Use ## Summary next/],
    [`${draftText()}\n## Summary\nDuplicate`, /Use ## Recent Transcript next/],
    [`\`\`\`markdown\n${draftText()}\`\`\``, /Start the draft with ## Summary/],
    ['## Summary\n```\n## Current Objective\nNot a heading.\n```', /Add a nonempty ## Current Objective/],
    ['## Summary\n```\n## Current Objective\nNot a heading.', /Close the Markdown code fence or remove it/],
    [`${draftText()}\n## Recent Transcript\n- One line\n  Continued`, /Use a one-line Markdown bullet/],
    [`${draftText()}\n## Recent Transcript\n\n`, /omit the optional section/],
  ] as const) {
    draft.replace(markdown)
    assert.throws(() => draft.finalize(), error)
  }
})

test('bounds full replacements and rejects semantic overflow without truncation', () => {
  const draft = new CompactDraft()
  draft.replace(draftText())
  assert.throws(() => draft.replace('x'.repeat(8_001)), /Shorten .* to at most 8000 characters/)
  assert.equal(draft.content, '')
  assert.throws(() => draft.finalize(), /Write a nonempty Markdown draft/)

  draft.replace(draftText('s'.repeat(4_000), 'o'.repeat(240)))
  assert.equal(draft.finalize().summary.length, 4_000)
  assert.equal(draft.finalize().currentObjective.length, 240)
  for (const [markdown, error] of [
    [draftText('s'.repeat(4_001)), /Shorten ## Summary to at most 4000/],
    [draftText('Summary.', 'o'.repeat(241)), /Shorten ## Current Objective to at most 240/],
    [`${draftText()}\n## Recent Transcript\n${'- Item\n'.repeat(25)}`, /Keep at most 24 bullets/],
    [`${draftText()}\n## Recent Transcript\n- ${'x'.repeat(241)}`, /Shorten each ## Recent Transcript bullet/],
  ] as const) {
    draft.replace(markdown)
    assert.throws(() => draft.finalize(), error)
  }
})
