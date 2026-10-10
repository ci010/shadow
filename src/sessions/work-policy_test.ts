import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkAlignment } from './work-alignment.ts'
import { parseWorkPolicy, workBindingSchema } from './work-policy.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'

test('delegation uses a stable key rather than a revision/adoption handshake', () => {
  assert.deepEqual(workBindingSchema.parse({ key: 'work:fixture' }), { key: 'work:fixture' })
  assert.equal(workBindingSchema.safeParse({ key: '' }).success, false)
  assert.equal(workBindingSchema.safeParse({ key: 'work:fixture', revision: 1 }).success, false)
  assert.equal(parseWorkPolicy(undefined), undefined)
  assert.throws(() => parseWorkPolicy({ mode: 'required' }), /Invalid Work policy/)
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: persisted policy metadata cannot reactivate work gates, while focused notes and lineage survive`, async () => withTempWorkspace(async home => {
    const store: SessionStore = new Store(join(home, 'sessions'))
    await store.init()
    const states = new Map<string, SessionState>([
      ['owner', { sessionId: 'owner', segmentIndex: 0, mode: 'session' }],
      ['task', { sessionId: 'task', segmentIndex: 0, mode: 'task', parentSessionId: 'owner' }],
      ['call', { sessionId: 'call', segmentIndex: 0, mode: 'call', parentSessionId: 'task' }],
    ])
    const notes = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
    notes.migrateWorkItems()
    const alignment = new WorkAlignment(notes, {
      state: id => states.get(id), evidence: async () => {}, changed: async () => {},
      fresh: async () => {}, successor: async () => undefined,
    })
    try {
      const note = workRecordSchema.parse(await alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create',
        undefined, undefined, { title: 'Shared goal', definition: { objective: 'Gather one finding' } }))
      states.get('owner')!.workPolicy = { mode: 'required', keys: [note.key], controllerSessionId: 'owner' }
      for (const [id, state] of states) await store.saveState(id, state)
      alignment.linkExecution('task', 'owner', { key: note.key })
      alignment.linkExecution('call', 'task')
      for (const id of states.keys()) {
        assert.equal(alignment.required(id), false)
        assert.deepEqual(alignment.snapshot(id), [])
        assert.equal(alignment.decisionContext(id)?.originKey, note.key)
      }
      assert.equal((await store.getState('task'))?.parentSessionId, 'owner')
      assert.equal((await store.getState('call'))?.parentSessionId, 'task')
      assert.equal(notes.workFocus('task'), note.key)
      assert.equal(notes.workFocus('call'), note.key)
      assert.deepEqual(alignment.prepareDelegation('owner', undefined, 'session'), { mode: 'optional' })
      await assert.rejects(alignment.assignNote({ kind: 'session', sessionId: 'owner' }, note.key, 1, 'task'), /durable Session/)
    } finally { notes.close(); await store.close?.() }
  }))
}
