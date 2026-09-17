import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { InitiativeStore, type InitiativeStoreOptions } from './store.ts'
import { parseSql } from './sql.ts'

function fixture(t: TestContext, isSessionActive?: (id: string) => boolean | undefined, isSessionKnown?: InitiativeStoreOptions['isSessionKnown']) {
  const home = resolve('src', 'initiatives', `.test-${randomUUID()}`)
  const store = new InitiativeStore(home, { isSessionActive, isSessionKnown })
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }) })
  const query = (sql: string, actor = 'owner') => store.query(sql, actor)
  const rows = (sql: string, actor = 'owner') => query(sql, actor).results[0]!.rows
  const create = (id = 'build') => query(`INSERT INTO initiatives (id,title,goal,context) VALUES ('${id}','Build app','Ship it','# Notes\nMarkdown context')`)
  const item = (id: string, initiative = 'build') => query(`INSERT INTO initiative_items (id,initiative_id,title) VALUES ('${id}','${initiative}','${id}')`)
  return { home, store, query, rows, create, item }
}

test('CRUD, actor stamping, append-only audit, revisions, and reopen', (t) => {
  const f = fixture(t)
  f.create()
  f.item('implement')
  assert.equal(f.query("UPDATE initiatives SET goal='Ship safely' WHERE id='build'").changes, 1)
  const initiative = f.rows("SELECT * FROM initiatives WHERE id='build'")[0]!
  assert.equal(initiative.owner_session_id, 'owner')
  assert.equal(initiative.created_by_session_id, 'owner')
  assert.equal(initiative.revision, 2)
  f.query("INSERT INTO initiative_entries (initiative_id,kind,content) VALUES ('build','note','Other session''s note')", 'collaborator')
  const entry = f.rows("SELECT * FROM initiative_entries WHERE kind='note'")[0]!
  assert.equal(entry.author_session_id, 'collaborator')
  assert.equal(entry.content, "Other session's note")
  assert.equal(f.rows("SELECT * FROM initiative_entries WHERE kind='audit'").length, 4)
  assert.match(f.store.getSummary('build')!, /Ship safely/)
  assert.equal(f.store.getSummary('unknown'), null)
  f.store.close()
  const reopened = new InitiativeStore(f.home)
  try { assert.equal(reopened.query('SELECT * FROM initiatives', 'reader').results[0]!.rows[0]!.goal, 'Ship safely') }
  finally { reopened.close() }
  assert.throws(() => f.query('SELECT * FROM initiatives'), /closed/)
  assert.throws(() => f.store.migrateLegacyMarkdown(), /closed/)
})

