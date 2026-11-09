import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeStore } from './store.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { currentWorkNotification, workNotifications } from './work-notifications.ts'
import type { WorkRecord } from './work-contract.ts'

const worker = { kind: 'session' as const, sessionId: 'worker' }
const manager = { kind: 'session' as const, sessionId: 'manager' }
function setup(home: string) {
  const store = new InitiativeStore(home)
  const alignment = new WorkAlignment(store, { state: sessionId => ({ sessionId, segmentIndex: 0, mode: 'session' }), evidence: async () => {}, changed: async () => {} })
  const create = (assignee: string | null = 'worker') => alignment.execute(manager, 'create', undefined, undefined,
    { title: 'Synthetic Work', assignee, definition: { objective: 'Synthetic evidence' } }) as Promise<WorkRecord>
  return { store, alignment, create }
}

test('notification matrix: progress silent, blocked+attention once, review returns only waiting, no read/ack loop', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let work = await create()
    const update = async (patch: unknown) => work = await alignment.editNote(worker, work.key, work.sequence, patch)
    await update({ status: 'in_progress', notes: { summary: 'Measuring', plan: ['Collect'], next: 'Compare', artifacts: [{ label: 'Evidence', href: 'https://example.test/evidence' }] } })
    assert.equal(store.pendingWorkNotifications().length, 0)
    await update({ status: 'blocked', blockedReason: 'Need scope', notes: { attention: { kind: 'scope', summary: 'Choose scope', awaitingResponse: true } } })
    assert.deepEqual(store.pendingWorkNotifications().map(n => [n.kind, n.target]), [['blocked', 'manager']])
    const version = work.notes!.attention!.version
    await update({ status: 'blocked', blockedReason: 'Need scope', notes: { attention: { kind: 'scope', summary: 'Choose scope', awaitingResponse: true } } })
    assert.equal(work.notes!.attention!.version, version)
    assert.equal(store.pendingWorkNotifications().length, 1)
    work = await alignment.reviewNote(manager, work.key, work.sequence, 'Use existing scope')
    assert.equal(work.workflow!.status, 'blocked')
    assert.deepEqual(store.pendingWorkNotifications().map(n => [n.kind, n.target]), [['return_to_assignee', 'worker']])
    const ids = store.pendingWorkNotifications().map(n => n.id)
    store.settleWorkNotifications(ids); store.settleWorkNotifications(ids)
    assert.equal(store.pendingWorkNotifications().length, 0)
    assert.equal(alignment.get(work.key).sequence, work.sequence, 'settlement is not a Work mutation')
    await update({ notes: { attention: { kind: 'dependency', summary: 'Report dependency' } } })
    work = await alignment.reviewNote(manager, work.key, work.sequence, 'Recorded')
    assert.equal(store.pendingWorkNotifications().length, 0)
  } finally { store.close() }
}))

test('status episodes expire before reopen/reblock; attention, release and review cannot revive stale assignment', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let work = await create()
    const update = async (patch: unknown) => work = await alignment.editNote(worker, work.key, work.sequence, patch)
    await update({ status: 'done', notes: { summary: 'Measured' } })
    const first = store.pendingWorkNotifications()[0]
    await update({ status: 'in_progress' })
    assert.equal(store.pendingWorkNotifications().length, 0)
    await update({ status: 'done' })
    assert.equal(store.pendingWorkNotifications().length, 1)
    assert.notEqual(store.pendingWorkNotifications()[0].id, first.id)
    await update({ notes: { summary: 'More precise result' } })
    assert.equal(store.pendingWorkNotifications().length, 1)
    await update({ status: 'in_progress' })
    await update({ status: 'blocked', blockedReason: 'External wait' })
    const block = store.pendingWorkNotifications()[0].id
    await update({ status: 'in_progress' })
    await update({ status: 'blocked', blockedReason: 'External wait' })
    assert.notEqual(store.pendingWorkNotifications()[0].id, block)
    work = await alignment.reviewNote(manager, work.key, work.sequence, 'Retry later', undefined, 'return_to_assignee')
    const returned = store.pendingWorkNotifications()[0]
    work = await alignment.assignNote(manager, work.key, work.sequence, null)
    assert(!store.pendingWorkNotifications().some(n => n.id === returned.id))
    assert(!currentWorkNotification(returned, store.workRecords()))
    work = await alignment.assignNote(manager, work.key, work.sequence, 'worker')
    assert(!currentWorkNotification(returned, store.workRecords()))
  } finally { store.close() }
}))

