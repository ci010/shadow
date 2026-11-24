import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { projectStoragePath } from '../utils/data-paths.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'

test('creation keys survive restart, normalize defaults, isolate creators and reject conflicts without repeating publication', async () => withTempWorkspace(async home => {
  let published = 0
  let fail = true
  const setup = () => {
    const store = new InitiativeStore(home, { isSessionKnown: () => true })
    const alignment = new WorkAlignment(store, {
      state: sessionId => ({ sessionId, segmentIndex: 0, mode: 'session' }),
      changed: async () => { published++; if (fail) throw new Error('delivery unavailable') },
    })
    return { store, alignment }
  }
  let f = setup()
  const request = { assignee: null, idempotencyKey: 'request-1', title: ' Test ', definition: '  **Outcome**\r\n\r\nKeep the review local.  ' }
  const create = (data = request, sessionId = 'owner') => f.alignment.execute({ kind: 'session', sessionId }, 'create', undefined, undefined, data) as Promise<WorkRecord>
  try {
    await assert.rejects(create(), /saved.*delivery failed/)
    const original = f.store.workRecords()[0]!
    assert.equal(published, 1)
    f.store.close(); f = setup(); fail = false
    const retry = await create({ ...request, title: 'Test', definition: '**Outcome**\n\nKeep the review local.' })
    assert.equal(retry.key, original.key)
    assert.equal(published, 1)
    await assert.rejects(create({ ...request, title: 'Different' }), /conflicts/)
    const peers = await Promise.all(Array.from({ length: 8 }, () => create({ ...request, idempotencyKey: 'parallel' })))
    assert.equal(new Set(peers.map(record => record.key)).size, 1)
    assert.equal(published, 2)
    assert.notEqual((await create(request, 'peer')).key, original.key)
    const legacy = { assignee: null, title: 'Legacy', definition: 'Outcome' }
    const a = await f.alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create', undefined, undefined, legacy) as WorkRecord
    const b = await f.alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create', undefined, undefined, legacy) as WorkRecord
    assert.notEqual(a.key, b.key)
  } finally { f.store.close() }
}))

test('a rejected creation receipt rolls back the Work, links and audit event', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home)
  const db = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
  const alignment = new WorkAlignment(store, { state: sessionId => ({ sessionId, segmentIndex: 0, mode: 'session' }), changed: async () => {} })
  const request = { title: 'Atomic creation', definition: 'Verify the receipt and Work commit together.', idempotencyKey: 'fixture' }
  const create = () => alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create', undefined, undefined, request) as Promise<WorkRecord>
  try {
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON work_creation_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END")
    await assert.rejects(create(), /fixture receipt failure|not authorized/i)
    for (const table of ['work_contracts', 'work_contract_events', 'work_creation_receipts', 'work_session_links']) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0, table)
    }
    db.exec('DROP TRIGGER reject_receipt')
    const record = await create()
    assert.equal((await create()).key, record.key)
    assert.equal(Object.hasOwn(record, 'creationRequest'), false)
    assert.equal(db.prepare('SELECT work_key FROM work_creation_receipts').get()?.work_key, record.key)
  } finally { db.close(); store.close() }
}))