test('independent Project Home databases cannot observe or modify one another', (t) => {
  const a = fixture(t), b = fixture(t)
  a.create()
  assert.deepEqual(b.rows('SELECT * FROM initiatives'), [])
  b.create()
  b.query("UPDATE initiatives SET goal='Other Project' WHERE id='build'")
  assert.equal(a.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
  assert.equal(b.rows('SELECT goal FROM initiatives')[0]!.goal, 'Other Project')
  assert.throws(() => a.store.migrateLegacy(join(b.home, 'projects')), /this Project/)
})

test('work reference validation is Project-local, read-only and checks the item parent', (t) => {
  const f = fixture(t), other = fixture(t)
  f.create(); f.create('second'); f.item('work')
  other.create('foreign'); other.item('foreign-work', 'foreign')
  const before = f.rows('SELECT * FROM initiatives')
  const items = f.rows('SELECT * FROM initiative_items')
  const entries = f.rows('SELECT * FROM initiative_entries')
  f.store.assertWorkReference('build')
  f.store.assertWorkReference('build', 'work')
  assert.throws(() => f.store.assertWorkReference('foreign'), /Unknown initiative in this Project: foreign/)
  assert.throws(() => f.store.assertWorkReference('build', 'foreign-work'), /Unknown initiative item in this Project: foreign-work/)
  assert.throws(() => f.store.assertWorkReference('second', 'work'), /does not belong to initiative "second"/)
  assert.throws(() => f.store.assertWorkReference('../build'), /slug/)
  assert.throws(() => f.store.assertWorkReference('build', ''), /slug/)
  assert.deepEqual(f.rows('SELECT * FROM initiatives'), before)
  assert.deepEqual(f.rows('SELECT * FROM initiative_items'), items)
  assert.deepEqual(f.rows('SELECT * FROM initiative_entries'), entries)
  const writer = new DatabaseSync(join(f.home, 'initiatives.sqlite'))
  try {
    writer.exec('BEGIN IMMEDIATE')
    f.store.assertWorkReference('build', 'work')
  } finally { writer.exec('ROLLBACK'); writer.close() }
  f.query("UPDATE initiatives SET status='cancelled' WHERE id='build'")
  f.store.assertWorkReference('build', 'work')
  f.store.close()
  assert.throws(() => f.store.assertWorkReference('build'), /closed/)
})

test('session summaries include only explicit owner, creator, or assignee relationships', (t) => {
  const f = fixture(t)
  f.create('created'); f.create('assigned'); f.create('unrelated')
  f.query("UPDATE initiatives SET owner_session_id='other' WHERE id='created' AND owner_session_id='owner'")
  f.item('work', 'assigned')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  f.query("INSERT INTO initiatives (id,title,goal) VALUES ('worker-created','Worker created','Worker goal')", 'worker')
  f.query("INSERT INTO initiatives (id,title,goal) VALUES ('worker-owned','Worker owned','Owner goal')", 'other')
  f.query("UPDATE initiatives SET owner_session_id='worker' WHERE id='worker-owned' AND owner_session_id='other'", 'other')
  assert.match(f.store.getSessionSummary('owner')!, /\(created\)/)
  const workerSummary = f.store.getSessionSummary('worker')!
  assert.match(workerSummary, /\(assigned\)/)
  assert.match(workerSummary, /work: \[pending\]/)
  assert.match(workerSummary, /\(worker-created\)/)
  assert.match(workerSummary, /\(worker-owned\)/)
  assert.doesNotMatch(workerSummary, /\(unrelated\)|\(created\)/)
  assert.equal(f.store.getSessionSummary('uninvolved'), null)
  f.query("UPDATE initiatives SET status='completed' WHERE id='worker-created'", 'worker')
  assert.doesNotMatch(f.store.getSessionSummary('worker')!, /\(worker-created\)/)
  f.store.close()
  assert.throws(() => f.store.getSessionSummary('worker'), /closed/)
})

test('session summary initiative count and output are bounded', (t) => {
  const f = fixture(t)
  for (let index = 0; index < 8; index++) {
    f.create(`initiative-${index}`)
    f.query(`UPDATE initiatives SET context='${'文'.repeat(15_000)}' WHERE id='initiative-${index}'`)
  }
  const summary = f.store.getSessionSummary('owner')!
  assert.equal(summary.match(/# Initiative:/g)?.length, 5)
  assert.match(summary, /More related initiatives omitted/)
  assert.ok(Buffer.byteLength(summary) <= 32_768)
  assert.match(summary, /Summary truncated/)
})

test('multi-statement writes and their audit entries all roll back on failure', (t) => {
  const f = fixture(t)
  f.create()
  const before = f.rows('SELECT * FROM initiative_entries')
  assert.throws(() => f.query("UPDATE initiatives SET goal='not committed' WHERE id='build'; INSERT INTO initiatives (id) VALUES ('build')"), /UNIQUE/)
  assert.equal(f.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
  assert.deepEqual(f.rows('SELECT * FROM initiative_entries'), before)
  assert.throws(() => f.query("UPDATE initiatives SET goal='not committed' WHERE id='build'; SELECT * FROM sqlite_master"), /Unknown/)
  assert.equal(f.rows('SELECT revision FROM initiatives')[0]!.revision, 1)
})

test('closed SQL grammar blocks other databases, DDL, expressions, audit spoofing and system writes', (t) => {
  const f = fixture(t)
  f.create()
  const illegal = [
    "ATTACH DATABASE 'other.sqlite' AS other", 'PRAGMA user_version', 'DROP TABLE initiatives',
    'CREATE TABLE secrets (id)', 'ALTER TABLE initiatives ADD COLUMN secret TEXT',
    'SELECT * FROM main.initiatives', 'SELECT * FROM sqlite_master', 'SELECT * FROM initiative_legacy_imports',
    "SELECT load_extension('x') FROM initiatives", 'SELECT randomblob(1000000000) FROM initiatives',
    'WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x',
    'SELECT * FROM initiatives JOIN initiatives', 'SELECT * FROM initiatives UNION SELECT * FROM initiatives',
    "SELECT * FROM initiatives WHERE id IN (SELECT id FROM initiatives)",
    'SELECT * FROM initiatives -- comment', 'SELECT * FROM initiatives /* comment */',
    "SELECT * FROM initiatives WHERE id='build' OR 1=1", 'SELECT * FROM initiatives LIMIT 1 OFFSET 1',
    "UPDATE initiatives SET created_by_session_id='spoof' WHERE id='build'",
    "UPDATE initiatives SET updated_at='spoof' WHERE id='build'",
    "UPDATE initiatives SET revision=88 WHERE id='build'",
    "UPDATE initiatives SET id='renamed' WHERE id='build'",
    "INSERT INTO initiatives (id,created_by_session_id) VALUES ('x','spoof')",
    "INSERT INTO initiatives (id,owner_session_id) VALUES ('x','spoof')",
    "INSERT INTO initiative_entries (initiative_id,author_session_id,kind,content) VALUES ('build','spoof','note','text')",
    "INSERT INTO initiative_entries (initiative_id,kind,content) VALUES ('build','audit','fake audit')",
    "UPDATE initiative_entries SET content='replace history' WHERE initiative_id='build'",
    "DELETE FROM initiative_entries WHERE initiative_id='build'",
    "DELETE FROM initiatives WHERE id='build'",
    "DELETE FROM initiative_items WHERE id='anything'",
    "UPDATE initiative_handoffs SET title='bad' WHERE id='build'",
    "UPDATE initiatives SET goal='no where'",
    "SELECT * FROM constructor",
  ]
  for (const sql of illegal) assert.throws(() => f.query(sql), sql)
  assert.equal(f.rows('SELECT revision FROM initiatives')[0]!.revision, 1)
  assert.equal(f.rows('SELECT * FROM initiative_entries').length, 1)
})

test('string literal parsing does not reinterpret SQL text as commands', (t) => {
  const f = fixture(t)
  f.create()
  const text = "SELECT *; DROP TABLE initiatives; -- don't execute"
  f.query(`UPDATE initiatives SET context='${text.replaceAll("'", "''")}' WHERE id='build'`)
  assert.equal(f.rows('SELECT context FROM initiatives')[0]!.context, text)
  assert.throws(() => parseSql("SELECT * FROM initiatives WHERE id='unfinished"), /Unterminated/)
  assert.throws(() => parseSql('SELECT * FROM initiatives; ;'), /identifier/)
  assert.throws(() => parseSql("INSERT INTO initiatives (id,id) VALUES ('a','b')"), /Invalid/)
})

test('dependency readiness, self/cycle rejection, cross-initiative references and edge deletion', (t) => {
  const f = fixture(t)
  f.create(); f.create('second')
  for (const id of ['a', 'b', 'c']) f.item(id)
  f.item('foreign', 'second')
  f.query("INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('a','b'); INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('b','c')")
  assert.deepEqual(f.rows("SELECT id FROM initiative_ready_items WHERE initiative_id='build'"), [{ id: 'c' }])
  for (const sql of [
    "INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('c','a')",
    "INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('a','a')",
    "INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('a','foreign')",
    "INSERT INTO initiative_entries (initiative_id,item_id,kind,content) VALUES ('second','a','note','Wrong parent')",
    "INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('a','missing')",
    "INSERT INTO initiative_items (id,initiative_id,title) VALUES ('invalid','missing','Invalid')",
  ]) assert.throws(() => f.query(sql))
  assert.equal(f.rows('SELECT * FROM initiative_item_deps').length, 2)
  f.query("UPDATE initiative_items SET status='done' WHERE id='c'")
  assert.deepEqual(f.rows("SELECT id FROM initiative_ready_items WHERE initiative_id='build'"), [{ id: 'b' }])
  assert.equal(f.query("DELETE FROM initiative_item_deps WHERE item_id='a' AND depends_on_item_id='b'").changes, 1)
  assert.deepEqual(f.rows("SELECT id FROM initiative_ready_items WHERE initiative_id='build' ORDER BY id"), [{ id: 'a' }, { id: 'b' }])
})

test('conditional claims are atomic across separate database connections', (t) => {
  const f = fixture(t, () => true)
  f.create(); f.item('work')
  const second = new InitiativeStore(f.home, { isSessionActive: () => true })
  const sql = "UPDATE initiative_items SET assignee_session_id=actor_session_id(),status='in_progress' WHERE id='work' AND assignee_session_id IS NULL"
  assert.equal(f.query(sql, 'worker-a').changes, 1)
  try { assert.equal(second.query(sql, 'worker-b').changes, 0) }
  finally { second.close() }
  assert.equal(f.rows('SELECT assignee_session_id FROM initiative_items')[0]!.assignee_session_id, 'worker-a')
  assert.equal(f.rows('SELECT id FROM initiative_session_todos', 'worker-a')[0]!.id, 'work')
  assert.deepEqual(f.rows('SELECT id FROM initiative_session_todos', 'worker-b'), [])
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker-a'", 'worker-b'), /recorded assignment/)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker-a'", 'owner'), /recorded assignment/)
  assert.throws(() => f.query("UPDATE initiative_items SET status='done' WHERE id='work'", 'owner'), /current assignee/)
  assert.equal(f.query("UPDATE initiative_items SET status='done' WHERE id='work'", 'worker-a').changes, 1)
})

test('inactive owners can explicitly hand off and assignees release work but cannot be displaced', (t) => {
  const activity = new Map<string, boolean>()
  const f = fixture(t, (id) => activity.get(id))
  f.create(); f.item('work')
  assert.deepEqual(f.rows('SELECT * FROM initiative_handoffs'), [])
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='owner'", 'taker'), /owner/)
  activity.set('owner', false)
  assert.deepEqual(f.rows('SELECT id,owner_activity,needs_attention,needs_handoff FROM initiative_handoffs'), [
    { id: 'build', owner_activity: 'inactive', needs_attention: 1, needs_handoff: 1 },
  ])
  assert.match(f.store.getSummary('build')!, /needs_attention/)
  assert.equal(f.rows('SELECT status,owner_session_id FROM initiatives')[0]!.status, 'active')
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build'", 'taker'), /WHERE guard/)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id(),goal='smuggled' WHERE id='build' AND revision=1", 'taker'), /owner/)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='owner'", 'taker'), /owner/)
  assert.equal(f.query("UPDATE initiatives SET owner_session_id='taker' WHERE id='build' AND owner_session_id='owner'").changes, 1)
  assert.deepEqual(f.rows('SELECT * FROM initiative_handoffs'), [])
  f.query("UPDATE initiatives SET owner_session_id='new-owner' WHERE id='build' AND owner_session_id='taker'", 'taker')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL", 'new-owner')
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker'", 'taker'), /recorded assignment/)
  activity.set('worker', false)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker'", 'taker'), /recorded assignment/)
  f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND assignee_session_id='worker'", 'worker')
  assert.equal(f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id IS NULL", 'taker').changes, 1)
  f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND assignee_session_id='taker'", 'taker')
  assert.equal(f.rows('SELECT assignee_session_id FROM initiative_items')[0]!.assignee_session_id, null)
})

test('sleep, idle, recovery and unknown runtime activity never authorize takeover or owner status edits', (t) => {
  let activity: boolean | undefined = true
  const f = fixture(t, () => activity)
  f.create(); f.item('work')
  f.query("UPDATE initiative_items SET assignee_session_id='worker',status='in_progress' WHERE id='work' AND assignee_session_id IS NULL")
  const initiatives = f.rows('SELECT * FROM initiatives')
  const items = f.rows('SELECT * FROM initiative_items')
  const entries = f.rows('SELECT * FROM initiative_entries')
  for (const state of [false, undefined, true, false, undefined]) {
    activity = state
    for (const actor of ['coordinator', 'worker']) {
      assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND revision=1", actor), /owner/)
      assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=NULL WHERE id='build' AND owner_session_id='owner'", actor), /owner/)
    }
    for (const actor of ['owner', 'coordinator']) {
      assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND revision=2", actor), /recorded assignment/)
      assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND assignee_session_id='worker'", actor), /current assignee/)
      assert.throws(() => f.query("UPDATE initiative_items SET status='done' WHERE id='work'", actor), /assignee/)
      assert.throws(() => f.query("UPDATE initiative_items SET status='blocked',blocked_reason='Stopped' WHERE id='work'", actor), /assignee/)
    }
  }
  assert.deepEqual(f.rows('SELECT * FROM initiatives'), initiatives)
  assert.deepEqual(f.rows('SELECT * FROM initiative_items'), items)
  assert.deepEqual(f.rows('SELECT * FROM initiative_entries'), entries)
  f.store.close()
  for (const isSessionActive of [undefined, () => false, () => undefined]) {
    const reopened = new InitiativeStore(f.home, { isSessionActive })
    try {
      assert.throws(() => reopened.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='owner'", 'coordinator'), /owner/)
      assert.throws(() => reopened.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker'", 'owner'), /recorded assignment/)
      assert.deepEqual(reopened.query('SELECT * FROM initiative_items', 'worker').results[0]!.rows, items)
      assert.deepEqual(reopened.query('SELECT * FROM initiatives', 'worker').results[0]!.rows, initiatives)
    } finally { reopened.close() }
  }
})

test('explicit release, claim and owner handoff require guards and roll back together with audit', (t) => {
  const f = fixture(t, () => { throw new Error('Activity must not authorize work changes') })
  f.create(); f.item('work')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work'", 'worker'), /WHERE guard/)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id='next' WHERE id='build'"), /WHERE guard/)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=NULL WHERE id='build'"), /WHERE guard/)
  assert.equal(f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND revision=1", 'worker').changes, 0)
  assert.equal(f.query("UPDATE initiatives SET owner_session_id='next' WHERE id='build' AND owner_session_id='stale'").changes, 0)
  const before = f.rows('SELECT * FROM initiative_entries')
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND assignee_session_id='worker'; UPDATE initiatives SET goal='forbidden' WHERE id='build'", 'worker'), /owner/)
  assert.deepEqual(f.rows('SELECT * FROM initiative_entries'), before)
  assert.equal(f.rows('SELECT assignee_session_id FROM initiative_items')[0]!.assignee_session_id, 'worker')
  f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND revision=2", 'worker')
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work'", 'peer'), /WHERE guard/)
  assert.equal(f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id IS NULL", 'peer').changes, 1)
  f.query("UPDATE initiatives SET owner_session_id='next' WHERE id='build' AND revision=1")
  assert.throws(() => f.query("UPDATE initiatives SET goal='former owner' WHERE id='build'"), /owner/)
  f.query("UPDATE initiatives SET owner_session_id=NULL WHERE id='build' AND owner_session_id='next'", 'next')
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id(),goal='smuggled' WHERE id='build' AND owner_session_id IS NULL", 'peer'), /owner/)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build'", 'peer'), /WHERE guard/)
  assert.equal(f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id IS NULL", 'peer').changes, 1)
  assert.equal(f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id IS NULL", 'next').changes, 0)
  assert.equal(f.rows('SELECT owner_session_id FROM initiatives')[0]!.owner_session_id, 'peer')
  const updates = f.rows("SELECT content FROM initiative_entries WHERE kind='audit'").map((entry) => JSON.parse(String(entry.content)))
  assert.ok(updates.some((entry) => entry.before?.assignee_session_id === 'worker' && entry.after.assignee_session_id === null))
  assert.ok(updates.some((entry) => entry.before?.owner_session_id === 'owner' && entry.after.owner_session_id === 'next'))
})

test('inactive assignees retain content and status rights but cannot edit structure or delegate', (t) => {
  const f = fixture(t, () => false)
  f.create(); f.item('work'); f.item('dependency')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  f.query("UPDATE initiative_items SET title='Revised work',status='blocked',blocked_reason='Waiting' WHERE id='work'", 'worker')
  assert.throws(() => f.query("UPDATE initiative_items SET status='done' WHERE id='work'", 'worker'), /blocked_reason/)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id='peer' WHERE id='work' AND assignee_session_id='worker'", 'worker'), /delegate/)
  assert.throws(() => f.query("INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('work','dependency')", 'worker'), /owner/)
  assert.throws(() => f.query("UPDATE initiatives SET context='unauthorized' WHERE id='build'", 'worker'), /owner/)
  f.query("UPDATE initiative_items SET status='done',blocked_reason=NULL WHERE id='work'", 'worker')
  assert.equal(f.rows("SELECT title FROM initiative_items WHERE id='work'")[0]!.title, 'Revised work')
})

test('handoff notes are coordination history, not ownership or assignment changes', (t) => {
  const f = fixture(t, () => false)
  f.create(); f.item('work')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  const initiatives = f.rows('SELECT * FROM initiatives')
  const items = f.rows('SELECT * FROM initiative_items')
  f.query("INSERT INTO initiative_entries (initiative_id,item_id,kind,content) VALUES ('build','work','handoff','Please take this work, coordinator.')", 'worker')
  f.query("INSERT INTO initiative_entries (initiative_id,kind,content) VALUES ('build','handoff','I request coordinator assistance.')")
  assert.deepEqual(f.rows('SELECT * FROM initiatives'), initiatives)
  assert.deepEqual(f.rows('SELECT * FROM initiative_items'), items)
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='owner'", 'coordinator'), /owner/)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='work' AND assignee_session_id='worker'", 'coordinator'), /recorded assignment/)
})

test('new assignment and ownership targets must belong to the current Project when configured', (t) => {
  const known = new Set(['owner', 'worker', 'new-owner'])
  const f = fixture(t, (id) => known.has(id), (id) => known.has(id))
  f.create(); f.item('work')
  assert.throws(() => f.query("INSERT INTO initiatives (id) VALUES ('foreign-created')", 'another-project-session'), /not known in this Project/)
  assert.throws(() => f.query("INSERT INTO initiative_items (id,initiative_id,title,assignee_session_id) VALUES ('bad','build','Bad','missing')"), /not known in this Project/)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id='another-project-session' WHERE id='work' AND assignee_session_id IS NULL"), /not known in this Project/)
  assert.throws(() => f.query("UPDATE initiatives SET goal='rolled back' WHERE id='build'; UPDATE initiatives SET owner_session_id='missing' WHERE id='build' AND owner_session_id='owner'"), /not known in this Project/)
  assert.equal(f.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
  assert.equal(f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL").changes, 1)
  assert.equal(f.query("UPDATE initiatives SET owner_session_id='new-owner' WHERE id='build' AND owner_session_id='owner'").changes, 1)
  known.delete('worker')
  known.delete('new-owner')
  assert.equal(f.rows("SELECT assignee_activity,needs_attention FROM initiative_item_activity WHERE id='work'")[0]!.needs_attention, 1)
  assert.match(f.store.getSummary('build')!, /needs_attention/)
  assert.equal(f.rows('SELECT owner_session_id FROM initiatives')[0]!.owner_session_id, 'new-owner')
  assert.throws(() => f.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='new-owner'"), /owner/)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=NULL WHERE id='work' AND assignee_session_id='worker'", 'new-owner'), /current assignee/)
  assert.equal(f.rows('SELECT assignee_session_id FROM initiative_items')[0]!.assignee_session_id, 'worker')
  writeLegacy(f.home, 'legacy-known-check', legacy('legacy-known-check'))
  assert.deepEqual(f.store.migrateLegacyMarkdown(), { imported: 1, skipped: 0 })
  assert.equal(f.rows("SELECT owner_session_id FROM initiatives WHERE id='legacy-known-check'")[0]!.owner_session_id, null)
})

test('item activity exposes stopped assignees under a live coordinator without mutating work', (t) => {
  const activity = new Map<string, boolean>([['owner', true], ['worker', true]])
  const f = fixture(t, (id) => activity.get(id))
  f.create()
  f.item('work'); f.item('unknown-work'); f.item('unassigned-work')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  f.query("UPDATE initiative_items SET assignee_session_id='unknown' WHERE id='unknown-work' AND assignee_session_id IS NULL")
  assert.equal(f.rows("SELECT assignee_activity FROM initiative_item_activity WHERE id='work'")[0]!.assignee_activity, 'active')
  const before = f.rows('SELECT * FROM initiative_items')
  const auditCount = f.rows('SELECT * FROM initiative_entries').length
  activity.set('worker', false)
  assert.deepEqual(f.rows("SELECT assignee_activity,needs_attention,needs_handoff FROM initiative_item_activity WHERE id='work'"), [{ assignee_activity: 'inactive', needs_attention: 1, needs_handoff: 1 }])
  assert.deepEqual(f.rows("SELECT assignee_activity,needs_handoff FROM initiative_item_activity WHERE id='unknown-work'"), [{ assignee_activity: 'unknown', needs_handoff: 0 }])
  assert.deepEqual(f.rows("SELECT assignee_activity,needs_handoff FROM initiative_item_activity WHERE id='unassigned-work'"), [{ assignee_activity: 'unassigned', needs_handoff: 0 }])
  assert.deepEqual(f.rows('SELECT * FROM initiative_handoffs'), [])
  assert.match(f.store.getSummary('build')!, /assignee: worker; activity: inactive; needs_attention; assignment retained/)
  assert.match(f.store.getSessionSummary('owner')!, /assignee worker — inactive; needs_attention \(not claimable\)/)
  assert.match(f.store.getSessionSummary('worker')!, /activity: inactive; needs_attention; assignment retained/)
  assert.doesNotMatch(f.store.getSummary('build')!, /needs-handoff/)
  assert.match(f.store.getSessionSummary('unknown')!, /activity: unknown/)
  assert.deepEqual(f.rows('SELECT * FROM initiative_items'), before)
  assert.equal(f.rows('SELECT * FROM initiative_entries').length, auditCount)
  assert.throws(() => f.query("UPDATE initiative_items SET assignee_session_id=actor_session_id() WHERE id='unknown-work' AND assignee_session_id='unknown'", 'taker'), /recorded assignment/)
  assert.throws(() => f.query("UPDATE initiative_item_activity SET assignee_session_id=actor_session_id() WHERE id='work'"), /read-only/)
  f.query("UPDATE initiative_items SET status='done' WHERE id='work'", 'worker')
  assert.equal(f.rows("SELECT needs_handoff FROM initiative_item_activity WHERE id='work'")[0]!.needs_handoff, 0)
})

test('completing initiatives requires terminal items and satisfied dependencies of done work', (t) => {
  const f = fixture(t)
  f.create(); f.item('work'); f.item('prerequisite')
  f.query("INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('work','prerequisite')")
  for (const status of ['pending', 'in_progress', 'blocked']) {
    f.query(`UPDATE initiative_items SET status='${status}',blocked_reason=${status === 'blocked' ? "'Waiting'" : 'NULL'} WHERE id='work'`)
    assert.throws(() => f.query("UPDATE initiatives SET status='completed' WHERE id='build'"), /nonterminal/)
    assert.equal(f.rows('SELECT status FROM initiatives')[0]!.status, 'active')
  }
  f.query("UPDATE initiative_items SET status='done',blocked_reason=NULL WHERE id='work'; UPDATE initiative_items SET status='cancelled' WHERE id='prerequisite'")
  assert.throws(() => f.query("UPDATE initiatives SET status='completed' WHERE id='build'"), /unsatisfied dependencies/)
  f.query("UPDATE initiative_items SET status='done' WHERE id='prerequisite'; UPDATE initiatives SET status='completed' WHERE id='build'")
  assert.equal(f.rows('SELECT status FROM initiatives')[0]!.status, 'completed')
  f.create('cancelled-work')
  f.item('cancelled-a', 'cancelled-work'); f.item('cancelled-b', 'cancelled-work')
  f.query("INSERT INTO initiative_item_deps (item_id,depends_on_item_id) VALUES ('cancelled-a','cancelled-b'); UPDATE initiative_items SET status='cancelled' WHERE initiative_id='cancelled-work'; UPDATE initiatives SET status='completed' WHERE id='cancelled-work'")
  assert.equal(f.rows("SELECT status FROM initiatives WHERE id='cancelled-work'")[0]!.status, 'completed')
})

for (const version of [1, 2]) test(`version-${version} databases gain attention views without releasing assignments`, (t) => {
  const f = fixture(t)
  f.create(); f.item('work')
  f.query("UPDATE initiative_items SET assignee_session_id='worker' WHERE id='work' AND assignee_session_id IS NULL")
  const initiatives = f.rows('SELECT * FROM initiatives')
  const items = f.rows('SELECT * FROM initiative_items')
  const entries = f.rows('SELECT * FROM initiative_entries')
  f.store.close()
  const db = new DatabaseSync(join(f.home, 'initiatives.sqlite'))
  db.exec(`DROP VIEW initiative_item_activity; DROP VIEW initiative_handoffs;
    CREATE VIEW initiative_handoffs AS SELECT p.*, 1 AS needs_handoff FROM initiatives p
      WHERE p.status='active' AND (p.owner_session_id IS NULL OR session_is_inactive(p.owner_session_id)=1);
    ${version === 2 ? `CREATE VIEW initiative_item_activity AS SELECT i.*,
      session_activity(i.assignee_session_id) AS assignee_activity,
      CASE WHEN i.status IN ('pending','in_progress','blocked') AND session_activity(i.assignee_session_id)='inactive'
      THEN 1 ELSE 0 END AS needs_handoff FROM initiative_items i;` : ''}
    PRAGMA user_version=${version}`)
  db.close()
  const reopened = new InitiativeStore(f.home, { isSessionActive: () => false })
  try {
    const rows = (sql: string) => reopened.query(sql, 'owner').results[0]!.rows
    assert.deepEqual(rows('SELECT id,assignee_activity,needs_attention,needs_handoff FROM initiative_item_activity'), [
      { id: 'work', assignee_activity: 'inactive', needs_attention: 1, needs_handoff: 1 },
    ])
    assert.deepEqual(rows('SELECT owner_activity,needs_attention,needs_handoff FROM initiative_handoffs'), [
      { owner_activity: 'inactive', needs_attention: 1, needs_handoff: 1 },
    ])
    assert.deepEqual(rows('SELECT * FROM initiatives'), initiatives)
    assert.deepEqual(rows('SELECT * FROM initiative_items'), items)
    assert.deepEqual(rows('SELECT * FROM initiative_entries'), entries)
    assert.throws(() => reopened.query("UPDATE initiatives SET owner_session_id=actor_session_id() WHERE id='build' AND owner_session_id='owner'", 'peer'), /owner/)
  } finally { reopened.close() }
})

test('ownership, item state consistency and completed initiative controls', (t) => {
  const f = fixture(t)
  f.create(); f.item('work')
  assert.throws(() => f.query("UPDATE initiatives SET title='Unauthorized' WHERE id='build'", 'stranger'), /owner/)
  assert.throws(() => f.query("INSERT INTO initiative_items (id,initiative_id,title) VALUES ('bad','build','Bad')", 'stranger'), /owner/)
  assert.throws(() => f.query("UPDATE initiative_items SET status='blocked' WHERE id='work'"), /blocked_reason/)
  f.query("UPDATE initiative_items SET status='blocked',blocked_reason='Waiting for API' WHERE id='work'")
  assert.throws(() => f.query("UPDATE initiative_items SET status='done' WHERE id='work'"), /blocked_reason/)
  f.query("UPDATE initiative_items SET status='done',blocked_reason=NULL WHERE id='work'")
  f.query("UPDATE initiatives SET status='completed' WHERE id='build'")
  assert.deepEqual(f.rows('SELECT * FROM initiative_ready_items'), [])
  assert.throws(() => f.query("UPDATE initiative_items SET title='No active work' WHERE id='work'"), /not active/)
})

test('query, statement, output, field, and abort bounds roll back mutations', (t) => {
  const f = fixture(t)
  f.create()
  assert.throws(() => f.query('SELECT * FROM initiatives'.repeat(4000)), /65536/)
  assert.throws(() => f.query(Array(21).fill('SELECT * FROM initiatives').join(';')), /20 statements/)
  assert.throws(() => f.query('SELECT * FROM initiatives LIMIT 201'), /LIMIT/)
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => f.store.query("UPDATE initiatives SET goal='aborted' WHERE id='build'", 'owner', controller.signal), /abort/i)
  const long = 'x'.repeat(60_000)
  f.query(`UPDATE initiatives SET context='${long}' WHERE id='build'`)
  assert.throws(() => f.query("UPDATE initiatives SET goal='rollback' WHERE id='build'; SELECT * FROM initiatives; SELECT * FROM initiatives; SELECT * FROM initiatives; SELECT * FROM initiatives; SELECT * FROM initiatives"), /byte limit/)
  assert.equal(f.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
  assert.throws(() => f.query("UPDATE initiatives SET context='nul\0character' WHERE id='build'"), /NUL/)
})

test('aggregate row and mutation limits cannot partially commit work', (t) => {
  const f = fixture(t)
  f.create()
  for (let start = 0; start < 201; start += 20) {
    const statements = []
    for (let index = start; index < Math.min(start + 20, 201); index++) {
      statements.push(`INSERT INTO initiative_items (id,initiative_id,title) VALUES ('work-${index}','build','Work')`)
    }
    f.query(statements.join(';'))
  }
  assert.equal(f.rows('SELECT * FROM initiative_items').length, 200)
  assert.throws(() => f.query("UPDATE initiative_items SET title='Too many' WHERE initiative_id='build'"), /Mutation row limit/)
  assert.throws(() => f.query("UPDATE initiatives SET goal='not persisted' WHERE id='build'; SELECT id FROM initiative_items; SELECT id FROM initiative_items LIMIT 1"), /row\/change limit/)
  assert.equal(f.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
  assert.equal(f.rows("SELECT * FROM initiative_items WHERE title='Too many'").length, 0)
})

test('aborting from lifecycle callback rolls back the entire query', (t) => {
  const controller = new AbortController()
  const f = fixture(t, () => { controller.abort(); return false })
  f.create()
  assert.throws(() => f.store.query("UPDATE initiatives SET goal='not persisted' WHERE id='build'; SELECT * FROM initiative_handoffs", 'owner', controller.signal), /abort/i)
  assert.equal(f.rows('SELECT goal FROM initiatives')[0]!.goal, 'Ship it')
})

function legacy(slug: string, status = 'active'): string {
  return `# Project: ${slug}\n\n**Status**: ${status}\n${status === 'completed' ? '**Completed**: 2026-09-15T00:00:00.000Z\n' : ''}**Created**: 2026-09-01T00:00:00.000Z\n**Goal**: Legacy goal\n\n## Context\n\nLegacy **Markdown** context\n\n## Progress\n\nCompleted phase one\n\n## Notes\n\nImportant notes\n`
}

function writeLegacy(home: string, slug: string, content: string): string {
  const directory = join(home, 'projects', slug)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'project.md')
  writeFileSync(file, content)
  return file
}

test('legacy migration preserves originals, imports context/history, is idempotent after reopen', (t) => {
  const f = fixture(t)
  const file = writeLegacy(f.home, 'legacy', legacy('legacy'))
  writeLegacy(f.home, 'finished', legacy('finished', 'completed'))
  assert.deepEqual(f.store.migrateLegacyMarkdown(), { imported: 2, skipped: 0 })
  assert.equal(readFileSync(file, 'utf8'), legacy('legacy'))
  const imported = f.rows("SELECT * FROM initiatives WHERE id='legacy'")[0]!
  assert.equal(imported.owner_session_id, null)
  assert.equal(imported.created_by_session_id, 'legacy-import')
  assert.equal(imported.context, 'Legacy **Markdown** context')
  assert.equal(f.rows("SELECT content FROM initiative_entries WHERE initiative_id='legacy' AND kind='legacy'")[0]!.content, legacy('legacy'))
  assert.equal(f.rows("SELECT content FROM initiative_entries WHERE initiative_id='legacy' AND kind='progress'")[0]!.content, 'Completed phase one')
  assert.equal(f.rows("SELECT content FROM initiative_entries WHERE initiative_id='legacy' AND kind='note'")[0]!.content, 'Important notes')
  assert.equal(f.rows("SELECT status FROM initiatives WHERE id='finished'")[0]!.status, 'completed')
  assert.deepEqual(f.store.migrateLegacyMarkdown(), { imported: 0, skipped: 2 })
  f.store.close()
  const reopened = new InitiativeStore(f.home)
  try {
    assert.deepEqual(reopened.migrateLegacyMarkdown(), { imported: 0, skipped: 2 })
    assert.match(reopened.getSummary('legacy')!, /needs_attention/)
    assert.doesNotMatch(reopened.getSummary('finished')!, /needs_attention/)
    writeFileSync(file, legacy('legacy') + 'Edited old truth')
    assert.throws(() => reopened.migrateLegacyMarkdown(), /archive changed/)
  } finally { reopened.close() }
})

test('malformed, conflicting, or invalid UTF-8 legacy records fail explicitly and atomically', (t) => {
  const f = fixture(t)
  const valid = writeLegacy(f.home, 'a-good', legacy('a-good'))
  const bad = writeLegacy(f.home, 'z-bad', 'arbitrary replacement markdown')
  assert.throws(() => f.store.migrateLegacyMarkdown(), /Malformed/)
  assert.deepEqual(f.rows('SELECT * FROM initiatives'), [])
  assert.equal(readFileSync(valid, 'utf8'), legacy('a-good'))
  assert.equal(readFileSync(bad, 'utf8'), 'arbitrary replacement markdown')
  writeFileSync(bad, Buffer.from([0xff]))
  assert.throws(() => f.store.migrateLegacyMarkdown(), /encoded data/)
  assert.deepEqual(f.rows('SELECT * FROM initiatives'), [])
  writeFileSync(bad, legacy('z-bad'))
  f.create('a-good')
  assert.throws(() => f.store.migrateLegacyMarkdown(), /conflicts/)
})

test('corrupt persisted records fail on reopen rather than being silently repaired', (t) => {
  const f = fixture(t)
  f.create()
  f.store.close()
  const db = new DatabaseSync(join(f.home, 'initiatives.sqlite'))
  db.exec("UPDATE initiatives SET title=''")
  db.close()
  assert.throws(() => new InitiativeStore(f.home), /title/)
})

test('corrupt audit JSON and invalid database bytes are not silently replaced', (t) => {
  const f = fixture(t)
  f.create(); f.store.close()
  const path = join(f.home, 'initiatives.sqlite')
  const db = new DatabaseSync(path)
  db.exec("UPDATE initiative_entries SET content='not JSON' WHERE kind='audit'")
  db.close()
  assert.throws(() => new InitiativeStore(f.home), /Corrupt initiative audit/)
  writeFileSync(path, 'not a SQLite file')
  assert.throws(() => new InitiativeStore(f.home), /not a database/)
  assert.equal(readFileSync(path, 'utf8'), 'not a SQLite file')
})

test('oversized and unsupported databases fail explicitly at reopen', (t) => {
  const f = fixture(t)
  f.store.close()
  const db = new DatabaseSync(join(f.home, 'initiatives.sqlite'))
  const insert = db.prepare("INSERT INTO initiatives VALUES (?, 'Title', '', '', 'active', 'owner', 'owner', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 1)")
  db.exec('BEGIN')
  for (let index = 0; index < 5001; index++) insert.run(`initiative-${index}`)
  db.exec('COMMIT')
  db.close()
  assert.throws(() => new InitiativeStore(f.home), /row limit/)
  const unsupported = new DatabaseSync(join(f.home, 'initiatives.sqlite'))
  unsupported.exec('PRAGMA user_version=999')
  unsupported.close()
  assert.throws(() => new InitiativeStore(f.home), /Unsupported/)
})

test('missing engine authorizer fails closed rather than silently downgrading', (t) => {
  const prototype = DatabaseSync.prototype as DatabaseSync & { setAuthorizer?: unknown }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'setAuthorizer')
  const home = resolve('src', 'initiatives', `.test-${randomUUID()}`)
  t.after(() => rmSync(home, { recursive: true, force: true }))
  Object.defineProperty(prototype, 'setAuthorizer', { value: undefined, configurable: true })
  try {
    assert.throws(() => new InitiativeStore(home), /requires node:sqlite setAuthorizer/)
  } finally {
    if (descriptor) Object.defineProperty(prototype, 'setAuthorizer', descriptor)
    else Reflect.deleteProperty(prototype, 'setAuthorizer')
  }
})

test('engine authorizer denies unauthorized tables, operations, databases and functions', (t) => {
  type Authorizer = (action: number, arg1: string | null, arg2: string | null, database: string | null) => number
  const prototype = DatabaseSync.prototype as unknown as { setAuthorizer: (callback: Authorizer) => void }
  const original = prototype.setAuthorizer
  let authorizer: Authorizer | undefined
  prototype.setAuthorizer = function (callback) {
    authorizer = callback
    original.call(this, callback)
  }
  try { fixture(t) }
  finally { prototype.setAuthorizer = original }
  const codes = constants as unknown as Record<string, number>
  for (const operation of ['SQLITE_ATTACH', 'SQLITE_PRAGMA', 'SQLITE_CREATE_TABLE', 'SQLITE_DROP_TABLE', 'SQLITE_ALTER_TABLE', 'SQLITE_RECURSIVE']) {
    assert.equal(authorizer!(codes[operation]!, null, null, null), codes.SQLITE_DENY, operation)
  }
  assert.equal(authorizer!(codes.SQLITE_READ!, 'sqlite_master', 'name', 'main'), codes.SQLITE_DENY)
  assert.equal(authorizer!(codes.SQLITE_READ!, 'initiatives', 'title', 'other'), codes.SQLITE_DENY)
  assert.equal(authorizer!(codes.SQLITE_FUNCTION!, null, 'load_extension', null), codes.SQLITE_DENY)
  assert.equal(authorizer!(codes.SQLITE_UPDATE!, 'initiative_entries', 'author_session_id', 'main'), codes.SQLITE_DENY)
  assert.equal(authorizer!(codes.SQLITE_READ!, 'initiatives', 'title', 'main'), codes.SQLITE_OK)
})

test('runtime lifecycle callback cannot reenter database or close it mid-query', (t) => {
  let store: InitiativeStore
  const f = fixture(t, () => { store.query('SELECT * FROM initiatives', 'nested'); return false })
  store = f.store
  f.create()
  assert.throws(() => f.query('SELECT * FROM initiative_handoffs'), /Reentrant/)
  assert.equal(f.rows('SELECT * FROM initiatives').length, 1)
})
