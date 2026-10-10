import assert from 'node:assert/strict'
import test from 'node:test'
import { Bus } from '../bus/bus.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createProjectScope } from './scope.ts'
import { WorkObserver, observationKey } from './work-observer.ts'

const summary = JSON.stringify({ track: true, title: 'Replace selectors', objective: 'Use consistent selectors', summary: 'Implementation underway', next: 'Verify behavior' })

test('observer progress preserves semantic revision and failed execution is visibly blocked', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0, executionStatus: 'running' }
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async () => summary })
  const report = (turnId: string, status: 'completed' | 'failed') => bus.emit('session.turn.finished', {
    sessionId: state.sessionId, turnId, inputId: turnId, source: { kind: 'session', sessionId: state.sessionId },
    status, content: status === 'failed' ? 'Build failed' : 'Progress report',
  })
  try {
    report('first', 'completed'); await observer.flush()
    report('second', 'completed'); await observer.flush()
    assert.equal(store.workRecords()[0]!.revision, 1)
    assert.equal(store.workRecords()[0]!.sequence, 2)
    state.executionStatus = 'failed'
    report('third', 'failed'); await observer.flush()
    assert.equal(store.workRecords()[0]!.workflow?.status, 'blocked')
    assert.match(store.workRecords()[0]!.workflow?.blockedReason ?? '', /Build failed/)
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('observation ledger evicts only processed evidence and preserves pending evidence at its bound', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home)
  const entry = (sessionId: string, processed = 0) => ({
    sessionId, version: 1, processed,
    events: [{ id: sessionId, physicalId: sessionId, kind: 'request' as const, text: 'Goal', at: '2026-10-01T00:00:00Z' }],
  })
  try {
    for (let i = 0; i < 200; i++) store.saveWorkObservation(entry(`web:chat-${i}`))
    assert.throws(() => store.saveWorkObservation(entry('web:chat-new')), /200 pending/)
    store.saveWorkObservation(entry('web:chat-0', 1))
    store.saveWorkObservation(entry('web:chat-new'))
    assert.equal(store.workObservations().length, 200)
    assert(!store.workObservations().some(value => value.sessionId === 'web:chat-0'))
    assert(store.workObservations().some(value => value.sessionId === 'web:chat-1'))
  } finally { store.close() }
}))

test('observer coalesces evidence, persists notes without assigning work, and protects manual edits', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const states: Record<string, SessionState> = {
    'web:chat-root': { sessionId: 'web:chat-root', mode: 'session', projectId: 'fixture', segmentIndex: 0, executionStatus: 'running' },
    'virtual:child': { sessionId: 'virtual:child', mode: 'task', projectId: 'fixture', segmentIndex: 0, parentSessionId: 'web:chat-root', executionStatus: 'running' },
  }
  let calls = 0
  const observer = new WorkObserver(store, { bus, scope, state: id => states[id], changed() {},
    summarize: async () => { calls++; return summary } })
  const request = (id: string, sessionId = 'web:chat-root') => bus.emit('session.input.accepted', {
    sessionId, input: { kind: 'message', id, timestamp: new Date().toISOString(), policy: 'queue', content: 'Replace the selector UI',
      source: sessionId === 'web:chat-root' ? { kind: 'user', sender: { channel: 'web', chatId: 'root', senderId: 'user', messageId: id } }
        : { kind: 'session', sessionId: 'web:chat-root' } },
  })
  try {
    request('first'); request('second'); request('child', 'virtual:child')
    await observer.flush()
    assert.equal(calls, 2)
    const root = store.workRecords().find(record => record.key === observationKey('web:chat-root'))!
    const child = store.workRecords().find(record => record.key === observationKey('virtual:child'))!
    assert.equal(root.workflow?.assignee, null)
    assert.equal(root.workflow?.manager, null)
    assert.equal(root.origin, 'agent_interpretation')
    assert.equal(child.workflow?.parentKey, root.key)
    assert.equal(root.observation?.sources.length, 2)
    assert.equal(root.requestSource, undefined)
    assert.equal(store.workFocus('web:chat-root'), undefined)
    await observer.flush()
    assert.equal(calls, 2, 'unchanged evidence costs no new inference')
    store.saveWork({ ...root, sequence: root.sequence + 1, changedBy: 'human', definition: { ...root.definition, objective: 'Human goal' } }, root.sequence, 'human', 'note')
    request('third')
    await observer.flush()
    assert.equal(calls, 2)
    assert.equal(store.workRecords().find(record => record.key === root.key)?.definition.objective, 'Human goal')
    assert.match(observer.status().errors[0]!.error, /paused/)
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('observer recovers pending evidence, rejects stale inference and surfaces errors without replay loops', async () => withTempWorkspace(async home => {
  let store = new InitiativeStore(home)
  const bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', mode: 'session', projectId: 'fixture', segmentIndex: 0 }
  const deps = { bus, scope, state: () => state, changed() {}, summarize: async () => summary }
  let observer = new WorkObserver(store, deps)
  const request = (id: string) => bus.emit('session.input.accepted', { sessionId: state.sessionId,
    input: { kind: 'message', id, timestamp: new Date().toISOString(), content: id, policy: 'queue',
      source: { kind: 'user', sender: { channel: 'web', chatId: 'root', senderId: 'user', messageId: id } } } })
  request('first')
  await observer.stop(); store.close()
  store = new InitiativeStore(home)
  let runs = 0
  const gate = Promise.withResolvers<string>()
  observer = new WorkObserver(store, { ...deps, summarize: async () => { runs++; return runs === 1 ? gate.promise : '{invalid' } })
  try {
    assert.equal(observer.status().pending, 1)
    const running = observer.flush()
    request('newer goal')
    gate.resolve(summary)
    await running
    assert.equal(store.workRecords().length, 0, 'a late model result cannot overwrite new evidence')
    await observer.flush()
    assert.equal(observer.status().errors.length, 1)
    await observer.flush()
    assert.equal(runs, 2, 'failed versions are not retried indefinitely')
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('observer ignores other projects, managed channels, automation and its own sessions', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const states: SessionState[] = [
    { sessionId: 'web:chat-foreign', projectId: 'other', segmentIndex: 0 },
    { sessionId: 'work-observer:run', projectId: 'fixture', agentType: 'work-observer', segmentIndex: 0 },
    { sessionId: 'discord:channel', projectId: 'fixture', segmentIndex: 0 },
  ]
  let runs = 0
  const observer = new WorkObserver(store, { bus, scope, state: id => states.find(state => state.sessionId === id), changed() {},
    summarize: async () => { runs++; return summary } })
  try {
    for (const state of states) bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId: 'turn', inputId: 'input',
      source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: 'Private evidence' })
    await observer.flush()
    assert.equal(runs, 0)
    assert.equal(store.workObservations().length, 0)
  } finally { await observer.stop(); store.close(); scope.close() }
}))
