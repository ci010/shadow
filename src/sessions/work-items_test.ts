import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { InitiativeStore } from '../initiatives/store.ts'
import { WORK_APPROVE, WORK_REJECT, type WorkRecord } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import type { SessionState } from './session-store.ts'
import type { YieldDecisionRecord } from './yield-contract.ts'

const definition = { objective: 'Deliver both protocols', acceptance: ['Inbound and outbound pass'], boundaries: ['No publication'], evidence: [] }
const adopt = { understanding: 'Both directions', stop: [], retain: [], next: ['Implement and verify'] }
const checkpoint = { completed: [], artifacts: [], inFlight: [], unknown: [], retired: [] }
const actor = (sessionId: string) => ({ kind: 'session' as const, sessionId })

function setup(home: string) {
  const states = new Map<string, SessionState>(['owner', 'worker', 'peer'].map(id =>
    [id, { sessionId: id, segmentIndex: 0, mode: 'session' }]))
  states.set('temporary', { sessionId: 'temporary', segmentIndex: 0, mode: 'task' })
  const store = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  store.migrateWorkItems()
  let changed = 0
  const alignment = new WorkAlignment(store, { state: id => states.get(id), evidence: async () => {},
    changed: async () => { changed++ }, fresh: async () => {}, successor: async () => 'peer' })
  const create = async (title: string, assignee: string | null = 'owner', parentKey?: string) =>
    await alignment.execute(actor('owner'), 'create', undefined, undefined, { title, assignee, parentKey, definition, reason: 'User requested both protocols' }) as WorkRecord
  const manage = async (id: string, key: string, action: string, data: object) => {
    const record = alignment.get(key)
    return alignment.execute(actor(id), action, key, record.revision, { expectedSequence: record.sequence, ...data })
  }
  return { store, alignment, create, manage, states, changed: () => changed }
}

test('work migration retains identities, history, ownership, acceptance and durable archive fencing', async () => withTempWorkspace(async home => {
  let store = new InitiativeStore(home, { trackWork: true, isSessionKnown: () => true })
  try {
    store.query("INSERT INTO initiatives(id,title,goal,context) VALUES ('release','Release','Both outcomes','Historical context');" +
      "INSERT INTO initiative_items(id,initiative_id,title,assignee_session_id) VALUES ('verify','release','Verify both','worker');", 'owner')
    const before = store.workRecords()[0]!
    store.setWorkFocus('worker', before.key)
    store.startWorkEffect(randomUUID(), 'worker', 'exec', [{ key: before.key, revision: before.revision }])
    store.migrateWorkItems()
    const item = store.workRecords().find(record => record.key === before.key)!
    assert.deepEqual(item.definition, before.definition)
    assert.equal(item.revision, before.revision)
    assert.equal(item.workflow?.assignee, 'worker')
    assert.equal(item.workflow?.manager, 'owner')
    assert.equal(item.workflow?.parentKey, 'initiative:release')
    assert.equal(store.workFocus('worker'), before.key)
    assert.equal(store.workEffects()[0]?.stamps[0]?.key, before.key)
    assert.equal(store.initiativeView('release').items.length, 2)
    assert(store.workHistory('initiative:release').some(event => event.kind === 'legacy_initiative'))
    const migrated = store.workRecords()
    store.migrateWorkItems()
    assert.deepEqual(store.workRecords(), migrated)
    assert.throws(() => store.query("UPDATE initiative_items SET status='done' WHERE id='verify'", 'worker'), /historical archive/)
    store.close()
    store = new InitiativeStore(home, { isSessionKnown: () => true })
    assert.equal(store.unifiedWork, true)
    assert.deepEqual(store.workRecords(), migrated)
    assert.throws(() => store.query("UPDATE initiatives SET goal='Different' WHERE id='release'", 'owner'), /historical archive/)
  } finally { store.close() }
}))

