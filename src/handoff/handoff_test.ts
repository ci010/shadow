import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { renderContinuationSummary } from './manager.ts'
import type { HandoffContext } from './manager.ts'
import { HandoffSummaryTool } from './tools.ts'
import type { HandoffCapture } from './tools.ts'
import { SessionMemoryParser } from '../sessions/session-memory.ts'

function fallback(): HandoffContext {
  return { summary: '', currentObjective: '', recentTranscript: [] }
}

test('continuation summary — slim md is just Current Focus + Progress', () => {
  const md = renderContinuationSummary(
    {
      summary: 'Refactored the memory layer; tests pass.',
      currentObjective: 'Wire the relevance gate.',
      recentTranscript: ['x', 'y'],
    },
    '2026-07-07T00:00:00.000Z',
  )

  assert(md.includes('# Session Summary'))
  assert(md.includes('_Updated: 2026-07-07T00:00:00.000Z_'))
  assert(md.includes('## Current Focus\nWire the relevance gate.'))
  assert(md.includes('## Progress\nRefactored the memory layer; tests pass.'))

  // The slimmed handoff no longer emits the old structured sections.
  assert(!md.includes('## Themes'))
  assert(!md.includes('## Decisions'))
  assert(!md.includes('## Rejected Approaches'))
})

test('continuation summary — empty context renders (none)', () => {
  const md = renderContinuationSummary(fallback(), '2026-07-07T00:00:00.000Z')
  assert(md.includes('## Current Focus\n(none)'))
  assert(md.includes('## Progress\n(none)'))
})

test('handoff_summary tool — captures context, no memory-curation step', async () => {
  const capture: HandoffCapture = {
    context: null,
    memoryState: SessionMemoryParser.parse(''),
    memoryUpdated: false,
  }
  const tool = new HandoffSummaryTool(capture, fallback())

  const msg = await tool.execute({
    summary: 'did things',
    currentObjective: 'next thing',
    recentTranscript: ['a'],
  })

  assertEquals(capture.context?.currentObjective, 'next thing')
  assertEquals(capture.context?.summary, 'did things')
  // The message no longer points the agent at update_session_memory.
  assert(!msg.includes('update_session_memory'))
})
