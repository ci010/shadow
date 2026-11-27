import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { InitiativeStore } from '../src/initiatives/store.ts'
import { WORK_DISPATCH_ID } from '../src/cron/work-dispatch-contract.ts'
import { convertLegacyWork, migrateWorkRecords } from './migrate-work-records.ts'

const at = '2026-11-25T00:00:00.000Z'
const key = 'work:11111111-1111-4111-8111-111111111111'
const legacy = () => ({
  key, subject: { kind: 'work', id: key.slice(5) }, revision: 2, sequence: 3,
  definition: { objective: 'Retain the objective', acceptance: ['Acceptance requirement'], boundaries: ['No publication'], evidence: [] },
  origin: 'human', changedBy: 'web:owner', changedAt: at, change: 'goal', reason: 'Recorded request', paused: false,
  creationRequest: { creator: 'web:owner', key: 'fixture-request', fingerprint: 'a'.repeat(64) },
  workflow: {
    title: 'Fixture', manager: 'web:owner', assignee: 'web:worker',
    assignmentRevision: 4, status: 'blocked', blockedReason: 'Needs input', dependencies: [],
  },
  notes: {
    basis: [], kind: 'task', summary: 'Progress retained', plan: ['Historical plan'], next: 'Ask owner',
    artifacts: [{ label: 'Artifact', href: 'https://example.test/result' }], html: '<p>Historical report</p>',
  },
})

async function fixture(home: string, value: unknown = legacy()) {
  const store = new InitiativeStore(home)
  store.close()
  const db = new DatabaseSync(join(home, 'state', 'work.sqlite'))
  try {
    db.prepare('INSERT INTO work_contracts VALUES (?,?,?)').run(key, 3, JSON.stringify(value))
    db.prepare('INSERT INTO work_contract_events VALUES (?,?,?,?,?,?)')
      .run('old-event', key, 'web:owner', 'created', at, JSON.stringify(value))
    db.prepare('INSERT INTO work_session_links VALUES (?,?)').run('web:owner', key)
    db.prepare('INSERT INTO work_execution_bindings VALUES (?,?)').run('web:worker', key)
    db.prepare('INSERT INTO work_notifications VALUES (?,?,?,?)')
      .run('old-notification', 'web:owner', 1, JSON.stringify({ kind: 'blocked', key }))
  } finally { db.close() }
  await mkdir(join(home, 'state', 'cron'), { recursive: true })
  await writeFile(join(home, 'state', 'cron', 'jobs.json'), JSON.stringify({
    version: 1, jobs: [{ id: WORK_DISPATCH_ID, enabled: true }, { id: 'unrelated', enabled: true }],
  }))
  // Neither session persistence format may be rewritten by a Work-only conversion.
  await mkdir(join(home, 'state', 'sessions'), { recursive: true })
  await writeFile(join(home, 'state', 'sessions', 'fixture.jsonl'), '{"content":"retained history"}\n')
  const sessions = new DatabaseSync(join(home, 'state', 'sessions', 'sessions.sqlite'))
  sessions.exec("CREATE TABLE retained(data TEXT); INSERT INTO retained VALUES ('session identity and history');")
  sessions.close()
}

test('offline conversion retains assignment, status, report, boundaries and IDs without granting new authority', () => {
  const { record, comments, creation } = convertLegacyWork(legacy(), at)
  assert.equal(record.key, key)
  assert.equal(record.revision, 2)
  assert.equal(record.sequence, 4)
  assert.equal(record.assignmentRevision, 4)
  assert.equal(record.assignee, 'web:worker')
  assert.equal(record.manager, 'web:owner')
  assert.equal(record.status, 'blocked')
  assert.equal(record.blockedReason, 'Needs input')
  assert.match(record.definition, /Retain the objective[\s\S]*Acceptance requirement[\s\S]*No publication/)
  assert.equal(record.summary, 'Progress retained')
  assert.deepEqual(record.artifacts, legacy().notes.artifacts)
  assert.deepEqual(comments, ['Historical plan: Historical plan', 'Historical next step: Ask owner'])
  assert.deepEqual(creation, legacy().creationRequest)
})

test('unknown, paused, manual, noncanonical and oversize legacy records are refused, never truncated or defaulted', () => {
  for (const invalid of [
    { ...legacy(), unknown: true }, { ...legacy(), paused: true },
    { ...legacy(), workflow: { ...legacy().workflow, automaticDispatch: 'manual' } },
    { ...legacy(), subject: { kind: 'work', id: '22222222-2222-4222-8222-222222222222' } },
    { ...legacy(), definition: { ...legacy().definition, objective: 'x'.repeat(4000), acceptance: ['y'.repeat(4000)] } },
  ]) assert.throws(() => convertLegacyWork(invalid, at))
})

