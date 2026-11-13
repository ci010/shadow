import assert from 'node:assert/strict'
import test from 'node:test'
import { automationResult } from './automation-result.ts'
import type { AutomationRunSummary } from './automations.ts'
const run: AutomationRunSummary = { id: 'run', sessionId: 'session', startedAt: '2026-01-01T00:00:00Z', status: 'completed' }
const messages = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'Final summary', timestamp: '2026-01-01T00:01:00Z' }]
test('learning partial is a stable metadata result at completion, without inventing a timestamp', () => {
  const learning = { status: 'partial' as const, summary: 'Long summary\n'.repeat(500), artifacts: 1, events: 2, evaluated: 0 }
  const result = automationResult({ ...run, learning }, 'session', messages)!
  assert.equal(result.source, 'metadata')
  assert.equal(result.summary, learning.summary)
  assert.equal(result.timestamp, undefined)
  assert.equal(result.replaceIndex, undefined)
  assert.deepEqual(automationResult({ ...run, learning }, 'session', messages), result)
  assert.equal(messages.length, 2)
  const same = automationResult({ ...run, learning: { ...learning, summary: 'Final summary' } }, 'session', messages)!
  assert.equal(same.replaceIndex, 1, 'A final response equal to the receipt is projected only once')
})
test('generic completed, failed and cancelled runs project the existing final, with its real timestamp', () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const result = automationResult({ ...run, status }, 'session', messages)!
    assert.equal(result.replaceIndex, 1)
    assert.equal(result.summary, messages[1].content)
    assert.equal(result.timestamp, messages[1].timestamp)
    assert.equal(result.source, 'response')
  }
})
test('ordinary, loading, running, unknown, switched runs and targeted history never borrow a receipt', () => {
  assert.equal(automationResult(undefined, 'session', messages), undefined)
  assert.equal(automationResult(run, 'other', messages), undefined)
  assert.equal(automationResult(run, 'session', messages, true), undefined)
  assert.equal(automationResult(run, 'session', messages, false, true), undefined)
  for (const status of ['running', 'unknown'] as const) assert.equal(automationResult({ ...run, status }, 'session', messages), undefined)
  assert.equal(automationResult(run, 'session', [])?.summary, '')
})
test('prepending older history preserves receipt identity and never replaces tool or event rows', () => {
  const before = automationResult(run, 'session', messages)!
  const after = automationResult(run, 'session', [{ role: 'assistant', content: 'Old final' }, ...messages])!
  assert.equal(after.key, before.key)
  assert.equal(after.replaceIndex, 2)
  for (const last of [{ role: 'tool', content: 'result', event: 'tool_result' }, { role: 'assistant', content: 'summary', isSummary: true }]) {
    assert.equal(automationResult(run, 'session', [last])?.replaceIndex, undefined)
  }
})

test('every learning receipt status preserves its exact summary and execution status', () => {
  for (const status of ['applied', 'no_change', 'partial', 'blocked', 'draft_only'] as const) {
    const learning = { status, summary: 'Saved summary\nwith full evidence.', artifacts: 0, events: 0, evaluated: 0 }
    const input = structuredClone(messages)
    const receipt = automationResult({ ...run, learning }, 'session', input)!
    assert.equal(receipt.run.learning?.status, status)
    assert.equal(receipt.run.status, 'completed')
    assert.equal(receipt.summary, learning.summary)
    assert.deepEqual(input, messages, 'Projection does not mutate persisted-message inputs')
  }
})

test('an empty current segment never promotes the seeded older final response', () => {
  const receipt = automationResult(run, 'session', messages, false, false, messages.length)!
  assert.equal(receipt.summary, '')
  assert.equal(receipt.replaceIndex, undefined)
  assert.equal(receipt.timestamp, undefined)
  assert.equal(receipt.source, 'metadata')
})
