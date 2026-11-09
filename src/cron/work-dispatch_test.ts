import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { InitiativeStore, automaticWorkEligible } from '../initiatives/store.ts'
import { workKey, type WorkRecord } from '../initiatives/work-contract.ts'
import { workNotesSchema } from '../initiatives/work-notes.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { SessionInput } from '../sessions/input.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkDispatcher, type WorkDispatcherDeps } from './work-dispatch.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'
import type { CronJob } from './service.ts'

const abort = () => new AbortController().signal
const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'source' })
const job: CronJob = { ...WORK_DISPATCH_AUTOMATION, program: config, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString(), enabled: true }
function fixture(home: string, projectId = 'a') {
  const states = new Map<string, SessionState>(), active = new Set<string>(), waiting = new Map<string, unknown>()
  const store = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  const delivered: Array<{ id: string; input: SessionInput }> = []
  let creates = 0, prepares = 0, changed = 0, preparationFails = false, deliveryFails = false, targetFails = false, replay = false
  const sessions = {
    setAutomaticWorkAdmission: () => {},
    getSessionState: (id: string) => states.get(id) ?? null,
    isSessionBusy: (id: string) => active.has(id) || waiting.has(id),
    buildSession: async (id: string, _parent: unknown, fields: Partial<SessionState>) => {
      assert.ok(!states.has(id)); creates++; states.set(id, { sessionId: id, projectId, segmentIndex: 0, ...fields })
    },
    deliver: async (id: string, input: SessionInput) => {
      delivered.push({ id, input })
      if (deliveryFails) throw new Error('admission transport failure')
      active.add(id)
      return { status: 'accepted' as const, sessionId: id, inputId: input.id }
    },
    inputs: { get: (id: string) => waiting.get(id) }, yields: { get: () => undefined }, isWaitingForCall: () => false, isWaitingForExternalExecution: () => false,
    getSessionRecovery: () => replay ? { id: 'recovery', pendingToolCalls: 1 } : undefined,
    resumeSession: async (id: string, _recovery: string, acknowledged: boolean) => { assert.equal(acknowledged, true); active.add(id) },
    bindAutomaticWorkWorkspace: async (id: string, folderId: string) => { states.get(id)!.folderId = folderId },
  } as unknown as WorkDispatcherDeps['sessions']
  const deps: WorkDispatcherDeps = { projectId, store, sessions,
    validateTarget: async value => { if (!value.folderId || targetFails) throw new Error('Workspace unavailable/remote') },
    prepare: async () => { prepares++; if (preparationFails) throw new Error('worktree unavailable'); return { folderId: 'isolated', branch: 'shadow/test', path: '/synthetic/isolated' } },
    verify: async () => {},
    changed: async () => { changed++ },
  }
  const dispatcher = new WorkDispatcher(deps)
  const create = (overrides: Partial<NonNullable<WorkRecord['workflow']>> = {}) => {
    const subject = { kind: 'work' as const, id: randomUUID() }
    const work: WorkRecord = { subject, key: workKey(subject), revision: 1, sequence: 1,
      definition: { objective: 'Deliver fixture', acceptance: [], boundaries: [], evidence: [] }, origin: 'human', changedBy: 'user',
      changedAt: new Date().toISOString(), change: 'goal', reason: 'Synthetic fixture', paused: false, notes: workNotesSchema.parse({}),
      workflow: { title: 'Fixture', manager: null, assignee: null, assignmentRevision: 1, status: 'pending', dependencies: [], ...overrides } }
    store.saveWork(work, 0, 'user', 'created')
    return work
  }
  const get = (work: WorkRecord) => store.workRecords().find(item => item.key === work.key)!
  return { store, states, active, waiting, dispatcher, deps, create, get, delivered,
    counts: () => ({ creates, prepares, changed }), failPreparation: (v = true) => { preparationFails = v },
    failDelivery: (v = true) => { deliveryFails = v }, failTarget: () => { targetFails = true }, replay: () => { replay = true } }
}

