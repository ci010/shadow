import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { InitiativeStore } from './store.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { WorkRecord } from './work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'

const setup = (home: string) => {
  const store = new InitiativeStore(home)
  const alignment = new WorkAlignment(store, { state: sessionId => ({ sessionId, segmentIndex: 0, mode: 'session' }), evidence: async () => {}, changed: async () => {} })
  const create = (title: string, assignee: string | null = 'worker') => alignment.execute({ kind: 'session', sessionId: 'manager' }, 'create', undefined, undefined,
    { title, assignee, definition: { objective: title } }) as Promise<WorkRecord>
  return { store, alignment, create }
}
const save = (store: InitiativeStore, record: WorkRecord, patch: Partial<NonNullable<WorkRecord['workflow']>> = {}) => {
  const next = { ...record, sequence: record.sequence + 1, workflow: { ...record.workflow!, ...patch } }
  store.saveWork(next, record.sequence, 'manager', 'test')
  return next
}

test('all storage admissions count pending, blocked and paused; terminal history and management do not occupy a slot', async () => withTempWorkspace(async home => {
  const { store, alignment, create } = setup(home)
  try {
    let first = await create('First')
    const other = await create('Other', null)
    assert.equal(alignment.decisionContext('manager'), undefined, 'Management is not assignment')
    await alignment.execute({ kind: 'session', sessionId: 'linked' }, 'link', first.key, undefined, {})
    assert.equal(alignment.decisionContext('linked'), undefined)
    await assert.rejects(create('Conflict'), new RegExp(first.key))
    assert.throws(() => save(store, other, { assignee: 'worker' }), new RegExp(first.key))
    for (const status of ['in_progress', 'blocked', 'pending'] as const) {
      first = save(store, first, { status, blockedReason: status === 'blocked' ? 'Waiting' : undefined })
      first = { ...first, paused: true }
      first = save(store, first)
      await assert.rejects(create('Still occupied'), new RegExp(first.key))
      assert.equal(store.workFocus('worker'), first.key)
    }
    first = save(store, first, { status: 'done' })
    assert.equal(store.workFocus('worker'), undefined)
    const next = await create('Reusable')
    assert.equal(first.workflow?.assignee, 'worker')
    assert.throws(() => save(store, first, { status: 'pending' }), new RegExp(next.key))
    save(store, next, { status: 'cancelled' })
    first = save(store, first, { status: 'pending' })
    assert.equal(store.workFocus('worker'), first.key)
    assert.equal(store.workRecords().filter(item => item.workflow?.manager === 'manager').length, 3)
  } finally { store.close() }
}))

test('legacy duplicates remain readable and editable, cannot grow, and converge without dropping responsibility', async () => withTempWorkspace(async home => {
  let { store, create } = setup(home)
  const a = await create('A'), b = await create('B', null)
  store.close()
  const db = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
  const legacy = { ...b, workflow: { ...b.workflow!, assignee: 'worker' } }
  db.prepare('UPDATE work_contracts SET data=? WHERE id=?').run(JSON.stringify(legacy), b.key)
  db.close()
  ;({ store, create } = setup(home))
  try {
    assert.equal(store.workFocus('worker'), undefined)
    assert.equal(store.workRecords().filter(item => item.workflow?.assignee === 'worker').length, 2)
    const edited = save(store, a, { status: 'blocked', blockedReason: 'Legacy waiting' })
    await assert.rejects(create('Third'), /unfinished Work/)
    save(store, legacy, { assignee: null })
    assert.equal(store.workFocus('worker'), a.key)
    assert.throws(() => save(store, { ...legacy, sequence: legacy.sequence + 1 }, { assignee: 'worker' }), /unfinished Work/)
    save(store, edited, { status: 'done', blockedReason: undefined })
    await create('New')
  } finally { store.close() }
}))

test('separate processes serialize conflicting assignments at the storage transaction boundary', async () => withTempWorkspace(async home => {
  const { store, create } = setup(home)
  const a = await create('Race A', null), b = await create('Race B', null)
  store.close()
  const run = (record: WorkRecord) => new Promise<number>((resolve, reject) => {
    const code = `import { InitiativeStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
      const store = new InitiativeStore(${JSON.stringify(home)});
      try { const r = ${JSON.stringify(record)}; r.sequence++; r.workflow.assignee='worker'; store.saveWork(r, 1, 'manager', 'race'); }
      catch (e) { if (!String(e).includes('unfinished Work')) throw e; process.exitCode=2; }
      finally { store.close(); }`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 || code === 2 ? resolve(code) : reject(new Error(errors)))
  })
  assert.deepEqual((await Promise.all([run(a), run(b)])).sort(), [0, 2])
  const restored = new InitiativeStore(home)
  try { assert.equal(restored.workRecords().filter(item => item.workflow?.assignee === 'worker').length, 1) }
  finally { restored.close() }
}))
