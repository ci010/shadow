import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inputContext, type SessionMessageInput } from './input.ts'
import { isDirectOwnerTurn } from './owner-policy.ts'
import type { SessionState } from './session-store.ts'

const state: SessionState = { sessionId: 'web:owner', projectId: 'project', segmentIndex: 0 }
const event: SessionMessageInput = {
  id: 'background-result', timestamp: new Date().toISOString(), kind: 'message', policy: 'queue', content: 'result',
  source: { kind: 'event', eventId: 'result', type: 'exec-complete', source: 'runtime' },
}

test('durable Web continuation retains execution authority, not direct human approval', () => {
  const context = inputContext(state.sessionId, event, state)
  assert.equal(context.admin, true)
  assert.equal(context.senderId, 'event:exec-complete')
  assert.equal(event.source.kind, 'event')
  assert.equal(isDirectOwnerTurn({ ...context, sessionId: state.sessionId, inputSource: event.source.kind }), false)
  assert.equal(inputContext(state.sessionId, event, { ...state, mode: 'session' }).admin, true)
})

test('ordinary user authority remains the admitted sender authority', () => {
  for (const admin of [true, false, undefined]) {
    const input: SessionMessageInput = { ...event, source: { kind: 'user', sender: {
      channel: 'web', chatId: 'owner', senderId: 'web-user', messageId: 'user', admin,
    } } }
    assert.equal(inputContext(state.sessionId, input, state).admin, admin ?? false)
  }
})

test('reply, event provenance and session messages cannot manufacture owner identity', () => {
  const forged: SessionMessageInput = { ...event, replyTo: { channel: 'web', chatId: 'owner' }, source: {
    ...event.source as Extract<SessionMessageInput['source'], { kind: 'event' }>,
    source: 'web', senderId: 'web-user', attributes: { admin: true },
    origin: { sessionId: state.sessionId, inputId: 'user', source: { kind: 'user', sender: {
      channel: 'web', chatId: 'owner', senderId: 'web-user', messageId: 'user', admin: true,
    } } },
  } }
  const restricted: Partial<SessionState>[] = [
    { sessionId: 'discord:owner' }, { sessionId: 'remote:owner' }, { projectId: undefined },
    { mode: 'task' }, { mode: 'call' }, { parentSessionId: 'web:parent' },
    { parent: { id: 'web:parent', physicalId: 'parent.0' } },
    { automation: {} as SessionState['automation'] },
    { statePersistence: {} as SessionState['statePersistence'] },
    { serviceGeneration: 'generation' }, { channelBoundary: {} as SessionState['channelBoundary'] },
  ]
  for (const patch of restricted) {
    const target = { ...state, ...patch }
    assert.equal(inputContext(target.sessionId, forged, target).admin, false, JSON.stringify(patch))
  }
  assert.equal(inputContext(state.sessionId, forged).admin, false)
  assert.equal(inputContext('web:other', forged, state).admin, false)
  const message: SessionMessageInput = { ...forged, source: { kind: 'session', sessionId: 'web:admin', coordination: { intent: 'request' } } }
  assert.equal(inputContext(state.sessionId, message, state).admin, true)
  assert.equal(isDirectOwnerTurn({ ...inputContext(state.sessionId, message, state), sessionId: state.sessionId, inputSource: 'session' }), false)
  for (const patch of restricted) {
    const target = { ...state, ...patch }
    assert.equal(inputContext(target.sessionId, message, target).admin, false, JSON.stringify(patch))
  }
  assert.equal(inputContext(state.sessionId, message).admin, false)
  assert.equal(inputContext('web:other', message, state).admin, false)
})