test('idle program scans do not create or deliver sessions; invalid target fails before claim', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    await f.dispatcher.dispatch(job, abort())
    assert.deepEqual(f.counts(), { creates: 0, prepares: 0, changed: 0 })
    assert.deepEqual(f.delivered, [])
    const work = f.create(); f.failTarget()
    await assert.rejects(f.dispatcher.dispatch(job, abort()), /Workspace unavailable/)
    assert.equal(f.get(work).workflow?.assignee, null)
    assert.equal(f.counts().creates, 0)
  } finally { f.store.close() }
}))

test('bounded admission, claim competition, durable same-assignee restart, and unknown delivery never replay', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const first = f.create(), second = f.create()
    await Promise.all([f.dispatcher.dispatch(job, abort()), f.dispatcher.dispatch(job, abort())])
    const assigned = f.store.workRecords().find(record => record.workflow?.assignee)!
    const remaining = assigned.key === first.key ? second : first
    assert.equal(f.get(remaining).workflow?.assignee, null)
    assert.equal(f.delivered.length, 1)
    const id = assigned.workflow!.assignee!
    assert.equal(f.states.get(id)?.folderId, 'isolated')
    assert.equal(f.states.get(id)?.automaticWork?.limits.inferenceRequests, 100)
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.counts().creates, 1)
    const stale = { ...first, sequence: 2, workflow: { ...first.workflow!, assignee: 'racer', assignmentRevision: 2 }, automaticExecution: assigned.automaticExecution }
    assert.throws(() => f.store.claimAutomaticWork(stale, 1), /changed|assignee/)
    f.active.clear()
    const restarted = new WorkDispatcher(f.deps)
    await restarted.recover()
    assert.equal(f.get(assigned).workflow?.status, 'blocked')
    assert.equal(f.get(assigned).workflow?.assignee, id)
    assert.equal(f.delivered.length, 1)
    // Blocked work is not claimable, even if a future tick picks up another item.
    assert.equal(automaticWorkEligible(f.get(assigned), f.store.workRecords()), false)
    f.failDelivery()
    await restarted.dispatch(job, abort())
    const failure = f.get(remaining)
    assert.equal(failure.workflow?.status, 'blocked')
    assert.match(failure.workflow!.blockedReason!, /unknown outcome/)
    const delivered = f.delivered.length
    await restarted.dispatch(job, abort())
    assert.equal(f.delivered.length, delivered)
    assert.equal(f.get(remaining).workflow?.assignee, failure.workflow?.assignee)
  } finally { f.store.close() }
}))

test('eligibility excludes paused/terminal/assigned work and reuses dependency/ancestor checks', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const root = f.create(), dependent = f.create({ dependencies: [root.key] })
    assert.equal(automaticWorkEligible(dependent, f.store.workRecords()), false)
    for (const status of ['done', 'cancelled'] as const) {
      const record = { ...root, workflow: { ...root.workflow!, status } }
      assert.equal(automaticWorkEligible(record, [record]), false)
    }
    assert.equal(automaticWorkEligible({ ...root, paused: true }, [root]), false)
    assert.equal(automaticWorkEligible({ ...root, workflow: { ...root.workflow!, assignee: 'someone' } }, [root]), false)
    const child = { ...dependent, workflow: { ...dependent.workflow!, dependencies: [], parentKey: root.key } }
    assert.equal(automaticWorkEligible(child, [{ ...root, paused: true }, child]), false)
    const done = { ...root, workflow: { ...root.workflow!, status: 'done' as const } }
    assert.equal(automaticWorkEligible(dependent, [done, dependent]), true)
  } finally { f.store.close() }
}))

