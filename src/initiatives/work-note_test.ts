import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { WorkRecord } from './work-contract.ts'
import { InitiativeStore } from './store.ts'

const session = (sessionId: string) => ({ kind: 'session' as const, sessionId })
const states: Record<string, SessionState> = Object.fromEntries(['manager', 'worker', 'successor', 'replacement'].map(sessionId =>
  [sessionId, { sessionId, projectId: 'fixture', segmentIndex: 0, mode: 'session' }]))
function fixture(home: string) {
  const store = new InitiativeStore(home)
  const wakeups: string[][] = []
  const alignment = new WorkAlignment(store, { projectId: 'fixture',
    state: id => id === 'alias' ? states.manager : id === 'foreign' ? { ...states.manager, sessionId: 'foreign', projectId: 'other' }
      : id === 'temporary' ? { ...states.worker, sessionId: 'temporary', mode: 'task' } : states[id],
    changed: async () => { throw new Error('Comments must not publish Work changes') },
    wakeWorkNotifications: async () => { wakeups.push(store.pendingWorkNotifications().map(n => n.target)) },
  })
  // Use a no-op publisher for setup only.
  const setup = new WorkAlignment(store, { state: id => states[id], changed: async () => {} })
  const create = (manager: string, assignee: string | null) => setup.execute(session(manager), 'create', undefined, undefined,
    { title: 'Synthetic Work', definition: 'Observe only', assignee }) as Promise<WorkRecord>
  const post = (who: string, work: WorkRecord, body: string, fields: Record<string, unknown> = {}) =>
    alignment.createWorkNote(who, { workKey: work.key, body, ...fields })
  const mutate = (before: WorkRecord, patch: Partial<WorkRecord>) => {
    const next = { ...before, ...patch, sequence: before.sequence + 1 }
    store.saveWork(next, before.sequence, 'human', 'note')
    return next
  }
  return { store, create, post, mutate, wakeups }
}

test('originals are silent by default, replies are immutable, and only current roles can append', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    let work = await f.create('manager', 'worker')
    work = f.mutate(work, { status: 'blocked', blockedReason: 'Need evidence' })
    const records = f.store.workRecords()
    const history = f.store.workHistory(work.key)
    const pending = f.store.pendingWorkNotifications()
    const original = await f.post('worker', work, '  **A result**\r\n\rDetail  ')
    assert.deepEqual(original.note, { id: original.note.id, workKey: work.key, author: 'worker', createdAt: original.note.createdAt, body: '**A result**\n\nDetail' })
    assert.equal(original.notification, 'not_queued')
    assert.deepEqual(f.wakeups, [])
    assert.deepEqual(f.store.pendingWorkNotifications(), pending)
    assert.deepEqual(f.store.workRecords(), records)
    assert.deepEqual(f.store.workHistory(work.key), history)
    await assert.rejects(f.post('manager', work, 'Not your branch'), /assignee/)
    await assert.rejects(f.post('worker', work, 'Not your role', { replyTo: original.note.id }), /manager/)
    await assert.rejects(f.post('worker', work, 'Spoofed', { author: 'manager' }), /Unrecognized key/)
    await assert.rejects(f.post('manager', work, 'No override', { replyTo: original.note.id, notifyManager: false }), /automatically/)
    await assert.rejects(f.post('worker', work, ' '), /Too small|at least/)
    for (const id of ['alias', 'foreign', 'temporary', 'worker.0']) await assert.rejects(f.post(id, work, 'No identity'), /durable Project/)
    const alerted = await f.post('worker', work, 'Opted in', { notifyManager: true })
    assert.equal(alerted.notification, 'queued')
    assert.deepEqual(f.store.pendingWorkNotifications('manager').flatMap(n => n.kind === 'note_to_manager' && 'noteId' in n ? [n.noteId] : []), [alerted.note.id])
    assert.equal(f.wakeups.length, 1)
    work = f.mutate(work, { assignee: 'replacement', assignmentRevision: 2 })
    assert(f.store.pendingWorkNotifications().some(n => n.id === `note:${alerted.note.id}`), 'assignment change alone does not expire a manager notice')
    work = f.mutate(work, { manager: 'successor' })
    work = f.mutate(work, { manager: 'manager' })
    assert(!f.store.pendingWorkNotifications().some(n => n.id === `note:${alerted.note.id}`), 'A→B→A never resurrects an undelivered note')
    assert.deepEqual(f.store.prepareWorkNotificationDelivery('manager', [`note:${alerted.note.id}`], new Set(), 'manager.0').notices, [])
    await assert.rejects(f.post('successor', work, 'Stale manager', { replyTo: original.note.id }), /current Work manager/)
    await assert.rejects(f.post('worker', work, 'Stale worker'), /assignee/)
    const reply = await f.post('manager', work, 'Check the source again', { replyTo: original.note.id })
    assert.equal(reply.notification, 'queued')
    assert.equal(reply.note.replyTo, original.note.id)
    assert.deepEqual(f.store.workNote(work.key, original.note.id), original.note)
    await assert.rejects(f.post('manager', work, 'Nested', { replyTo: reply.note.id }), /original comment/)
    work = f.mutate(work, { manager: 'successor' })
    assert.deepEqual(f.store.pendingWorkNotifications().filter(n => n.kind === 'note_reply').map(n => n.target), ['worker'])
    assert.equal(f.store.prepareWorkNotificationDelivery('worker', [`note:${reply.note.id}`], new Set(), 'worker.0').notices.length, 1)
    assert.equal(f.store.workRecords()[0].status, 'blocked')
    assert.equal(f.store.workRecords()[0].sequence, work.sequence)
  } finally { f.store.close() }
}))

