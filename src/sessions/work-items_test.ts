import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { InitiativeStore } from '../initiatives/store.ts'
import { parseStoredWorkRecord, parseStoredWorkStamps, workRecordSchema, workStampsSchema, type WorkRecord } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import type { SessionState } from './session-store.ts'
import { parseYieldQuestion } from './yield-contract.ts'

const definition = { objective: 'Deliver both protocols', acceptance: ['Inbound and outbound pass'], boundaries: ['No publication'], evidence: [] }
const actor = (sessionId: string) => ({ kind: 'session' as const, sessionId })
const retired = { adoption: { malformed: true }, checkpoint: false, transition: { strategy: 'successor' },
  answerReview: 'old', handoffFrom: null, successors: ['worker'], proposals: [{ status: 'pending' }] }

function setup(home: string) {
  const states = new Map<string, SessionState>(['owner', 'worker', 'peer'].map(id =>
    [id, { sessionId: id, segmentIndex: 0, mode: 'session' }]))
  states.set('temporary', { sessionId: 'temporary', segmentIndex: 0, mode: 'task' })
  const store = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  let changed = 0
  const alignment = new WorkAlignment(store, { state: id => states.get(id), evidence: async () => {},
    changed: async () => { changed++ }, })
  const create = async (title: string, assignee: string | null = 'owner', parentKey?: string) =>
    await alignment.execute(actor('owner'), 'create', undefined, undefined, { title, assignee, parentKey, definition, reason: 'User requested both protocols',
      notes: { kind: 'task', ...(parentKey ? { relation: { kind: 'supports', reason: 'Part of the shared outcome' } } : {}) } }) as WorkRecord
  return { store, alignment, create, states }
}

test('work discovery pages compact indexes while exact context remains readable across assignments', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const root = await f.create('Root')
    for (let i = 0; i < 6; i++) await f.create(`Child ${i}`, null, root.key)
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


test('retired fields are storage-only omissions, never current schema or write input', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const work = await f.create('Current notebook')
    const legacy = { ...work, ...retired }
    assert.deepEqual(parseStoredWorkRecord(legacy), work)
    assert.deepEqual(Object.keys(parseStoredWorkRecord(legacy)).filter(key => key in retired), [])
    assert.throws(() => workRecordSchema.parse(legacy), /Unrecognized key/)
    assert.throws(() => f.store.saveWork({ ...legacy, sequence: 2 }, 1, 'owner', 'forged'), /Unrecognized key/)
    for (const corrupt of [{ revision: 0 }, { workflow: { ...work.workflow, status: 'working' } },
      { definition: { ...definition, objective: '' } }, { unexpectedFutureField: true }]) {
      assert.throws(() => parseStoredWorkRecord({ ...legacy, ...corrupt }))
    }
    for (const action of ['adopt', 'checkpoint', 'transition', 'fresh', 'successor', 'propose', 'apply_proposal',
      'policy', 'manage', 'progress', 'dependencies', 'update', 'assign', 'review']) {
      // Current update/assign/review are explicit versioned methods, not legacy execute routes.
      await assert.rejects(f.alignment.execute({ kind: 'user' }, action, work.key, work.revision, {}), /Unknown work action/)
    }
    assert.deepEqual(f.alignment.get(work.key), JSON.parse(JSON.stringify(work)))
    const stamp = { key: work.key, revision: 1, assignmentRevision: 1 }
    assert.deepEqual(parseStoredWorkStamps([{ ...stamp, adoptionId: { malformed: true } }]), [stamp])
    assert.throws(() => workStampsSchema.parse([{ ...stamp, adoptionId: 'legacy' }]))
    assert.throws(() => parseStoredWorkStamps([{ ...stamp, unexpected: true }]))
    assert.throws(() => parseStoredWorkStamps([{ ...stamp, revision: 0, adoptionId: 'legacy' }]))
  } finally { f.store.close() }
}))

test('synthetic v6 rows ignore named retired fields without rewriting storage, preserving notes and assignment', async () => withTempWorkspace(async home => {
  const f = setup(home)
  const work = await f.create('Legacy readable')
  f.store.close()
  const { projectStoragePath } = await import('../utils/data-paths.ts')
  const path = projectStoragePath(home, 'initiatives.sqlite')
  const db = new DatabaseSync(path)
  const serialized = JSON.stringify({ ...work, ...retired })
  db.prepare('UPDATE work_contracts SET data=? WHERE id=?').run(serialized, work.key)
  db.prepare('INSERT INTO work_contract_events (id,work_key,actor,kind,created_at,data) VALUES (?,?,?,?,?,?)')
    .run('legacy-audit', work.key, 'owner', 'legacy', new Date().toISOString(), JSON.stringify({ ...work, ...retired, retainedAuditDetail: 'keep' }))
  db.prepare('INSERT INTO work_effects (id, session_id, tool, status, stamps) VALUES (?,?,?,?,?)')
    .run('legacy-effect', 'owner', 'write', 'uncertain', JSON.stringify([{ key: work.key, revision: 1, adoptionId: 'old' }]))
  db.close()
  const reopened = new InitiativeStore(home)
  try {
    assert.deepEqual(reopened.workRecords(), [JSON.parse(JSON.stringify(work))])
    assert.deepEqual(reopened.workEffects()[0].stamps, [{ key: work.key, revision: 1 }])
    assert.equal(reopened.workAuthority(work.subject).executor, 'owner')
    const audit = reopened.workHistory(work.key).find(event => event.kind === 'legacy')!.data as Record<string, unknown>
    assert.deepEqual(Object.keys(audit).filter(key => key in retired), [])
    assert.equal(audit.retainedAuditDetail, 'keep', 'Audit details are not blanket-stripped')
  } finally { reopened.close() }
  const untouched = new DatabaseSync(path)
  try {
    assert.equal(untouched.prepare('SELECT data FROM work_contracts WHERE id=?').get(work.key)!.data, serialized)
    untouched.prepare('UPDATE work_contracts SET data=? WHERE id=?').run(JSON.stringify({ ...work, ...retired, workflow: { ...work.workflow, status: 'corrupt' } }), work.key)
  } finally { untouched.close() }
  assert.throws(() => new InitiativeStore(home), /Invalid enum/)
  const corrupt = new DatabaseSync(path)
  try { corrupt.prepare('UPDATE work_contracts SET data=? WHERE id=?').run(JSON.stringify({ ...work, ...retired, unknownCurrentField: true }), work.key) }
  finally { corrupt.close() }
  assert.throws(() => new InitiativeStore(home), /Unrecognized key/)
}))

test('historical Work decisions fail closed and cannot become ordinary approval questions', () => {
  const question = { question: 'Apply?', options: ['Apply', 'Keep'], defaultOption: 'Keep' }
  for (const workProposal of [undefined, null, {}, { status: 'pending' }, { status: 'applied' }]) {
    assert.throws(() => parseYieldQuestion({ ...question, workProposal }), /Retired Work proposal/)
  }
  assert.deepEqual(parseYieldQuestion(question), question)
})
