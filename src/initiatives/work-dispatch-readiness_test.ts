import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { projectStoragePath } from '../utils/data-paths.ts'
import type { WorkKickoff } from './work-kickoff.ts'
import { WORK_DISPATCH_ID } from '../cron/work-dispatch-contract.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { InitiativeStore, automaticWorkEligible } from './store.ts'
import { workRecordSchema, type WorkRecord } from './work-contract.ts'

const worker = `work-executor:${'a'.repeat(40)}`
const inputId = `work-start:${'a'.repeat(40)}`
const manager = { kind: 'session' as const, sessionId: 'manager' }
function setup(home: string) {
  const state = (sessionId: string) => ['manager', worker].includes(sessionId) ? { sessionId, segmentIndex: 0, mode: 'session' as const } : undefined
  const store = new InitiativeStore(home, { isSessionKnown: id => !!state(id) })
  const alignment = new WorkAlignment(store, { state, changed: async () => {} })
  const create = async (data: Record<string, unknown> = {}) => workRecordSchema.parse(await alignment.execute(manager, 'create', undefined, undefined,
    { title: 'Synthetic Work', assignee: null, definition: 'Investigate only; no external action is authorized.', ...data }))
  return { store, alignment, create }
}

const claim = (store: InitiativeStore, record: WorkRecord, content = 'Exact synthetic kickoff') => {
  const assignmentRevision = record.assignmentRevision + 1
  const execution: NonNullable<WorkRecord['automaticExecution']> = { jobId: WORK_DISPATCH_ID, sessionId: worker, assignmentRevision, inputId, stage: 'claimed' as const }
  const kickoff: WorkKickoff = { key: record.key, revision: assignmentRevision, target: worker, input: {
    id: inputId, kind: 'message', timestamp: record.changedAt, policy: 'queue', content,
    source: { kind: 'event', eventId: inputId, type: 'work-assignment', source: 'system' },
  } }
  return store.claimAutomaticWork({ ...record, sequence: record.sequence + 1, assignee: worker, assignmentRevision,
    automaticExecution: execution }, record.sequence, kickoff)
}

test('unassigned findings are considered alongside other Work without granting authority', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const task = await f.create({ kind: 'task' })
    const finding = await f.create({ kind: 'finding' })
    const records = f.store.workRecords()
    assert.deepEqual(new Set(records.filter(record => automaticWorkEligible(record, records)).map(record => record.key)), new Set([task.key, finding.key]))
    claim(f.store, finding)
    const assigned = f.alignment.get(finding.key)
    assert.equal(assigned.assignee, worker)
    assert.equal(assigned.definition, finding.definition)
    assert.equal(automaticWorkEligible(assigned, f.store.workRecords()), false)
    assert.throws(() => claim(f.store, task), /unfinished Work/)
  } finally { f.store.close() }
}))

test('the claim transaction rechecks candidate sequence and current dependency and ancestor state', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const root = await f.create()
    const prerequisite = await f.create()
    const child = await f.create({ parentKey: root.key, kind: 'finding' })
    const edited = await f.alignment.editNote(manager, child.key, child.sequence, { dependencies: [prerequisite.key] })
    assert.throws(() => claim(f.store, child), /changed/)
    assert.throws(() => claim(f.store, edited), /claimable/)
    await f.alignment.editNote(manager, prerequisite.key, prerequisite.sequence, { status: 'done', summary: 'Prerequisite completed.' })
    assert.equal(automaticWorkEligible(edited, f.store.workRecords()), true)
    await f.alignment.editNote(manager, root.key, root.sequence, { status: 'cancelled' })
    assert.throws(() => claim(f.store, edited), /claimable/)
    assert.equal(f.alignment.get(child.key).assignee, null)
  } finally { f.store.close() }
}))


test('kickoff insert failure rolls back Work, then exact replay and release retain one immutable receipt', async () => withTempWorkspace(async home => {
  const f = setup(home)
  const db = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
  try {
    const work = await f.create()
    db.exec(`CREATE TRIGGER reject_kickoff BEFORE INSERT ON work_kickoffs BEGIN SELECT RAISE(ABORT, 'fixture insert failed'); END;`)
    assert.throws(() => claim(f.store, work), /fixture insert failed/)
    const reopened = new InitiativeStore(home)
    try {
      assert.deepEqual(reopened.workRecords(), JSON.parse(JSON.stringify([work])))
      assert.deepEqual(reopened.pendingWorkKickoffs(), [])
      assert.equal(db.prepare("SELECT count(*) AS count FROM work_contract_events WHERE kind='automatic_claim'").get()?.count, 0)
      assert.equal(db.prepare('SELECT count(*) AS count FROM work_session_links WHERE session_id=?').get(worker)?.count, 0)
      db.exec('DROP TRIGGER reject_kickoff')
      assert.equal(claim(f.store, work), true)
      assert.equal(claim(reopened, work), false)
      assert.throws(() => claim(reopened, work, 'Changed instructions'), /payload conflicts/)
      assert.equal(reopened.pendingWorkKickoffs().length, 1)
      assert.equal(reopened.workKickoff(inputId)?.input.content, 'Exact synthetic kickoff')
      assert.throws(() => reopened.reserveAssignmentDelivery(work.key, work.assignmentRevision + 1, manager.sessionId,
        worker, 'manual-followup', 'different-content'), /Automatic kickoff already accepted/)
      const current = f.alignment.get(work.key)
      const released = await f.alignment.assignNote(manager, current.key, current.sequence, null)
      assert.equal(released.assignee, null)
      assert.equal(reopened.workKickoff(inputId)?.state, 'invalid')
      assert.deepEqual(reopened.pendingWorkKickoffs(), [])
      assert.throws(() => claim(reopened, work), /changed/)
    } finally { reopened.close() }
  } finally { db.close(); f.store.close() }
}))
