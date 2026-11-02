import assert from 'node:assert/strict'
import { test } from 'node:test'
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
      evidence: async () => {}, fresh: async () => {}, successor: async () => undefined,
      changed: async () => { published++; if (fail) throw new Error('delivery unavailable') },
    })
    return { store, alignment }
  }
  let f = setup()
  const request = { idempotencyKey: 'request-1', title: ' Test ', definition: { objective: 'Outcome' } }
  const create = (data = request, sessionId = 'owner') => f.alignment.execute({ kind: 'session', sessionId }, 'create', undefined, undefined, data) as Promise<WorkRecord>
  try {
    await assert.rejects(create(), /saved.*delivery failed/)
    const original = f.store.workRecords()[0]!
    assert.equal(published, 1)
    f.store.close(); f = setup(); fail = false
    const retry = await create({ ...request, title: 'Test' })
    assert.equal(retry.key, original.key)
    assert.equal(published, 1)
    await assert.rejects(create({ ...request, title: 'Different' }), /conflicts/)
    const peers = await Promise.all(Array.from({ length: 8 }, () => create({ ...request, idempotencyKey: 'parallel' })))
    assert.equal(new Set(peers.map(record => record.key)).size, 1)
    assert.equal(published, 2)
    assert.notEqual((await create(request, 'peer')).key, original.key)
    const legacy = { title: 'Legacy', definition: { objective: 'Outcome' } }
    const a = await f.alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create', undefined, undefined, legacy) as WorkRecord
    const b = await f.alignment.execute({ kind: 'session', sessionId: 'owner' }, 'create', undefined, undefined, legacy) as WorkRecord
    assert.notEqual(a.key, b.key)
  } finally { f.store.close() }
}))