test('isolation failure keeps responsibility blocked without admission, then explicit recovery binds same executor', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const work = f.create(); f.failPreparation()
    await f.dispatcher.dispatch(job, abort())
    let blocked = f.get(work)
    const id = blocked.workflow!.assignee!
    assert.equal(blocked.workflow?.status, 'blocked')
    assert.equal(f.delivered.length, 0)
    assert.equal(f.states.get(id)?.folderId, undefined)
    assert.match(blocked.notes!.attention!.summary, /Isolation preparation failed/)
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.counts().creates, 1)
    f.failPreparation(false)
    await assert.rejects(f.dispatcher.resume(work.key, 1, abort()), /current/)
    await f.dispatcher.resume(work.key, blocked.sequence, abort())
    blocked = f.get(work)
    assert.equal(blocked.workflow?.assignee, id)
    assert.equal(f.states.get(id)?.folderId, 'isolated')
    assert.equal(f.counts().creates, 1)
    assert.equal(f.delivered.length, 1)
    assert.equal(blocked.automaticExecution?.stage, 'running')
  } finally { f.store.close() }
}))

test('normal waits are not failures; abnormal budget/cancel/end states block without false done, and replay needs human acknowledgement', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const work = f.create()
    await f.dispatcher.dispatch(job, abort())
    let record = f.get(work), id = record.workflow!.assignee!
    const fact = { sessionId: id, turnId: 'turn', inputId: 'input', source: { kind: 'event' as const, eventId: 'event', type: 'test', source: 'test' }, status: 'failed' as const, content: '', error: 'Session turn exceeded the maximum number of iterations' }
    f.active.clear(); f.waiting.set(id, {})
    await f.dispatcher.finished(fact)
    assert.equal(f.get(work).workflow?.status, 'pending')
    await new WorkDispatcher(f.deps).recover()
    assert.equal(f.get(work).workflow?.status, 'pending')
    f.waiting.clear()
    f.deps.sessions.isWaitingForExternalExecution = () => true
    await f.dispatcher.finished(fact)
    assert.equal(f.get(work).workflow?.status, 'pending')
    f.deps.sessions.isWaitingForExternalExecution = () => false
    await f.dispatcher.finished(fact)
    record = f.get(work)
    assert.equal(record.workflow?.status, 'blocked')
    assert.match(record.workflow!.blockedReason!, /maximum number/)
    assert.equal(record.workflow?.assignee, id)
    f.replay()
    await assert.rejects(f.dispatcher.resume(work.key, record.sequence, abort()), /acknowledgeToolReplay/)
    await f.dispatcher.resume(work.key, record.sequence, abort(), true)
    f.active.clear()
    await f.dispatcher.finished({ ...fact, status: 'cancelled', error: 'explicit stop' })
    assert.equal(f.get(work).workflow?.status, 'blocked')
    await f.dispatcher.resume(work.key, f.get(work).sequence, abort(), true)
    f.active.clear()
    await f.dispatcher.finished({ ...fact, status: 'completed', error: undefined })
    assert.equal(f.get(work).workflow?.status, 'blocked')
    assert.match(f.get(work).workflow!.blockedReason!, /without recording/)
    record = f.get(work)
    f.store.saveWork({ ...record, sequence: record.sequence + 1, workflow: { ...record.workflow!, status: 'cancelled', blockedReason: undefined, blockedScope: undefined } }, record.sequence, 'user', 'cancelled')
    await f.dispatcher.finished(fact)
    assert.equal(f.get(work).workflow?.status, 'cancelled')
  } finally { f.store.close() }
}))

test('Project-local stores do not claim each other, and stable identities are scoped by Project', async () => withTempWorkspace(async home => {
  const a = fixture(home + '/a', 'a'), b = fixture(home + '/b', 'b')
  try {
    const work = a.create()
    await b.dispatcher.dispatch(job, abort())
    assert.equal(a.get(work).workflow?.assignee, null)
    assert.equal(b.counts().creates, 0)
    await a.dispatcher.dispatch(job, abort())
    assert.equal(a.delivered.length, 1)
    assert.equal(b.delivered.length, 0)
  } finally { a.store.close(); b.store.close() }
}))