test('missing, aliased, foreign, temporary and self managers save without queuing; parent and cursors are Work-scoped', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    let work = await f.create('manager', 'worker')
    for (const manager of [null, 'missing', 'alias', 'foreign', 'temporary', 'worker']) {
      work = f.mutate(work, { manager })
      assert.equal((await f.post('worker', work, 'No eligible target', { notifyManager: true })).notification, 'not_queued')
    }
    const first = f.store.workNotes(work.key).items[0]
    const other = await f.create('manager', null)
    await assert.rejects(f.post('manager', other, 'Wrong Work', { replyTo: first.id }), /original comment on this Work/)
    assert.throws(() => f.store.workNotes(other.key, first.id), /cursor not found/)
    assert.throws(() => f.store.workNote(other.key, first.id), /comment not found/)
    assert.throws(() => f.store.workNotes(`work:${randomUUID()}`), /not found/)
    assert.deepEqual(f.store.pendingWorkNotifications(), [])
    assert.deepEqual(f.wakeups, [])
  } finally { f.store.close() }
}))

test('a different Project cannot read or reply to a Work comment even with familiar session IDs', async () => withTempWorkspace(async firstHome => withTempWorkspace(async secondHome => {
  const first = fixture(firstHome), second = fixture(secondHome)
  try {
    const work = await first.create('manager', 'worker')
    const { note } = await first.post('worker', work, 'Project-local Markdown')
    const local = await second.create('manager', 'worker')
    await assert.rejects(second.post('worker', work, 'Wrong Project'), /Work contract not found/)
    await assert.rejects(second.post('manager', local, 'Wrong Project', { replyTo: note.id }), /original comment on this Work/)
    assert.throws(() => second.store.workNote(work.key, note.id), /not found/)
    assert.throws(() => second.store.workNotes(local.key, note.id), /cursor not found/)
    assert.deepEqual(second.store.workNotes(local.key).items, [])
  } finally { second.store.close(); first.store.close() }
})))

test('append order survives paging during another connection’s inserts and restart', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  const second = fixture(home)
  try {
    const work = await f.create('manager', 'worker')
    for (let i = 0; i < 13; i++) await (i % 2 ? f : second).post('worker', work, `Comment ${i}`)
    const page = f.store.workNotes(work.key)
    assert.equal(page.items.length, 10)
    const latest = (await second.post('worker', work, 'New after the first page', { notifyManager: true })).note
    const rest = f.store.workNotes(work.key, page.next!)
    assert.equal(rest.next, null)
    assert.deepEqual([...page.items, ...rest.items].map(note => note.body), Array.from({ length: 13 }, (_, i) => `Comment ${12 - i}`))
    const restarted = fixture(home)
    try {
      assert.deepEqual(restarted.store.workNote(work.key, latest.id), latest)
      assert.deepEqual(restarted.store.pendingWorkNotifications().map(n => n.id), [`note:${latest.id}`])
    } finally { restarted.store.close() }
  } finally { second.store.close(); f.store.close() }
}))

test('ledger INSERT failure rolls back the note; legacy attention is neither migrated nor replayed', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  const db = new DatabaseSync(projectStoragePath(home, 'work.sqlite'))
  try {
    const work = await f.create('manager', 'worker')
    db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON work_notifications BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END;")
    await assert.rejects(f.post('worker', work, 'Must roll back', { notifyManager: true }), /synthetic ledger failure/)
    assert.deepEqual(f.store.workNotes(work.key), { items: [], next: null })
    assert.deepEqual(f.store.pendingWorkNotifications(), [])
    db.exec('DROP TRIGGER reject_notice')
    await f.post('worker', work, 'Still usable')
    const updateData = db.prepare('UPDATE work_contracts SET data=? WHERE id=?')
    const old = JSON.stringify({ ...work, attention: { summary: 'Never import or strip on load' } })
    updateData.run(old, work.key)
    assert.throws(() => new InitiativeStore(home), /Unrecognized key.*attention/)
    assert.equal(db.prepare('SELECT data FROM work_contracts WHERE id=?').get(work.key)?.data, old)
    updateData.run(JSON.stringify({ ...work, status: 'blocked', blockedReason: 'External wait' }), work.key)
    const enqueue = db.prepare('INSERT INTO work_notifications (id,target,pending,data) VALUES (?,?,1,?)')
    for (const kind of ['attention', 'return_to_assignee', 'blocked']) enqueue.run(kind, 'manager', JSON.stringify({
      id: kind, target: 'manager', kind, key: work.key, sequence: work.sequence, assignmentRevision: work.assignmentRevision, attentionVersion: 1,
    }))
    const restarted = fixture(home)
    try {
      assert(!('attention' in restarted.store.workRecords()[0]))
      assert.equal(restarted.store.workNotes(work.key).items.length, 1)
      assert.deepEqual(restarted.store.pendingWorkNotifications().map(n => n.kind), ['blocked'])
      assert.equal(restarted.store.prepareWorkNotificationDelivery('manager', ['blocked'], new Set(), 'manager.0').notices.length, 1)
    } finally { restarted.store.close() }
  } finally { db.close(); f.store.close() }
}))
