import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRealtimeEnvelope, parseRealtimeTopics } from './protocol.ts'

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

test('unavailable topics are explicit and bounded rather than successful readiness', () => {
  const envelope = { type: 'unavailable', cursor: 'epoch:0', topics: [{ kind: 'sessions', projectId: 'failed' }] }
  assert(isRealtimeEnvelope(envelope))
  for (const topics of [null, {}, [{ kind: 'sessions' }], Array(129).fill(envelope.topics[0])]) {
    assert.equal(isRealtimeEnvelope({ ...envelope, topics }), false)
  }
  assert(isRealtimeEnvelope({ type: 'reset', reason: 'project-restored', cursor: 'epoch:0' }))
})
