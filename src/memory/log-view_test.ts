import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLogView } from './log-view.ts'

test('legacy memory resource kinds are projected as logs without changing immutable identity or content', () => {
  const stored = { kind: 'event' as const, id: 'legacy-id', version: 'legacy-version', title: 'Original event title', content: 'Original event details' }
  assert.deepEqual(memoryLogView(stored), { ...stored, kind: 'log' })
  assert.equal(stored.kind, 'event')
  assert.deepEqual(memoryLogView({ kind: 'decision' as const, id: 'decision' }), { kind: 'decision', id: 'decision' })
})
