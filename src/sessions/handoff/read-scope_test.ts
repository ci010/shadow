import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortPhysicalReference } from '../history-view.ts'
import { physicalSessionId } from '../session-identity.ts'
import type { SessionState } from '../session-store.ts'
import { scopeCompactRead } from './read-scope.ts'

const state: SessionState = { sessionId: 'web:compact-own', physicalIdVersion: 2, segmentIndex: 2 }
const ownPrevious = physicalSessionId(state, 1)
const foreign = physicalSessionId({ ...state, sessionId: 'web:foreign' }, 1)

test('Compact lists only its own segments and pages exact history references', () => {
  const own = scopeCompactRead({ path: 'v:sessions', offset: 2, limit: 1 }, state, false)
  assert.ok('index' in own)
  assert.match(own.index, new RegExp(ownPrevious))
  assert.ok(!own.index.includes(physicalSessionId(state, 0)))
  assert.match(own.index, /offset=3/)
  assert.deepEqual(scopeCompactRead({ path: `v:sessions/${shortPhysicalReference(ownPrevious)}/c/4.1`, offset: 2, limit: 3 }, state, false), {
    args: { path: `v:sessions/${ownPrevious}/c/4.1`, offset: 2, limit: 3 }, virtual: true,
  })
  assert.deepEqual(scopeCompactRead({ path: 'v:sessions/current' }, state, false), {
    args: { path: `v:sessions/${physicalSessionId(state)}` }, virtual: true,
  })
})

test('Compact refuses other histories, private maintenance aliases and network reads', () => {
  for (const path of ['v:sessions/web:foreign', `v:sessions/${foreign}`, `v:sessions/${shortPhysicalReference(foreign)}`,
    'v:sessions/all', 'v:sessions/remote:other', 'v:sessions/self.json', 'v:sessions/current/../all',
    'V:SESSIONS\\web:foreign', '/v:sessions/web:foreign', 'C:\\work\\v:sessions\\web:foreign',
    'https://example.test/evidence', '\\\\server\\share\\file', 'v:handoff/other.md']) {
    assert.throws(() => scopeCompactRead({ path }, state, false), Error, path)
  }
  for (const [path, virtual] of [['v:memory', true], ['notes.md', false], ['C:\\work\\notes.md', false]] as const) {
    assert.deepEqual(scopeCompactRead({ path, limit: 8 }, state, false), { args: { path, limit: 8 }, virtual })
  }
})

test('Scoped Compact delegates only its authorized current history view', () => {
  assert.deepEqual(scopeCompactRead({ path: 'v:sessions' }, state, true), { index: 'This conversation: v:sessions/current' })
  assert.deepEqual(scopeCompactRead({ path: 'v:sessions/current' }, state, true), { args: { path: 'v:sessions/current' }, virtual: true })
  for (const path of [`v:sessions/${ownPrevious}`, `v:sessions/${state.sessionId}`, 'v:sessions/current/full']) {
    assert.throws(() => scopeCompactRead({ path }, state, true), /only read this session/)
  }
})
