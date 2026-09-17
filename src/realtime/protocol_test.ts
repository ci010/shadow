import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRealtimeTopics } from './protocol.ts'

test('realtime subscriptions deduplicate topics and require valid Project ownership without unknown fields', () => {
  assert.deepEqual(parseRealtimeTopics(JSON.stringify([
    { kind: 'sessions', projectId: 'owner' },
    { kind: 'chat', projectId: 'owner', sessionId: 'web:chat' },
    { kind: 'sessions', projectId: 'owner' },
  ])), [
    { kind: 'sessions', projectId: 'owner' },
    { kind: 'chat', projectId: 'owner', sessionId: 'web:chat' },
  ])
  for (const topic of [
    { kind: 'sessions' },
    { kind: 'sessions', projectId: '' },
    { kind: 'sessions', projectId: 'owner', unknown: 'value' },
  ]) {
    assert.throws(() => parseRealtimeTopics(JSON.stringify([topic])), /Invalid realtime topics/)
  }
})
