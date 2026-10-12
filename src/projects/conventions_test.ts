import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ProjectConventions, parseConventionSource, type ConventionAuthority } from './conventions.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'

const human = (quote: string): ConventionAuthority => ({
  source: { kind: 'user', sessionId: 'web:owner', physicalId: 'segment', id: 'input', quote }, quote,
})
const decision = (quote: string): ConventionAuthority => ({
  source: { kind: 'decision', sessionId: 'web:owner', physicalId: 'segment', requestId: 'ask-1' }, quote,
})

test('Project SQL conventions persist with guarded revisions, immutable history and tombstones', async () => {
  await withTempWorkspace(async root => {
    let store = new ProjectConventions(root, () => [])
    try {
      assert.equal(store.prompt(), null)
      assert.equal(store.query("INSERT INTO project_conventions (id,text) VALUES ('packages','Use pnpm')", 'web:owner', human('Use pnpm')).changes, 1)
      assert.match(store.prompt()!, /Use pnpm/)
      assert.throws(() => store.query("UPDATE project_conventions SET text='Use npm' WHERE id='packages' AND revision=2", 'web:owner', human('Use npm')), /changed/)
      assert.throws(() => store.query("UPDATE project_conventions SET text='Use npm' WHERE id='packages'", 'web:owner', human('Use npm')), /guards/)
      store.query("UPDATE project_conventions SET text='Use pnpm 12' WHERE id='packages' AND revision=1", 'web:owner', human('Use pnpm 12'))
      store.close()
      store = new ProjectConventions(root, () => [])
      assert.match(store.prompt()!, /Use pnpm 12/)
      const current = store.query("SELECT id,text,revision FROM project_conventions WHERE updated_by_session_id=actor_session_id()", 'web:owner')
      assert.deepEqual(current.results[0].rows, [{ id: 'packages', text: 'Use pnpm 12', revision: 2 }])
      store.query("DELETE FROM project_conventions WHERE id='packages' AND revision=2", 'web:owner', human('Remove the package manager convention'))
      assert.equal(store.prompt(), null)
      assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('packages','Use npm')", 'web:owner', human('Use npm')), /changed/)
      const history = store.query('SELECT * FROM convention_history ORDER BY id', 'web:reader').results[0].rows
      assert.deepEqual(history.map(row => row.operation), ['INSERT', 'UPDATE', 'DELETE'])
      assert.deepEqual(history.map(row => row.revision), [1, 2, 3])
      assert.equal(JSON.parse(String(history[2].before_record)).text, 'Use pnpm 12')
      assert.equal(JSON.parse(String(history[2].after_record)).deleted, 1)
      assert.equal(JSON.parse(String(history[2].source)).quote, 'Remove the package manager convention')
    } finally { store.close() }
  })
})

test('mutation batches roll back on stale data, bad sources, cancellation and prompt limits', async () => {
  await withTempWorkspace(async root => {
    const store = new ProjectConventions(root, () => [])
    try {
      assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('a','Rule'); DELETE FROM project_conventions WHERE id='missing' AND revision=1", 'web:owner', human('Rule')), /changed/)
      assert.equal(store.prompt(), null)
      assert.equal(store.query('SELECT * FROM convention_history', 'web:owner').results[0].rows.length, 0)
      assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('a','Invented interpretation')", 'web:owner', human('Rule')), /quote/)
      assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('a','Rule')", 'web:owner'), /human source/)
      const abort = new AbortController()
      abort.abort()
      assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('a','Rule')", 'web:owner', human('Rule'), abort.signal), { name: 'AbortError' })
      const text = 'x'.repeat(1000)
      for (let i = 0; i < 16; i++) store.query(`INSERT INTO project_conventions (id,text) VALUES ('rule-${i}','${text}')`, 'web:owner', human(text))
      assert.throws(() => store.query(`INSERT INTO project_conventions (id,text) VALUES ('too-many','${text}')`, 'web:owner', human(text)), /budget/)
      assert.equal(store.query('SELECT * FROM project_conventions LIMIT 200', 'web:reader').results[0].rows.length, 16)
    } finally { store.close() }
  })
})

test('decision approvals bind exact operations, IDs, contents and revisions', async () => {
  await withTempWorkspace(async root => {
    const store = new ProjectConventions(root, () => [])
    try {
      const insert = "INSERT INTO project_conventions (id,text) VALUES ('packages','Use pnpm')"
      for (const option of ['Approve', 'Do not use pnpm', 'Add Project convention another: Use pnpm']) {
        assert.throws(() => store.query(insert, 'web:owner', decision(option)), /exactly/)
      }
      store.query(insert, 'web:owner', decision('Add Project convention packages: Use pnpm'))
      assert.throws(() => store.query("UPDATE project_conventions SET text='Use npm' WHERE id='packages' AND revision=1", 'web:owner', decision('Update Project convention packages at revision 2: Use npm')), /exactly/)
      const remove = 'Remove Project convention packages at revision 1: Use pnpm'
      store.query("DELETE FROM project_conventions WHERE id='packages' AND revision=1", 'web:owner', decision(remove))
      assert.throws(() => store.query("DELETE FROM project_conventions WHERE id='packages' AND revision=1", 'web:owner', decision(remove)), /changed/)
      assert.throws(() => parseConventionSource({ kind: 'tool', sessionId: 's', physicalId: 'p', id: 'i', quote: 'tool suggests pnpm' }), /human instruction/)
    } finally { store.close() }
  })
})