test('routing is Work responsibility, not parent; null and self managers never fabricate recipients, legacy attention remains readable', async () => withTempWorkspace(async home => {
  const { store, create } = setup(home)
  try {
    const prior = await create()
    const next = { ...prior, sequence: prior.sequence + 1, changedBy: 'worker', notes: { ...prior.notes!, attention: { kind: 'scope' as const, summary: 'Legacy issue', version: 2, at: new Date().toISOString(), by: 'worker' } } }
    assert.deepEqual(workNotifications(next, prior, [next]).map(n => n.target), ['manager'])
    for (const owner of [null, 'worker']) {
      const record = { ...next, workflow: { ...next.workflow!, manager: owner } }
      assert.equal(workNotifications(record, prior, [record]).length, 0)
    }
    const ownChange = { ...next, changedBy: 'manager' }
    assert.equal(workNotifications(ownChange, prior, [ownChange]).length, 0)
    const noAssignee = { ...next, workflow: { ...next.workflow!, assignee: null }, notes: { ...next.notes, attention: { ...next.notes.attention, reviewed: { at: new Date().toISOString(), by: 'manager', conclusion: 'Return', disposition: 'return_to_assignee' as const, assignmentRevision: next.workflow!.assignmentRevision } } } }
    assert.equal(workNotifications(noAssignee, prior, [noAssignee]).length, 0)
  } finally { store.close() }
}))

test('pending facts survive restart and repeated settlement without Work review or resurrection', async () => withTempWorkspace(async home => {
  let { store, alignment, create } = setup(home)
  const work = await create()
  await alignment.editNote(worker, work.key, work.sequence, { status: 'done', notes: { summary: 'Complete' } })
  const pending = store.pendingWorkNotifications()
  store.close()
  ;({ store } = setup(home))
  try {
    assert.deepEqual(store.pendingWorkNotifications(), pending)
    store.settleWorkNotifications(pending.map(n => n.id))
    assert.equal(store.pendingWorkNotifications().length, 0)
    assert.equal(store.workRecords()[0].notes?.attention, undefined)
  } finally { store.close() }
}))


test('ancestor re-review creates a fresh return and expires old review/context handoffs', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let parent = await create(null)
    let child = await alignment.execute(manager, 'create', undefined, undefined, { title: 'Child', assignee: 'worker', parentKey: parent.key,
      definition: { objective: 'Collect evidence' }, notes: { relation: { kind: 'supports', reason: 'Supply evidence' } } }) as WorkRecord
    child = await alignment.editNote(worker, child.key, child.sequence, { notes: { attention: { kind: 'scope', summary: 'Choose scope', awaitingResponse: true } } })
    child = await alignment.reviewNote(manager, child.key, child.sequence, 'Initial scope')
    const oldReturn = store.pendingWorkNotifications().find(n => n.kind === 'return_to_assignee')!
    parent = await alignment.editNote(manager, parent.key, parent.sequence, { definition: { ...parent.definition, objective: 'Changed evidence goal' } })
    assert(!currentWorkNotification(oldReturn, store.workRecords()), 'ancestor changes expire a return before re-review')
    assert(!store.pendingWorkNotifications().some(n => n.id === oldReturn.id))
    const context = store.pendingWorkNotifications().find(n => n.kind === 'context')!
    assert(context)
    child = await alignment.reviewNote(manager, child.key, child.sequence, 'Revised scope', undefined, 'return_to_assignee')
    const returns = store.pendingWorkNotifications().filter(n => n.kind === 'return_to_assignee')
    assert.equal(returns.length, 1)
    assert.notEqual(returns[0].id, oldReturn.id)
    assert(!currentWorkNotification(oldReturn, store.workRecords()))
    assert.equal(returns[0].reviewVersion, child.sequence)
    assert(!store.pendingWorkNotifications().some(n => n.kind === 'context'), 'review retires old reassessment notice')
    parent = await alignment.assignNote(manager, parent.key, parent.sequence, 'other')
    assert(!currentWorkNotification(context, store.workRecords()), 'old ancestor assignment episode is obsolete')
  } finally { store.close() }
}))
