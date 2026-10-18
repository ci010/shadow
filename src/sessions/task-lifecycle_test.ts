import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createTaskLifecycle, transitionTaskLifecycle as transition, TaskLifecycleError,
  type TaskLifecycle, type TaskLifecycleAction,
} from './task-lifecycle.ts'

const create = () => createTaskLifecycle({ creatorSessionId: 'creator', workerSessionId: 'worker' })
function submitted(): TaskLifecycle {
  return transition(transition(create(), 'worker', { type: 'start_run', runId: 'run-1' }),
    'worker', { type: 'submit', runId: 'run-1', artifactRef: 'text:result' })
}
function denied(state: TaskLifecycle, actor: string, action: TaskLifecycleAction): void {
  const before = JSON.stringify(state)
  assert.throws(() => transition(state, actor, action), TaskLifecycleError)
  assert.equal(JSON.stringify(state), before)
}

test('submission is not closure; return, new run, resubmit and exact-revision acceptance', () => {
  const first = submitted()
  assert.equal(first.status, 'in_review')
  assert.equal(first.revision, 1)
  const returned = transition(first, 'creator', { type: 'request_changes', revision: 1 })
  assert.equal(returned.status, 'changes_requested')
  denied(returned, 'worker', { type: 'submit', runId: 'run-1', artifactRef: 'fix' })
  denied(returned, 'worker', { type: 'start_run', runId: 'run-1' })
  const working = transition(returned, 'worker', { type: 'start_run', runId: 'run-2' })
  const second = transition(working, 'worker', { type: 'submit', runId: 'run-2', artifactRef: 'file:fixed' })
  assert.equal(second.revision, 2)
  assert.equal(second.submissions.length, 2)
  denied(second, 'creator', { type: 'close', revision: 1 })
  denied(second, 'creator', { type: 'request_changes', revision: 1 })
  assert.equal(transition(second, 'creator', { type: 'close', revision: 2 }).status, 'closed')
})

test('creator-only grants and cancellation; review requires explicit current authority', () => {
  const state = submitted()
  for (const actor of ['worker', 'stranger', 'reviewer']) {
    denied(state, actor, { type: 'close', revision: 1 })
    denied(state, actor, { type: 'request_changes', revision: 1 })
    denied(state, actor, { type: 'cancel' })
    denied(state, actor, { type: 'set_reviewer', reviewerSessionId: actor })
  }
  const granted = transition(state, 'creator', { type: 'set_reviewer', reviewerSessionId: 'reviewer' })
  assert.equal(transition(granted, 'reviewer', { type: 'close', revision: 1 }).status, 'closed')
  assert.equal(transition(granted, 'reviewer', { type: 'request_changes', revision: 1 }).status, 'changes_requested')
  const revoked = transition(granted, 'creator', { type: 'set_reviewer', reviewerSessionId: null })
  assert.equal(revoked.reviewerSessionId, undefined)
  denied(revoked, 'reviewer', { type: 'close', revision: 1 })
  const replaced = transition(granted, 'creator', { type: 'set_reviewer', reviewerSessionId: 'replacement' })
  denied(replaced, 'reviewer', { type: 'close', revision: 1 })
  assert.equal(transition(replaced, 'replacement', { type: 'close', revision: 1 }).status, 'closed')
})

test('worker cannot review via reviewer grant; creator-worker retains creator authority', () => {
  const state = transition(submitted(), 'creator', { type: 'set_reviewer', reviewerSessionId: 'worker' })
  denied(state, 'worker', { type: 'close', revision: 1 })
  denied(state, 'worker', { type: 'request_changes', revision: 1 })
  let self = createTaskLifecycle({ creatorSessionId: 'same', workerSessionId: 'same', reviewerSessionId: 'same' })
  self = transition(self, 'same', { type: 'start_run', runId: 'self-run' })
  self = transition(self, 'same', { type: 'submit', runId: 'self-run', artifactRef: 'self-result' })
  assert.equal(transition(self, 'same', { type: 'close', revision: 1 }).status, 'closed')
})

test('worker-only execution and validation reject invalid transitions', () => {
  const state = create()
  for (const actor of ['creator', 'stranger']) {
    denied(state, actor, { type: 'start_run', runId: 'run' })
    denied(state, actor, { type: 'submit', runId: 'run', artifactRef: 'result' })
  }
  denied(state, 'worker', { type: 'submit', runId: 'run', artifactRef: 'result' })
  denied(state, 'worker', { type: 'start_run', runId: ' ' })
  denied(state, 'creator', { type: 'close', revision: 0 })
  denied(state, 'creator', { type: 'set_reviewer', reviewerSessionId: '' })
  const active = transition(state, 'worker', { type: 'start_run', runId: 'run' })
  denied(active, 'worker', { type: 'start_run', runId: 'other' })
  denied(active, 'worker', { type: 'submit', runId: 'wrong', artifactRef: 'result' })
  denied(active, 'worker', { type: 'submit', runId: 'run', artifactRef: '' })
  const review = submitted()
  denied(review, 'worker', { type: 'submit', runId: 'run-1', artifactRef: 'again' })
  denied(review, 'worker', { type: 'start_run', runId: 'other' })
  for (const revision of [0, 2, NaN, 1.5]) denied(review, 'creator', { type: 'close', revision })
  assert.throws(() => createTaskLifecycle({ creatorSessionId: '', workerSessionId: 'worker' }), TaskLifecycleError)
  assert.throws(() => createTaskLifecycle({ creatorSessionId: 'creator', workerSessionId: ' ' }), TaskLifecycleError)
  assert.throws(() => createTaskLifecycle({ creatorSessionId: 'creator', workerSessionId: 'worker', reviewerSessionId: '' }), TaskLifecycleError)
})

test('closed and cancelled are terminal for every action', () => {
  const state = submitted()
  const actions: TaskLifecycleAction[] = [
    { type: 'start_run', runId: 'new' }, { type: 'submit', runId: 'new', artifactRef: 'result' },
    { type: 'set_reviewer', reviewerSessionId: 'reviewer' }, { type: 'cancel' },
    { type: 'close', revision: 1 }, { type: 'request_changes', revision: 1 },
  ]
  for (const terminal of [transition(state, 'creator', { type: 'close', revision: 1 }),
    transition(state, 'creator', { type: 'cancel' })]) {
    for (const actor of ['creator', 'worker', 'reviewer']) {
      for (const action of actions) denied(terminal, actor, action)
    }
  }
  for (const source of [create(), state, transition(state, 'creator', { type: 'request_changes', revision: 1 })]) {
    assert.equal(transition(source, 'creator', { type: 'cancel' }).status, 'cancelled')
  }
})

test('JSON roundtrip and immutable transitions, including nested submissions', () => {
  const state = submitted()
  const snapshot = JSON.stringify(state)
  Object.freeze(state.submissions[0])
  Object.freeze(state.submissions)
  Object.freeze(state)
  const restored: TaskLifecycle = JSON.parse(snapshot)
  assert.deepEqual(restored, state)
  const action = { type: 'request_changes', revision: 1 } as const
  Object.freeze(action)
  const next = transition(state, 'creator', action)
  assert.equal(JSON.stringify(state), snapshot)
  assert.notEqual(next, state)
  assert.notEqual(next.submissions, state.submissions)
  assert.notEqual(next.submissions[0], state.submissions[0])
  assert.deepEqual(transition(restored, 'creator', action), next)
  assert.equal('executionStatus' in next, false)
})