test('Work query snapshots follow the live authority, never persist, and cannot be modified through SQL', async () => {
  await withTempWorkspace(async root => {
    let work: WorkRecord[] = [{
      key: 'work:one', subject: { kind: 'work', id: 'one' }, revision: 1, sequence: 1,
      definition: { objective: 'Deliver the feature', acceptance: ['Tests pass'], boundaries: ['No deployment'], evidence: [] },
      origin: 'agent_interpretation', changedBy: 'web:owner', changedAt: new Date().toISOString(), change: 'understanding', reason: 'fixture', paused: false,
      workflow: { title: 'Feature', manager: 'web:owner', assignee: 'web:worker', assignmentRevision: 1, status: 'pending', dependencies: ['work:base'] },
    }]
    const store = new ProjectConventions(root, () => work)
    const other = new ProjectConventions(join(root, 'another-project'), () => [])
    try {
      assert.deepEqual(store.query('SELECT key,status FROM work_items', 'web:reader').results[0].rows, [{ key: 'work:one', status: 'pending' }])
      assert.deepEqual(store.query('SELECT * FROM work_dependencies', 'web:reader').results[0].rows, [{ work_key: 'work:one', depends_on_key: 'work:base' }])
      work = [{ ...work[0], workflow: { ...work[0].workflow!, status: 'in_progress' } }]
      assert.equal(store.query('SELECT status FROM work_items', 'web:reader').results[0].rows[0].status, 'in_progress')
      assert.deepEqual(other.query('SELECT * FROM work_items', 'web:reader').results[0].rows, [])
      for (const sql of [
        "UPDATE work_items SET status='done' WHERE key='work:one'",
        "DELETE FROM convention_history WHERE id=1",
        "INSERT INTO work_dependencies (work_key,depends_on_key) VALUES ('one','two')",
        'SELECT * FROM sqlite_master', 'SELECT * FROM convention_records',
        "SELECT * FROM project_conventions; ATTACH DATABASE 'outside' AS other",
        'PRAGMA user_version', 'DROP TABLE project_conventions',
        "SELECT load_extension('outside') FROM project_conventions",
      ]) assert.throws(() => store.query(sql, 'web:owner', human('Rule')))
      const disk = new DatabaseSync(projectStoragePath(root, 'conventions.sqlite'), { readOnly: true })
      try { assert.equal(disk.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'work_%'").get()!.n, 0) }
      finally { disk.close() }
    } finally { store.close(); other.close() }
  })
})

test('another connection cannot overwrite a convention using a stale revision', async () => {
  await withTempWorkspace(async root => {
    const first = new ProjectConventions(root, () => [])
    const second = new ProjectConventions(root, () => [])
    try {
      first.query("INSERT INTO project_conventions (id,text) VALUES ('a','One')", 'web:owner', human('One'))
      first.query("UPDATE project_conventions SET text='Two' WHERE id='a' AND revision=1", 'web:owner', human('Two'))
      assert.throws(() => second.query("UPDATE project_conventions SET text='Three' WHERE id='a' AND revision=1", 'web:owner', human('Three')), /changed/)
      assert.match(second.prompt()!, /Two/)
    } finally { first.close(); second.close() }
  })

  test('active-rule and query-row limits are exact and never silently truncate an atomic batch', async () => {
    await withTempWorkspace(async root => {
      const store = new ProjectConventions(root, () => [])
      try {
        for (let i = 0; i < 50; i++) store.query(`INSERT INTO project_conventions (id,text) VALUES ('rule-${i}','Rule')`, 'web:owner', human('Rule'))
        assert.equal(store.query('SELECT * FROM project_conventions', 'web:reader').results[0].rows.length, 20)
        assert.equal(store.query('SELECT * FROM project_conventions LIMIT 200', 'web:reader').results[0].rows.length, 50)
        assert.throws(() => store.query("INSERT INTO project_conventions (id,text) VALUES ('overflow','Rule')", 'web:owner', human('Rule')), /budget/)
        const read = 'SELECT id FROM project_conventions LIMIT 200;'
        assert.equal(store.query(read.repeat(4), 'web:reader').results.flatMap(result => result.rows).length, 200)
        assert.throws(() => store.query(read.repeat(5), 'web:reader'), /result limit/)
        const history = store.query('SELECT id FROM convention_history LIMIT 200', 'web:reader')
        assert.equal(history.results[0].rows.length, 50, 'Failed over-budget mutations leave no audit residue')
      } finally { store.close() }
    })
  })
})
