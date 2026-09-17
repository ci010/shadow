import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseIoDefinition, type IoRun } from '../../src/io/contracts.ts'
import { placeIoRequests } from './io/conversation.ts'

const request = (id: string, createdAt: string, status: IoRun['status'] = 'awaiting_consent'): IoRun => ({
  version: 1, id, createdAt, status, projectId: 'default', sessionId: 'web:one', revision: 'a'.repeat(64),
  definition: parseIoDefinition({
    version: 1, title: 'A sound sample', purpose: 'Listen to a short sample', endpoint: 'ws://127.0.0.1:8765',
    sources: [{ id: 'mic', kind: 'microphone', mode: 'pcm' }], limits: { durationMs: 10_000, maxBytes: 8192 },
  }), bytes: 0, artifacts: [],
})
const messages = [
  { role: 'user', timestamp: '2026-01-01T00:00:00Z' },
  { role: 'assistant', event: 'tool_call', timestamp: '2026-01-01T00:00:01Z' },
  { role: 'assistant', timestamp: '2026-01-01T00:00:03Z' },
  { role: 'user', timestamp: '2026-01-01T00:00:04Z' },
  { role: 'assistant', timestamp: '2026-01-01T00:00:05Z' },
]
test('capture stays after the requesting assistant reply, before later conversation', () => {
  const run = request('one', '2026-01-01T00:00:02Z')
  assert.deepEqual(placeIoRequests([run], messages).after.get(2), [run])
  assert.deepEqual(placeIoRequests([run], messages.slice(0, 3)).after.get(2), [run])
  assert.deepEqual(placeIoRequests([run], messages.map(message => message.role === 'assistant' && !message.event ? { ...message, event: 'response' } : message)).after.get(2), [run])
})
test('a request arriving before its reply remains accessible at the live end', () => {
  const run = request('one', '2026-01-01T00:00:02Z')
  assert.deepEqual(placeIoRequests([run], messages.slice(0, 2)).after.get(1), [run])
  assert.deepEqual(placeIoRequests([run], []).after.get(-1), [run])
})
test('old results fold into earlier captures without hiding unresolved requests', () => {
  const done = request('done', '2025-01-01T00:00:00Z', 'completed')
  const pending = request('pending', '2025-01-01T00:00:00Z')
  const placed = placeIoRequests([done, pending], messages)
  assert.deepEqual(placed.earlier, [done])
  assert.deepEqual([...placed.after.values()].flat(), [pending])
})
