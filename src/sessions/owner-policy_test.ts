import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOwnerSession } from './owner-policy.ts'
import type { SessionState } from './session-store.ts'
test('owner session eligibility preserves non-default Project and legacy durable mode but rejects children and foreign actors', () => {
  const state: SessionState = {sessionId:'web:owner',projectId:'non-default',segmentIndex:0}
  assert.equal(isOwnerSession(state,'non-default'),true)
  assert.equal(isOwnerSession({...state,mode:'session'},'non-default'),true)
  for (const patch of [{projectId:'default'},{sessionId:'discord:owner'},{parentSessionId:'web:parent'},{mode:'task' as const},{mode:'call' as const}]) {
    assert.equal(isOwnerSession({...state,...patch},'non-default'),false)
  }
})