test('one work item survives release and reassignment; stale generations and takeover are rejected', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const work = await f.create('Protocol')
    await f.alignment.execute(actor('owner'), 'adopt', work.key, 1, adopt)
    const old = f.alignment.snapshot('owner')
    await assert.rejects(f.manage('peer', work.key, 'assign', { assignee: null, reason: 'Take over' }), /cannot be stolen/)
    await assert.rejects(f.manage('owner', work.key, 'assign', { assignee: null, reason: 'Hand off' }), /checkpoint/)
    await f.alignment.execute(actor('owner'), 'checkpoint', work.key, 1, checkpoint)
    await f.manage('owner', work.key, 'assign', { assignee: null, reason: 'Inventory verified' })
    await assert.rejects(f.manage('owner', work.key, 'assign', { assignee: 'temporary' }), /durable Session/)
    await assert.rejects(f.manage('owner', work.key, 'assign', { assignee: 'remote:external' }), /durable Session/)
    await f.manage('owner', work.key, 'assign', { assignee: 'worker' })
    assert.equal(f.store.workRecords().length, 1)
    assert.equal(f.alignment.current(old), false)
    await f.alignment.execute(actor('worker'), 'select', work.key, 1, {})
    await f.alignment.execute(actor('worker'), 'adopt', work.key, 1, adopt)
    f.alignment.assertCurrent(f.alignment.snapshot('worker'), 'worker')
    assert.equal(f.alignment.get(work.key).revision, 1, 'Assignment does not invent a goal revision')
    const current = f.alignment.get(work.key)
    await assert.rejects(f.alignment.execute(actor('worker'), 'progress', work.key, 1,
      { expectedSequence: current.sequence - 1, status: 'in_progress' }), /Work changed/)
  } finally { f.store.close() }
}))

test('Initiative progress is derived; dependencies and parent cycles cannot bypass acceptance', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const root = await f.create('Release')
    const first = await f.create('Inbound', 'worker', root.key)
    const second = await f.create('Outbound', 'peer', root.key)
    await f.manage('owner', second.key, 'dependencies', { keys: [first.key] })
    await assert.rejects(f.manage('owner', first.key, 'dependencies', { keys: [second.key] }), /cycle/)
    await assert.rejects(f.manage('owner', first.key, 'dependencies', { keys: [root.key] }), /cycle/)
    await f.alignment.execute(actor('peer'), 'adopt', second.key, 1, adopt)
    assert.throws(() => f.alignment.assertCurrent(f.alignment.snapshot('peer'), 'peer'), /unfinished dependencies/)
    await assert.rejects(f.manage('owner', root.key, 'progress', { status: 'done', result: { summary: 'Not verified', evidence: [] } }), /Adopt/)
    await f.alignment.execute(actor('owner'), 'adopt', root.key, 1, adopt)
    await assert.rejects(f.alignment.execute({ kind: 'user' }, 'progress', root.key, 1,
      { expectedSequence: f.alignment.get(root.key).sequence, status: 'done', result: { summary: 'Reviewed', evidence: [] } }), /child work/)
    for (const work of [first, second]) {
      await f.alignment.execute({ kind: 'user' }, 'progress', work.key, 1,
        { expectedSequence: f.alignment.get(work.key).sequence, status: 'done', result: { summary: 'Verified acceptance', evidence: [] } })
    }
    assert.equal(f.store.initiativeView(root.key).progress.done, 2)
    assert.equal(f.alignment.get(root.key).workflow?.status, 'pending')
    assert.equal(f.alignment.get(second.key).revision, 1)
  } finally { f.store.close() }
}))

test('release retains its audit reason and cannot lose its checkpoint requirement through a revision', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const work = await f.create('Handoff', 'worker')
    await f.alignment.execute(actor('worker'), 'adopt', work.key, 1, adopt)
    await f.alignment.execute({ kind: 'user' }, 'update', work.key, 1,
      { change: 'understanding', definition, reason: 'Reviewed interpretation' })
    await assert.rejects(f.manage('worker', work.key, 'assign', { assignee: null, reason: 'No inventory yet' }), /checkpoint/)
    f.states.delete('worker')
    const effectId = randomUUID()
    f.store.startWorkEffect(effectId, 'worker', 'exec', [{ key: work.key, revision: 2 }])
    const release = () => f.alignment.execute({ kind: 'user' }, 'assign', work.key, 2,
      { expectedSequence: f.alignment.get(work.key).sequence, assignee: null, reason: 'Human verified the departed executor' })
    await assert.rejects(release(), /checkpoint/)
    f.store.finishWorkEffect(effectId, false)
    await release()
    assert.equal(f.alignment.get(work.key).workflow?.assignee, null)
    assert.match(JSON.stringify(f.store.workHistory(work.key)), /Human verified the departed executor/)
    assert.match(JSON.stringify(f.store.workHistory(work.key)), /"orphanRecovery":true/)
  } finally { f.store.close() }
}))