test('recovery and scanning share capacity; identity tampering fails before a new admission', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const first = f.create()
    await f.dispatcher.dispatch(job, abort())
    f.active.clear()
    await f.dispatcher.recover()
    const blocked = f.get(first)
    f.create()
    await f.dispatcher.dispatch(job, abort())
    await assert.rejects(f.dispatcher.resume(first.key, blocked.sequence, abort()), /capacity is occupied/)
    assert.equal(f.counts().creates, 2)
    f.active.clear()
    await f.dispatcher.recover()
    const before = f.delivered.length
    f.deps.verify = async () => { throw new Error('branch or git common-dir changed') }
    await assert.rejects(f.dispatcher.resume(first.key, f.get(first).sequence, abort()), /common-dir changed/)
    assert.equal(f.delivered.length, before)
    assert.equal(f.get(first).workflow?.status, 'blocked')
    assert.equal(f.get(first).workflow?.assignee, blocked.workflow?.assignee)
  } finally { f.store.close() }
}))

test('host blocker always notifies publisher despite older unresolved attention, with deterministic notification identity', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    f.states.set('publisher', { sessionId: 'publisher', projectId: 'a', segmentIndex: 0, mode: 'session' })
    const work = f.create({ manager: 'publisher' })
    const old = f.get(work)
    f.store.saveWork({ ...old, sequence: 2, notes: { ...old.notes!, attention: { kind: 'dependency', summary: 'Old unresolved attention', at: new Date().toISOString(), by: 'publisher', version: 2 } } }, 1, 'user', 'note')
    await f.dispatcher.dispatch(job, abort())
    f.active.clear()
    await f.dispatcher.recover()
    const notification = f.delivered.find(item => item.id === 'publisher')!
    assert.ok(notification)
    assert.match(notification.input.id, /^work-blocked:/)
    assert.match(notification.input.kind === 'message' ? notification.input.content : '', /needs publisher help/)
    const length = f.delivered.length
    await f.dispatcher.recover()
    assert.equal(f.delivered.length, length)
  } finally { f.store.close() }
}))

test('unassigned blocked Work is claimed once for clarification without silently clearing the blocker', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const work = f.create({ status: 'blocked', blockedReason: 'Publisher must supply the missing input', blockedScope: 'work' })
    assert.equal(automaticWorkEligible(work, f.store.workRecords()), true)
    await f.dispatcher.dispatch(job, abort())
    const claimed = f.get(work), id = claimed.workflow!.assignee!
    assert.ok(id)
    assert.equal(claimed.workflow?.status, 'blocked')
    assert.equal(claimed.workflow?.blockedReason, work.workflow?.blockedReason)
    assert.equal(f.delivered.length, 1)
    assert.match(f.delivered[0].input.kind === 'message' ? f.delivered[0].input.content : '', /blocker clarification/)
    f.active.clear()
    await f.dispatcher.finished({ sessionId: id, turnId: 'clarification', inputId: 'input', status: 'completed', content: 'Requested missing input',
      source: { kind: 'event', type: 'test', source: 'test', eventId: 'test' } })
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.delivered.length, 1)
    assert.equal(f.get(work).workflow?.assignee, id)
    assert.equal(f.get(work).workflow?.status, 'blocked')
  } finally { f.store.close() }
}))

