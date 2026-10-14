import assert from 'node:assert/strict'
import test from 'node:test'
import { Bus } from '../bus/bus.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createProjectScope } from './scope.ts'
import { WorkOrganizer } from './work-organizer.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { WorkObserver, observationKey } from './work-observer.ts'

const summary = JSON.stringify({ track: true, title: 'Replace selectors', objective: 'Use consistent selectors', summary: 'Implementation underway', next: 'Verify behavior' })

test('observer progress preserves semantic revision and failed execution is visibly blocked', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0, executionStatus: 'running' }
  const titles: string[] = []
  let reportNumber = 0
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, updateTitle: async (id, title) => { assert.equal(id, state.sessionId); titles.push(title) }, summarize: async () =>
    JSON.stringify({ ...JSON.parse(summary), objective: `Report paraphrase ${++reportNumber}` }) })
  const report = (turnId: string, status: 'completed' | 'failed') => bus.emit('session.turn.finished', {
    sessionId: state.sessionId, turnId, inputId: turnId, source: { kind: 'session', sessionId: state.sessionId },
    status, content: status === 'failed' ? 'Build failed' : 'Progress report',
  })
  try {
    report('first', 'completed'); await observer.flush()
    report('second', 'completed'); await observer.flush()
    assert.equal(store.workRecords()[0]!.revision, 1)
    assert.equal(store.workRecords()[0]!.sequence, 2)
    assert.deepEqual(titles, ['Replace selectors', 'Replace selectors'])
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
    store.saveWork({ ...root, revision: root.revision + 1, sequence: root.sequence + 1, changedBy: 'human', definition: { ...root.definition, objective: 'Human goal' } }, root.sequence, 'human', 'note')
    bus.emit('session.turn.finished', { sessionId: 'virtual:child', turnId: 'child-report', inputId: 'child',
      source: { kind: 'session', sessionId: 'virtual:child' }, status: 'completed', content: 'Progress only' })
    await observer.flush()
    const reportedChild = store.workRecords().find(record => record.key === child.key)!
    assert.deepEqual(reportedChild.notes?.basis, child.notes?.basis, 'A report cannot acknowledge a changed human goal')
    assert.equal(reportedChild.definition.objective, child.definition.objective)
    assert.equal(calls, 3)
    request('third')
    await observer.flush()
    assert.equal(calls, 3)
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

test('new user instructions can change an observed goal; report paraphrases cannot', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-goal', projectId: 'fixture', segmentIndex: 0 }
  let objective = 'Original goal'
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async () =>
    JSON.stringify({ ...JSON.parse(summary), objective }) })
  const request = (id: string) => bus.emit('session.input.accepted', { sessionId: state.sessionId,
    input: { kind: 'message', id, timestamp: new Date().toISOString(), content: objective, policy: 'queue',
      source: { kind: 'user', sender: { channel: 'web', chatId: 'goal', senderId: 'user', messageId: id } } } })
  try {
    request('initial'); await observer.flush()
    objective = 'Changed user goal'; request('changed'); await observer.flush()
    assert.equal(store.workRecords()[0]!.revision, 2)
    assert.equal(store.workRecords()[0]!.definition.objective, objective)
    objective = 'Report paraphrase'
    bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId: 'report', inputId: 'changed',
      source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: objective })
    await observer.flush()
    assert.equal(store.workRecords()[0]!.revision, 2)
    assert.equal(store.workRecords()[0]!.definition.objective, 'Changed user goal')
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('observer produces only local facts, leaves project meaning to organizer and rejects invented legacy citations', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-focus', projectId: 'fixture', segmentIndex: 0 }
  let calls = 0, invented = false
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async input => {
    calls++
    const value = JSON.parse(input), event = value.events.at(-1)
    assert(value.instruction.includes('exclusively to the organizer'))
    assert.equal(value.recentProjectFocus, undefined)
    return JSON.stringify({ ...JSON.parse(summary), focus: { category: 'Consistent interaction',
      purpose: 'Make controls easier to use', motivation: 'The user may want predictable interaction',
      evidence: [{ id: invented ? 'invented' : event.id, physicalId: event.physicalId }] } })
  } })
  const request = (id: string) => bus.emit('session.input.accepted', { sessionId: state.sessionId,
    input: { kind: 'message', id, timestamp: new Date().toISOString(), content: 'Make controls consistent', policy: 'queue',
      source: { kind: 'user', sender: { channel: 'web', chatId: 'focus', senderId: 'user', messageId: id } } } })
  try {
    request('first'); await observer.flush()
    assert.equal(calls, 1)
    const saved = store.workRecords()[0]!
    assert.equal(saved.observation?.focus, undefined)
    assert.equal(saved.requestSource, undefined, 'Inferred motivation is never a user quote')
    await observer.flush(); assert.equal(calls, 1)
    invented = true; request('second'); await observer.flush()
    assert.equal(store.workRecords()[0]!.sequence, saved.sequence)
    assert.match(observer.status().errors[0]!.error, /outside the observed events/)
  } finally { await observer.stop(); store.close(); scope.close() }
}))


