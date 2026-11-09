import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { InitiativeStore } from './store.ts'
import type { WorkRecord } from './work-contract.ts'

const completionFixture = (): WorkRecord => ({
  key: 'work:11111111-1111-4111-8111-111111111111', subject: { kind: 'work', id: '11111111-1111-4111-8111-111111111111' },
  revision: 1, sequence: 1, definition: { objective: 'A result', acceptance: [], boundaries: [], evidence: [] },
  origin: 'human', changedBy: 'web:owner', changedAt: '2020-01-01T00:00:00.000Z',
  change: 'understanding', reason: 'Fixture', paused: false,
  workflow: { title: 'Result', manager: null, assignee: null, assignmentRevision: 1, status: 'pending', dependencies: [] },
})

test('completion receipts survive reopen, isolate principals and repeat only on a new done transition', async () => {
  await withTempWorkspace(async home => {
    let store = new InitiativeStore(home)
    let record = completionFixture()
    const save = (status: 'pending' | 'done', kind = 'progress') => {
      record = { ...record, sequence: record.sequence + 1, workflow: { ...record.workflow!, status } }
      store.saveWork(record, record.sequence - 1, 'fixture', kind)
    }
    try {
      store.saveWork(record, 0, 'fixture', 'created')
      assert.deepEqual(store.workCompletions('alice'), [])
      const before = Date.now(); save('done')
      const first = store.workCompletions('alice')[0]!
      assert(first.unread); assert(Date.parse(first.completedAt!) >= before)
      assert.notEqual(first.completedAt, record.changedAt)
      const history = store.workHistory(record.key)
      store.markWorkCompletionsRead('alice', { items: [{ key: first.key, completionId: first.completionId }] })
      assert.equal(store.workCompletions('alice')[0]!.unread, false)
      assert.equal(store.workCompletions('bob')[0]!.unread, true)
      assert.deepEqual(store.workHistory(record.key), history)
      assert.deepEqual(store.workRecords(), [record])
      save('done', 'note')
      assert.equal(store.workCompletions('alice')[0]!.completionId, first.completionId)
      assert.equal(store.workCompletions('alice')[0]!.unread, false)
      store.close(); store = new InitiativeStore(home)
      assert.equal(store.workCompletions('alice')[0]!.unread, false)
      save('pending'); assert.deepEqual(store.workCompletions('alice'), [])
      save('done')
      const second = store.workCompletions('alice')[0]!
      assert.notEqual(second.completionId, first.completionId)
      assert(second.unread)
      store.markWorkCompletionsRead('alice', { items: [{ key: first.key, completionId: first.completionId }, { key: 'foreign', completionId: second.completionId }] })
      assert.equal(store.workCompletions('alice')[0]!.unread, true)
      assert.throws(() => store.markWorkCompletionsRead('alice', { principal: 'bob', items: [] }))
      assert.throws(() => store.workCompletions(''))
    } finally { store.close() }
  })
})

test('v6 migration retains legacy events, uses actual transition time or null, and is stable on reopen', async () => {
  for (const withHistory of [true, false]) await withTempWorkspace(async home => {
    const initial = new InitiativeStore(home); initial.close()
    const record = completionFixture(); record.sequence = 4; record.workflow!.status = 'done'
    const db = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
    db.prepare('INSERT INTO work_contracts (id,sequence,data) VALUES (?,?,?)').run(record.key, record.sequence, JSON.stringify(record))
    if (withHistory) {
      const insert = db.prepare('INSERT INTO work_contract_events (id,work_key,actor,kind,created_at,data) VALUES (?,?,?,?,?,?)')
      for (const [sequence, status, at] of [[2, 'pending', '2025-01-01T00:00:00.000Z'], [3, 'done', '2025-02-01T00:00:00.000Z'], [4, 'done', '2025-03-01T00:00:00.000Z']] as const)
        insert.run(String(sequence), record.key, 'fixture', 'progress', at, JSON.stringify({ sequence, workflow: { status } }))
    }
    db.close()
    let store = new InitiativeStore(home)
    try {
      const first = store.workCompletions('alice')[0]!
      assert.equal(first.completedAt, withHistory ? '2025-02-01T00:00:00.000Z' : null)
      assert.equal(first.completionId, `legacy:${record.key}`); assert(first.unread)
      assert.equal(store.workHistory(record.key).length, withHistory ? 3 : 0)
      assert.deepEqual(store.workRecords(), [record])
      store.markWorkCompletionsRead('alice', { items: [{ key: first.key, completionId: first.completionId }] })
      store.close(); store = new InitiativeStore(home)
      assert.equal(store.workCompletions('alice')[0]!.completionId, first.completionId)
      assert.equal(store.workCompletions('alice')[0]!.unread, false)
    } finally { store.close() }
  })
})

test('read receipts are Project-local even for identical Work keys and principals', async () => {
  await withTempWorkspace(async a => withTempWorkspace(async b => {
    const first = new InitiativeStore(a), second = new InitiativeStore(b)
    try {
      const record = completionFixture(); record.workflow!.status = 'done'
      for (const store of [first, second]) store.saveWork(record, 0, 'fixture', 'created')
      const item = first.workCompletions('alice')[0]!
      first.markWorkCompletionsRead('alice', { items: [{ key: item.key, completionId: item.completionId }] })
      second.markWorkCompletionsRead('alice', { items: [{ key: item.key, completionId: item.completionId }] })
      assert.equal(first.workCompletions('alice')[0]!.unread, false)
      assert.equal(second.workCompletions('alice')[0]!.unread, true)
    } finally { first.close(); second.close() }
  }))
})