test('two SQLite claimants see one atomic winner and retain the same persisted executor after reopening', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  let competing: InitiativeStore | undefined
  try {
    const original = f.create()
    competing = new InitiativeStore(home, { isSessionKnown: () => true })
    const competingSnapshot = competing.workRecords().find(item => item.key === original.key)!
    await f.dispatcher.dispatch(job, abort())
    const winner = f.get(original)
    const loser: WorkRecord = { ...competingSnapshot, sequence: competingSnapshot.sequence + 1,
      workflow: { ...competingSnapshot.workflow!, assignee: 'racing-session', assignmentRevision: 2 },
      automaticExecution: { ...winner.automaticExecution!, sessionId: 'racing-session' } }
    assert.throws(() => competing!.claimAutomaticWork(loser, competingSnapshot.sequence), /changed/)
    assert.equal(competing.workRecords()[0].workflow?.assignee, winner.workflow?.assignee)
    assert.equal(competing.workRecords()[0].automaticExecution?.inputId, winner.automaticExecution?.inputId)
    assert.equal(f.delivered.length, 1)
  } finally { competing?.close(); f.store.close() }
}))

test('post-barrier cancellation/pause cannot start inference, and terminal claimed receipts do not starve pending Work', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const first = f.create()
    let mutated = false
    f.deps.changed = async record => {
      if (record.key === first.key && record.automaticExecution?.stage === 'delivering' && !mutated) {
        mutated = true
        const current = f.get(first)
        f.store.saveWork({ ...current, sequence: current.sequence + 1, workflow: { ...current.workflow!, status: 'cancelled' } }, current.sequence, 'user', 'cancelled')
      }
    }
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.delivered.length, 0)
    assert.equal(f.get(first).workflow?.status, 'cancelled')
    // Reproduce a terminal record left specifically at claimed, then recover it.
    let current = f.get(first)
    f.store.saveWork({ ...current, sequence: current.sequence + 1, automaticExecution: { ...current.automaticExecution!, stage: 'claimed' } }, current.sequence, 'user', 'fixture_receipt')
    const second = f.create()
    f.deps.changed = async record => {
      if (record.key === second.key && record.automaticExecution?.stage === 'delivering') {
        const value = f.get(second)
        f.store.saveWork({ ...value, sequence: value.sequence + 1, paused: true }, value.sequence, 'user', 'paused')
      }
    }
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.get(first).automaticExecution?.stage, 'settled')
    assert.equal(f.delivered.length, 0)
    assert.equal(f.get(second).paused, true)
    f.deps.changed = async () => {}
    const third = f.create()
    await f.dispatcher.dispatch(job, abort())
    assert.equal(f.delivered.length, 1)
    assert.ok(f.get(third).workflow?.assignee)
  } finally { f.store.close() }
}))

test('publisher help survives a crash after blocker save and transport failures have a persisted finite retry ceiling', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    f.states.set('publisher', { sessionId: 'publisher', projectId: 'a', segmentIndex: 0, mode: 'session' })
    const work = f.create({ manager: 'publisher' })
    f.failPreparation()
    f.deps.changed = async record => { if (record.automaticExecution?.stage === 'blocked') throw new Error('simulated crash after durable blocker save') }
    await assert.rejects(f.dispatcher.dispatch(job, abort()), /simulated crash/)
    const blocked = f.get(work), id = blocked.workflow!.assignee
    assert.equal(blocked.automaticExecution?.help?.attempts, 0)
    assert.equal(blocked.automaticExecution?.help?.delivered, false)
    f.deps.changed = async () => {}; f.failDelivery()
    const restarted = new WorkDispatcher(f.deps)
    await restarted.recover(); await restarted.recover(); await restarted.recover(); await restarted.recover()
    assert.equal(f.get(work).automaticExecution?.help?.attempts, 3)
    assert.equal(f.get(work).automaticExecution?.help?.delivered, false)
    assert.match(f.get(work).automaticExecution!.help!.lastError!, /transport failure/)
    assert.equal(f.delivered.length, 3)
    assert.equal(new Set(f.delivered.map(item => item.input.id)).size, 1)
    assert.equal(f.get(work).workflow?.assignee, id)
    assert.equal(f.get(work).workflow?.status, 'blocked')
    f.failDelivery(false)
    await restarted.recover()
    assert.equal(f.delivered.length, 3)
  } finally { f.store.close() }
}))
