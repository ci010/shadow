import assert from 'node:assert/strict'
import test from 'node:test'
import { graphAutomation, graphTitle } from './graph-summary.ts'
import { parseAutomationSessionRef, isLearningAutomationRef } from '../cron/contracts.ts'

test('graph labels preserve short and empty titles and safely bound surrogate boundaries', () => {
  assert.equal(graphTitle(undefined), undefined)
  assert.equal(graphTitle(''), '')
  assert.equal(graphTitle('Explicit name'), 'Explicit name')
  assert.equal(graphTitle('a'.repeat(160)), 'a'.repeat(160))
  assert.equal(graphTitle('a'.repeat(158) + '😀tail'), 'a'.repeat(158) + '…')
  assert.equal(graphTitle('a'.repeat(157) + '😀tail'), 'a'.repeat(157) + '😀…')
})

test('graph association retains parser and learning classification compatibility for every source', () => {
  for (const source of ['cron', 'learning', 'system'] as const) {
    const original = { jobId: 'learning:encapsulator', name: 'Encapsulation', runId: 'opaque',
      startedAt: '2026-10-01T00:00:00Z', contextMode: 'fresh' as const, legacy: true,
      config: { source, schedule: 'every 2h', task: 'secret prompt'.repeat(10_000),
        organizationMode: 'full' as const, originSessionId: 'web:owner' } }
    const summary = graphAutomation(original)
    assert.deepEqual(parseAutomationSessionRef(summary), summary)
    assert.equal(isLearningAutomationRef(summary), source === 'learning')
    assert.equal(summary?.legacy, true)
    assert.ok(JSON.stringify(summary).length < JSON.stringify(original).length / 100)
    assert.equal(summary?.config?.task, undefined)
    assert.equal(summary?.config?.originSessionId, undefined)
  }
  assert.equal(graphAutomation(undefined), undefined)
})
