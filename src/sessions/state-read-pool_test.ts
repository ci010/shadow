import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readStatePool } from './state-read-pool.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('state read pool bounds concurrency at eight and preserves input order', async () => {
  let active = 0, peak = 0
  const values = Array.from({ length: 35 }, (_, i) => i)
  const actual = await readStatePool(values, async value => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, value % 3))
    active--
    return value * 2
  })
  assert.equal(peak, 8)
  assert.equal(active, 0)
  assert.deepEqual(actual, values.map(value => value * 2))
})

test('state read pool drains failures and throws first input-order error', async () => {
  let active = 0
  const first = new Error('first'), later = new Error('later')
  await assert.rejects(readStatePool([0, 1, 2, 3], async value => {
    active++
    try {
      await new Promise(resolve => setTimeout(resolve, value === 0 ? 10 : 1))
      if (value === 0) throw first
      if (value === 2) throw later
      return value
    } finally { active-- }
  }), error => error === first)
  assert.equal(active, 0)
  await assert.rejects(readStatePool([], async () => 0, 0), RangeError)
})

test('parallel JSON state reads retain malformed-file tolerance and ownership validation', async () => {
  await withTempWorkspace(async root => {
    const store = new JsonlSessionStore(root)
    await store.init()
    for (let i = 0; i < 20; i++) await store.saveState(`web:${i}`, { sessionId: `web:${i}`, segmentIndex: i })
    await writeFile(join(root, 'broken.json'), '{not json')
    await writeFile(join(root, 'ignored.jsonl'), 'unrelated log')
    assert.equal(Object.keys(await store.listAllStates()).length, 20)
    assert.equal((await store.listSessions()).length, 20)
    await writeFile(join(root, 'invalid-owner.json'), JSON.stringify({ sessionId: 'web:bad', ownershipVersion: 9000 }))
    await assert.rejects(store.listAllStates(), /ownership/i)
    await assert.rejects(store.listSessions(), /ownership/i)
  })
})
