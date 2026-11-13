import assert from 'node:assert/strict'
import test from 'node:test'
import { dedicatedRunTitle } from './conversation-title.ts'
import type { AutomationSessionRef } from '../../src/cron/contracts.ts'

const association: AutomationSessionRef = { jobId: 'learning:encapsulator', name: 'Encapsulation', runId: 'batch', startedAt: '2026-11-13T00:00:00Z', contextMode: 'fresh' }
test('learning and fresh run headings use persisted names, independent of prompt and current catalog', () => {
  assert.equal(dedicatedRunTitle({ sessionId: 'opaque', automation: association }), 'Encapsulation')
  assert.equal(dedicatedRunTitle({ sessionId: 'opaque', automation: { ...association, jobId: 'cron:daily', name: 'Historical daily review' } }), 'Historical daily review')
})
test('ordinary, fixed-delivery, missing and malformed associations retain the ordinary title fallback', () => {
  assert.equal(dedicatedRunTitle(undefined), undefined)
  assert.equal(dedicatedRunTitle({ sessionId: 'cron:looks-like-a-run' }), undefined)
  assert.equal(dedicatedRunTitle({ sessionId: 'web:custom-title' }), undefined)
  assert.equal(dedicatedRunTitle({ sessionId: 'fixed', automation: { ...association, contextMode: 'existing' } as unknown as AutomationSessionRef }), undefined)
  assert.equal(dedicatedRunTitle({ sessionId: 'opaque', automation: { ...association, name: ' ' } }), undefined)
})