test('proposal approval is exact, single-application and never inferred from timeout or custom answers', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const work = await f.create('Work')
    const change = { change: 'goal', reason: 'New acceptance requested', paused: false,
      definition: { ...definition, objective: 'Deliver and document both protocols' } }
    const propose = async () => await f.alignment.execute(actor('owner'), 'propose', work.key,
      f.alignment.get(work.key).revision, change) as { proposalId: string }
    const proposal = await propose()
    const binding = f.alignment.decision(work.key, proposal.proposalId)
    const decision = (answeredBy: 'user' | 'timeout', custom = false): YieldDecisionRecord => ({
      request: { workProposal: binding, question: 'Apply?', options: [WORK_APPROVE, WORK_REJECT], defaultOption: WORK_REJECT,
        id: 'question', sessionId: 'owner', recipient: { kind: 'user', sessionId: 'owner' },
        createdAt: new Date().toISOString(), deadline: null, origin: { physicalId: 'physical' } },
      answer: { requestId: 'question', answeredBy, option: custom ? 'Different framing' : answeredBy === 'timeout' ? WORK_REJECT : WORK_APPROVE,
        answeredAt: new Date().toISOString(), ...(custom ? { custom: true as const } : {}) },
    })
    f.alignment.bindDecision(binding, { sessionId: 'owner', physicalId: 'physical', requestId: 'question' })
    const altered = decision('user')
    altered.request.workProposal = { ...binding, definition: { ...definition, objective: 'Different displayed proposal' } }
    await assert.rejects(f.alignment.settleDecision(altered), /does not match/)
    await f.alignment.settleDecision(decision('timeout'))
    assert.equal(f.alignment.get(work.key).revision, 1)
    const custom = await propose()
    const customRecord = decision('user', true)
    customRecord.request.workProposal = f.alignment.decision(work.key, custom.proposalId)
    f.alignment.bindDecision(customRecord.request.workProposal, { sessionId: 'owner', physicalId: 'physical', requestId: 'question' })
    await f.alignment.settleDecision(customRecord)
    assert.equal(f.alignment.get(work.key).revision, 1)
    const accepted = await propose()
    await assert.rejects(f.alignment.execute(actor('owner'), 'apply_proposal', work.key, 1, { proposalId: accepted.proposalId }), /authenticated human/)
    await f.alignment.applyProposal(work.key, accepted.proposalId)
    await f.alignment.applyProposal(work.key, accepted.proposalId)
    assert.equal(f.alignment.get(work.key).revision, 2)
    assert.equal(f.alignment.get(work.key).origin, 'human')
    assert.equal(f.alignment.get(work.key).adoption, undefined)
    assert(f.changed() >= 4, 'Proposals must notify the UI, not hide only in history')
  } finally { f.store.close() }
}))

test('work discovery pages compact indexes while exact context remains readable across assignments', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const root = await f.create('Root')
    for (let i = 0; i < 6; i++) await f.create(`Child ${i}`, 'worker', root.key)
    const page = await f.alignment.execute(actor('peer'), 'tree', root.key, undefined, { limit: 2 }) as {
      items: { key: string }[]; totalMatches: number; nextOffset: number; progress: { total: number }
    }
    assert.equal(page.items.length, 2)
    assert.equal(page.totalMatches, 7)
    assert.equal(page.progress.total, 7)
    assert.equal(page.nextOffset, 2)
    assert.equal('definition' in page.items[0], false)
    const next = await f.alignment.execute(actor('peer'), 'tree', root.key, undefined, { limit: 2, offset: page.nextOffset }) as typeof page
    assert(!page.items.some(item => next.items.some(other => other.key === item.key)))
    assert.equal(f.alignment.context('peer', root.key).records[0].definition.objective, definition.objective)
    await assert.rejects(f.alignment.execute(actor('peer'), 'list', undefined, undefined, { limit: 21 }))
  } finally { f.store.close() }
}))

test('custom answers affect only their bound work, including a different assigned executor', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const a = await f.create('A', 'worker'), b = await f.create('B', 'worker')
    for (const item of [a, b]) await f.alignment.execute(actor('worker'), 'adopt', item.key, 1, adopt)
    await f.alignment.execute(actor('worker'), 'select', a.key, 1, {})
    const stamps = f.alignment.snapshot('worker')
    f.alignment.reviewAnswer('owner', 'Correct only A', 'question', stamps)
    assert.equal(f.alignment.get(a.key).adoption, undefined)
    assert(f.alignment.get(b.key).adoption)
  } finally { f.store.close() }
}))
