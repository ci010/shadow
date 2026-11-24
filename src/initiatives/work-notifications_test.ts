import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeStore } from './store.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { currentWorkNotification, workNotificationContent, workNotifications } from './work-notifications.ts'
import type { WorkRecord } from './work-contract.ts'

const worker = { kind: 'session' as const, sessionId: 'worker' }
const manager = { kind: 'session' as const, sessionId: 'manager' }
function setup(home: string) {
  const store = new InitiativeStore(home)
  const alignment = new WorkAlignment(store, { state: sessionId => ({ sessionId, segmentIndex: 0, mode: 'session' }),changed: async () => {} })
  const create = (assignee: string | null = 'worker') => alignment.execute(manager, 'create', undefined, undefined,
    { title: 'Synthetic Work', assignee, definition: 'Synthetic evidence' }) as Promise<WorkRecord>
  return { store, alignment, create }
}

test('notification matrix: progress silent, blocked once, no read/ack loop', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let work = await create()
    const update = async (patch: unknown) => work = await alignment.editNote(worker, work.key, work.sequence, patch)
    await update({ status: 'in_progress', summary: 'Measuring', artifacts: [{ label: 'Evidence', href: 'https://example.test/evidence' }] })
    assert.equal(store.pendingWorkNotifications().length, 0)
    await update({ status: 'blocked', blockedReason: 'Need scope' })
    assert.deepEqual(store.pendingWorkNotifications().map(n => [n.kind, n.target]), [['blocked', 'manager']])
    await update({ status: 'blocked', blockedReason: 'Still need scope' })
    await assert.rejects(alignment.reviewNote(manager, work.key, work.sequence, 'Does not apply'), /stale ancestor basis/)
    const ids = store.pendingWorkNotifications().map(n => n.id)
    assert.equal(ids.length, 1)
    store.settleWorkNotifications(ids); store.settleWorkNotifications(ids)
    assert.equal(store.pendingWorkNotifications().length, 0)
    assert.equal(alignment.get(work.key).sequence, work.sequence, 'settlement is not a Work mutation')
  } finally { store.close() }
}))

test('status episodes expire before reopen/reblock; release cannot revive stale assignment', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let work = await create()
    const update = async (patch: unknown) => work = await alignment.editNote(worker, work.key, work.sequence, patch)
    await update({ status: 'done', summary: 'Measured' })
    const first = store.pendingWorkNotifications()[0]
    await update({ status: 'in_progress' })
    assert.equal(store.pendingWorkNotifications().length, 0)
    await update({ status: 'done' })
    assert.equal(store.pendingWorkNotifications().length, 1)
    assert.notEqual(store.pendingWorkNotifications()[0].id, first.id)
    await update({ summary: 'More precise result' })
    assert.equal(store.pendingWorkNotifications().length, 1)
    await update({ status: 'in_progress' })
    await update({ status: 'blocked', blockedReason: 'External wait' })
    const block = store.pendingWorkNotifications()[0].id
    await update({ status: 'in_progress' })
    await update({ status: 'blocked', blockedReason: 'External wait' })
    assert.notEqual(store.pendingWorkNotifications()[0].id, block)
    const staleBlock = store.pendingWorkNotifications()[0]
    work = await alignment.assignNote(manager, work.key, work.sequence, null)
    assert(!store.pendingWorkNotifications().some(n => n.id === staleBlock.id))
    assert(!currentWorkNotification(staleBlock, store.workRecords()))
    work = await alignment.assignNote(manager, work.key, work.sequence, 'worker')
    assert(!currentWorkNotification(staleBlock, store.workRecords()))
  } finally { store.close() }
}))