test('manual organization waits for automatic observation and queued cancellation does not cancel it', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0 }
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async () => {
    calls++
    await gate.promise
    return summary
  },organize:async(mode,signal)=>{
    calls++
    const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async()=>({sources:[],partial:true})})
    const ctx={sessionId:'fixture:organizer',physicalSessionId:'physical',projectId:'fixture',signal,tools:new SessionTools(new Tools(home),home)} as ExecutionContext
    const manifest=JSON.parse(organizer.begin(ctx.sessionId,mode,signal)).manifest as {key:string}[]
    try{
      for(const item of manifest)await organizer.read({key:item.key},ctx)
      await organizer.patch({patchId:mode,expectedRevision:store.projectFocus()?.revision??0,groups:[{id:'fixture-topic',category:'Fixture',purpose:'Fixture purpose',motivation:'Fixture inference',topicKeys:manifest.map(item=>item.key),cards:[]}],hierarchy:[{id:'fixture',title:'Fixture',purpose:'Fixture purpose',groupIds:['fixture-topic']}]},ctx)
      await organizer.finish({},ctx)
    }finally{organizer.end()}
  } })
  try {
    bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId: 'report', inputId: 'report',
      source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: 'Progress' })
    const automatic = observer.flush()
    const controller = new AbortController()
    const cancelled = observer.organize(controller.signal)
    await assert.rejects(observer.organize(new AbortController().signal), /already running/)
    controller.abort()
    await assert.rejects(cancelled)
    assert.equal(calls, 1)
    const queued = observer.organize(new AbortController().signal)
    assert.equal(calls, 1)
    gate.resolve()
    await automatic; await queued
    assert.equal(calls, 3, 'one source extraction, one event-driven delta, one queued full run')
    assert(store.projectFocus())
  } finally { gate.resolve(); await observer.stop(); store.close(); scope.close() }
}))


test('independent controls block manual and delta calls without historical backfill', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0 }
  let observed = 0, organized = 0
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async () => { observed++; return summary }, organize: async () => { organized++ } })
  const report = (turnId: string) => bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId, inputId: turnId, source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: 'Progress' })
  try {
    observer.update(true, false)
    await assert.rejects(observer.organize(new AbortController().signal), /disabled/)
    report('first'); await observer.flush()
    assert.equal(observed, 1); assert.equal(organized, 0)
    observer.update(false, true)
    report('ignored'); await observer.flush()
    assert.equal(observed, 1)
    await observer.organize(new AbortController().signal)
    assert.equal(organized, 1)
    observer.update(true, true); await observer.flush()
    assert.equal(observed, 1); assert.equal(organized, 1)
    report('new'); await observer.flush()
    assert.equal(observed, 2); assert.equal(organized, 2)
  } finally { await observer.stop(); store.close(); scope.close() }
}))