test('plan is read-only; apply backs up SQLite, retains raw audit history and both session formats, and disables only Work dispatch', async () => {
  await withTempWorkspace(async home => {
    await fixture(home)
    const path = join(home, 'state', 'work.sqlite'), jobsPath = join(home, 'state', 'cron', 'jobs.json')
    const before = await readFile(path), jobsBefore = await readFile(jobsPath)
    const sessionPath = join(home, 'state', 'sessions')
    const jsonlBefore = await readFile(join(sessionPath, 'fixture.jsonl'))
    const sqliteBefore = await readFile(join(sessionPath, 'sessions.sqlite'))
    assert.equal((await migrateWorkRecords(home, 'plan', false)).migrated, 1)
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readFile(jobsPath), jobsBefore)
    await assert.rejects(migrateWorkRecords(home, 'apply', false), /runtime-stopped/)
    const result = await migrateWorkRecords(home, 'apply', true)
    assert.equal(result.migrated, 1)
    assert.ok('journalPath' in result)
    const journal = JSON.parse(await readFile(result.journalPath!, 'utf8'))
    const backup = new DatabaseSync(journal.backupPath, { readOnly: true })
    assert.equal(backup.prepare('SELECT data FROM work_contracts').get()!.data, JSON.stringify(legacy()))
    backup.close()
    const store = new InitiativeStore(home)
    try {
      assert.equal(store.workRecords()[0]!.status, 'blocked')
      assert.deepEqual(store.workSessionKeys('web:owner'), [key])
      assert.equal(store.workHistory(key).length, 2)
      assert.equal(store.workNotes(key).items.length, 2)
    } finally { store.close() }
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(db.prepare("SELECT data FROM work_contract_events WHERE id='old-event'").get()!.data, JSON.stringify(legacy()))
      assert.equal(db.prepare('SELECT original_data FROM work_record_migration_archive').get()!.original_data, JSON.stringify(legacy()))
      assert.equal(db.prepare('SELECT pending FROM work_notifications').get()!.pending, 0)
      assert.equal(db.prepare('SELECT work_key FROM work_execution_bindings').get()!.work_key, key)
      assert.equal(db.prepare('SELECT fingerprint FROM work_creation_receipts').get()!.fingerprint, 'a'.repeat(64))
    } finally { db.close() }
    assert.deepEqual(JSON.parse(await readFile(jobsPath, 'utf8')).jobs.map((job: { enabled: boolean }) => job.enabled), [false, true])
    assert.deepEqual(await readFile(join(sessionPath, 'fixture.jsonl')), jsonlBefore)
    assert.deepEqual(await readFile(join(sessionPath, 'sessions.sqlite')), sqliteBefore)
    assert.equal((await migrateWorkRecords(home, 'apply', true)).migrated, 0)
  })
})

test('invalid migration leaves original records and scheduler unchanged', async () => {
  await withTempWorkspace(async home => {
    await fixture(home, { ...legacy(), paused: true })
    const path = join(home, 'state', 'work.sqlite'), jobsPath = join(home, 'state', 'cron', 'jobs.json')
    const before = await readFile(path), jobsBefore = await readFile(jobsPath)
    await assert.rejects(migrateWorkRecords(home, 'apply', true), /Paused/)
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readFile(jobsPath), jobsBefore)
  })
})

test('staged graph validation fails before changing the original database or scheduler', async () => {
  await withTempWorkspace(async home => {
    await fixture(home, { ...legacy(), workflow: { ...legacy().workflow, parentKey: key } })
    const path = join(home, 'state', 'work.sqlite'), jobsPath = join(home, 'state', 'cron', 'jobs.json')
    const before = await readFile(path), jobsBefore = await readFile(jobsPath)
    await assert.rejects(migrateWorkRecords(home, 'apply', true), /cycle|parent/i)
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readFile(jobsPath), jobsBefore)
  })
})

test('unfinished effects cannot be migrated or replayed', async () => {
  await withTempWorkspace(async home => {
    await fixture(home)
    const path = join(home, 'state', 'work.sqlite'), jobsPath = join(home, 'state', 'cron', 'jobs.json')
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO work_effects VALUES (?,?,?,?,?)').run('effect', 'web:worker', 'shell', 'pending', '[]')
    db.close()
    const before = await readFile(path), jobsBefore = await readFile(jobsPath)
    await assert.rejects(migrateWorkRecords(home, 'apply', true), /Unfinished/)
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readFile(jobsPath), jobsBefore)
  })
})
