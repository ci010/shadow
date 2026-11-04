import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync, constants } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { projectStoragePath } from '../utils/data-paths.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { InitiativeStore } from './store.ts'
import type { WorkRecord } from './work-contract.ts'

const note = (key = 'work:11111111-1111-4111-8111-111111111111'): WorkRecord => ({
  key, subject: { kind: 'work', id: key.slice(5) }, revision: 1, sequence: 1,
  definition: { objective: 'Keep current Work', acceptance: [], boundaries: [], evidence: [] },
  origin: 'agent_interpretation', changedBy: 'web:owner', changedAt: '2026-10-01T00:00:00.000Z',
  change: 'understanding', reason: 'Current note', paused: false,
})

test('current Work records, links and history survive reopen without legacy tables', async () => {
  await withTempWorkspace(async home => {
    const store = new InitiativeStore(home)
    try {
    store.saveWork(note(), 0, 'web:owner', 'created')
    store.linkWorkSession('web:owner', 'work:11111111-1111-4111-8111-111111111111')
    assert.throws(() => store.saveWork(note(), 0, 'web:owner', 'created'), /changed/)
    assert.throws(() => store.assertWorkReference('root'), /not found/)
    assert.throws(() => store.assertWorkReference('work:11111111-1111-4111-8111-111111111111', 'work:foreign'), /does not belong/)
    assert.equal(store.getSessionSummary('web:owner'), null)
    } finally { store.close() }
    const db = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 6)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='initiatives'").get(), undefined)
    db.close()
    const reopened = new InitiativeStore(home)
    try {
      assert.deepEqual(reopened.workRecords(), [note()])
      assert.deepEqual(reopened.workSessionKeys('web:owner'), ['work:11111111-1111-4111-8111-111111111111'])
      assert.equal(reopened.workHistory('work:11111111-1111-4111-8111-111111111111').length, 1)
      assert.match(reopened.getSummary('work:11111111-1111-4111-8111-111111111111')!, /work:11111111-1111-4111-8111-111111111111/)
    } finally { reopened.close() }
  })
})

test('legacy Work databases fail explicitly without changing or deleting their data', async () => {
  await withTempWorkspace(async home => {
    const current = new InitiativeStore(home); current.close()
    const path = projectStoragePath(home, 'initiatives.sqlite')
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('user data'); PRAGMA user_version=5;")
    db.close()
    const before = readFileSync(path)
    assert.throws(() => new InitiativeStore(home), /Unsupported Work database version.*preserve the file/)
    assert.deepEqual(readFileSync(path), before)
  })
})

test('engine authorizer only permits current Work tables and guarded writes', async () => {
  await withTempWorkspace(async home => {
    type Authorizer = (action: number, arg1: string | null, arg2: string | null, database: string | null) => number
    const prototype = DatabaseSync.prototype as unknown as { setAuthorizer: (callback: Authorizer) => void }
    const original = prototype.setAuthorizer
    let authorizer: Authorizer | undefined
    prototype.setAuthorizer = function (callback) { authorizer = callback; original.call(this, callback) }
    let store: InitiativeStore
    try { store = new InitiativeStore(home) } finally { prototype.setAuthorizer = original }
    try {
      const c = constants as unknown as Record<string, number>
      for (const operation of ['SQLITE_ATTACH', 'SQLITE_PRAGMA', 'SQLITE_CREATE_TABLE', 'SQLITE_DROP_TABLE', 'SQLITE_ALTER_TABLE', 'SQLITE_RECURSIVE']) {
        assert.equal(authorizer!(c[operation]!, null, null, null), c.SQLITE_DENY)
      }
      assert.equal(authorizer!(c.SQLITE_READ!, 'initiatives', 'title', 'main'), c.SQLITE_DENY)
      assert.equal(authorizer!(c.SQLITE_READ!, 'work_contracts', 'data', 'main'), c.SQLITE_OK)
      assert.equal(authorizer!(c.SQLITE_UPDATE!, 'work_contracts', 'data', 'main'), c.SQLITE_DENY)
      assert.equal(authorizer!(c.SQLITE_READ!, 'work_contracts', 'data', 'other'), c.SQLITE_DENY)
      assert.equal(authorizer!(c.SQLITE_FUNCTION!, null, 'load_extension', null), c.SQLITE_DENY)
    } finally { store!.close() }
  })
})

test('version-6 Work keeps existing prefixed keys and leaves unused archive tables untouched', async () => {
  await withTempWorkspace(async home => {
    const current = new InitiativeStore(home)
    const retained: WorkRecord = { ...note(), key: 'initiative:retained', subject: { kind: 'initiative', initiativeId: 'retained' } }
    try { current.saveWork(retained, 0, 'web:owner', 'created') } finally { current.close() }
    const path = projectStoragePath(home, 'initiatives.sqlite')
    const db = new DatabaseSync(path)
    try { db.exec("CREATE TABLE initiatives(value TEXT); INSERT INTO initiatives VALUES ('untouched archive');") } finally { db.close() }
    const reopened = new InitiativeStore(home)
    try {
      assert.deepEqual(reopened.workRecords(), [retained])
      assert.match(reopened.getSummary('initiative:retained')!, /initiative:retained/)
      assert.equal(reopened.getSummary('retained'), null)
    } finally { reopened.close() }
    const check = new DatabaseSync(path)
    try { assert.equal(check.prepare('SELECT value FROM initiatives').get()!.value, 'untouched archive') } finally { check.close() }
  })
})