test('routing is Work responsibility, not parent; null and self managers never fabricate recipients', async () => withTempWorkspace(async home => {
  const { store, create } = setup(home)
  try {
    const prior = await create()
    const next: WorkRecord = { ...prior, sequence: prior.sequence + 1, changedBy: 'worker', status: 'blocked', blockedReason: 'Need scope' }
    assert.deepEqual(workNotifications(next, prior, [next], 'note').map(n => n.target), ['manager'])
    for (const owner of [null, 'worker']) {
      const record = { ...next, manager: owner }
      assert.equal(workNotifications(record, prior, [record], 'note').length, 0)
    }
    const ownChange = { ...next, changedBy: 'manager' }
    assert.equal(workNotifications(ownChange, prior, [ownChange], 'note').length, 0)
  } finally { store.close() }
}))

test('pending facts survive restart and repeated settlement without Work review or resurrection', async () => withTempWorkspace(async home => {
  let { store, alignment, create } = setup(home)
  const work = await create()
  await alignment.editNote(worker, work.key, work.sequence, { status: 'done', summary: 'Complete' })
  const pending = store.pendingWorkNotifications()
  store.close()
  ;({ store } = setup(home))
  try {
    assert.deepEqual(store.pendingWorkNotifications(), pending)
    store.settleWorkNotifications(pending.map(n => n.id))
    assert.equal(store.pendingWorkNotifications().length, 0)
  } finally { store.close() }
}))


test('ancestor reassessment clears its pending context notice and does not send a reply', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let parent = await create(null)
    let child = await alignment.execute(manager, 'create', undefined, undefined, { title: 'Child', assignee: 'worker', parentKey: parent.key,
      definition: 'Collect evidence' }) as WorkRecord
    child = await alignment.editNote(worker, child.key, child.sequence, { status: 'blocked', blockedReason: 'Need external input' })
    parent = await alignment.editNote(manager, parent.key, parent.sequence, { definition: 'Changed evidence goal' })
    const context = store.pendingWorkNotifications().find(n => n.kind === 'context')!
    assert(context)
    const before = child
    child = await alignment.reviewNote(manager, child.key, child.sequence, 'Revised scope')
    assert.equal(child.status, 'blocked')
    assert.equal(child.blockedReason, before.blockedReason)
    assert.equal(child.revision, before.revision)
    assert.equal(child.assignmentRevision, before.assignmentRevision)
    assert.equal(child.contextAssessment, 'Revised scope')
    assert.deepEqual(store.pendingWorkNotifications().map(n => n.kind), ['blocked'])
    parent = await alignment.assignNote(manager, parent.key, parent.sequence, 'other')
    assert(!currentWorkNotification(context, store.workRecords()), 'old ancestor assignment episode is obsolete')
  } finally { store.close() }
}))


test('state persistence is not broadcast: only matching transitions notify, then consumers reread latest Work', async () => withTempWorkspace(async home => {
  const { store, create } = setup(home)
  try {
    const prior = await create()
    const dependent: WorkRecord = { ...prior, key: 'work:43f9813c-ecae-5dd2-a07e-70740e4228a6',
      manager: 'other-manager', assignee: 'observer', dependencies: [prior.key] }
    const progress: WorkRecord = { ...prior, sequence: prior.sequence + 1, changedBy: 'worker',
      summary: 'Updated development evidence' }
    assert.deepEqual(workNotifications(progress, prior, [progress, dependent], 'note'), [], 'persisted notes alone must not wake readers')
    const done: WorkRecord = { ...progress, summary: 'Finished fixture Work.', status: 'done' }
    const notices = workNotifications(done, progress, [done, dependent], 'note')
    assert.deepEqual(notices.map(notice => [notice.kind, notice.target]), [['done', 'manager']], 'a dependency edge is not a peer subscription')
    const content = workNotificationContent(notices, [done, dependent])
    assert.match(content, /Read latest Work before acting/)
    assert.match(content, /No acknowledgement or duplicate status message is required/)
    assert.match(content, /not authorization or human acceptance/)
    assert(currentWorkNotification(notices[0], [done, dependent]))
    assert(!currentWorkNotification(notices[0], [progress, dependent]), 'a withdrawn result cannot be acted on from its old notice')
  } finally { store.close() }
}))