test('organizer disable aborts active and queued work, retaining committed output and independent observation', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0 }
  let releaseObservation!: () => void, observationStarted!: () => void
  const started = new Promise<void>(resolve => { observationStarted = resolve })
  const held = new Promise<void>(resolve => { releaseObservation = resolve })
  const committed: string[] = []
  let organizerStarted!: () => void
  const active = new Promise<void>(resolve => { organizerStarted = resolve })
  const observer = new WorkObserver(store, { bus, scope, state: () => state, changed() {}, summarize: async () => { observationStarted(); await held; return summary }, organize: async (_mode, signal) => {
    signal.throwIfAborted(); committed.push('saved patch'); organizerStarted()
    await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } })
  try {
    bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId: 'first', inputId: 'first', source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: 'Progress' })
    const flush = observer.flush(); await started
    const queued = observer.organize(new AbortController().signal)
    const rejected = assert.rejects(queued, /disabled/)
    observer.update(true, false); await rejected
    releaseObservation(); await flush
    assert.equal(store.workRecords().length, 1, 'organizer disable does not abort independent observation')
    assert.deepEqual(committed, [])
    observer.update(true, true)
    const manual = observer.organize(new AbortController().signal)
    const cancelled = assert.rejects(manual, /disabled/)
    await active; observer.update(true, false); await cancelled
    assert.deepEqual(committed, ['saved patch'], 'cancellation never rolls back an already committed patch')
    observer.update(true, true); await observer.flush()
    assert.deepEqual(committed, ['saved patch'], 're-enable does not retry')
  } finally { releaseObservation(); await observer.stop(); store.close(); scope.close() }
}))


test('disabled pending observation remains discarded after controller recreation', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const state: SessionState = { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0 }
  let calls = 0
  const deps = { bus, scope, state: () => state, changed() {}, summarize: async () => { calls++; return summary } }
  const first = new WorkObserver(store, deps)
  bus.emit('session.turn.finished', { sessionId: state.sessionId, turnId: 'old', inputId: 'old', source: { kind: 'session', sessionId: state.sessionId }, status: 'completed', content: 'Pending before disable' })
  first.update(false); await first.stop()
  const restored = new WorkObserver(store, deps)
  try { await restored.flush(); assert.equal(calls, 0); assert.equal(store.workObservations()[0]!.events.length, 1) }
  finally { await restored.stop(); store.close(); scope.close() }
}))


test('observer feeds only new identities plus original goal; child-only saves do not trigger organization', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), bus = new Bus(), scope = createProjectScope('fixture')
  const states: Record<string, SessionState> = {
    'web:chat-root': { sessionId: 'web:chat-root', projectId: 'fixture', segmentIndex: 0 },
    child: { sessionId: 'child', projectId: 'fixture', segmentIndex: 0, parentSessionId: 'web:chat-root' },
  }
  const inputs: any[] = []; let organized = 0
  const observer = new WorkObserver(store, { bus, scope, state: id => states[id], changed() {},
    summarize: async (input, _signal, options) => { assert.equal(options?.maxTokens, 2000); inputs.push(JSON.parse(input)); return summary },
    organize: async () => { organized++ } })
  const request = (id: string, sessionId = 'web:chat-root') => bus.emit('session.input.accepted', { sessionId,
    input: { kind: 'message', id, timestamp: new Date().toISOString(), content: id, policy: 'queue',
      source: sessionId === 'child' ? { kind: 'session', sessionId: 'web:chat-root' } : { kind: 'user', sender: { channel: 'web', chatId: 'root', senderId: 'user', messageId: id } } } })
  try {
    request('goal'); await observer.flush()
    request('correction'); await observer.flush()
    assert.deepEqual(inputs[1].events.map((event: any) => event.id), ['correction'])
    assert.equal(inputs[1].originalGoal.id, 'goal')
    assert.equal(inputs[1].previous.objective, 'Use consistent selectors')
    assert.equal(organized, 2)
    request('delegation', 'child'); await observer.flush()
    assert.equal(organized, 2)
    await observer.flush()
    assert.deepEqual(observer.status().metrics, { modelCalls: 3, newEvidenceCount: 3, overlapEvidenceCount: 1 })
    assert.equal(observer.status().coverage.staleCount, 1)
  } finally { await observer.stop(); store.close(); scope.close() }
}))
