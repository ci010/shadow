import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { validatePublicationReceipt as validate } from './publication-receipt.ts'
import { runBridge } from './bridge.ts'
const args = { ref: 'left', branch: 'right', name: 'merged' }
const merge = { kind: 'Merged', fastForward: true, branch: 'merged', head: null, root: 'aa', mergeBase: 'bb', sources: [{ ref: 'left', node: 'cc' }, { ref: 'right', node: 'dd' }], conflicts: [], lww: [], units: [], conflictsTruncated: false, lwwTruncated: false, unitsTruncated: false }
test('pinned merge and publish domain receipts accept real variants, reject generic envelopes or changed identity', () => {
  validate('merge', merge, args)
  for (const value of [{}, { kind: 'Merged' }, { ...merge, branch: 'other' }, { ...merge, sources: [] }, { ...merge, root: 'invalid' }]) assert.throws(() => validate('merge', value, args))
  validate('publish', { kind: 'UpToDate', layer: 'aa' }, args)
  validate('publish', { kind: 'NoChanges', headLayer: 'bb' }, args)
  const added = { kind: 'Added', source: { branch: 'right', commit: 'ee' }, publishedLayer: { id: 'ab', parent: null, root: 'cd', logical: 1, overwroteCount: 0, sourceBranch: 'right', sourceCommit: 'ee' }, basedOn: 'ff', overwroteCount: 0, overwrote: [], overwroteHasMore: false }
  validate('publish', added, { branch: 'right' })
  assert.throws(() => validate('publish', { ...added, source: { branch: 'wrong', commit: 'ee' } }, { branch: 'right' }))
  assert.throws(() => validate('publish', {}, { branch: 'right' }))
})
test('invalid SDK mutation receipt retains all reservations rather than releasing on ok JSON', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-domain-test-'))
  try {
    const sdkModule = join(dir, 'sdk.mjs'), journal = join(dir, 'p.jsonl')
    await writeFile(sdkModule, 'export const LayerFS={open:async()=>({project:{list_sandboxes:async()=>({items:[],hasMore:false})},branch:{merge:async()=>({})},close:async()=>{}})}')
    await assert.rejects(runBridge({ sdkModule, env: {} }, 'p', 'merge', { ...args, journal }, new AbortController().signal), /unknown/i)
    const db = new DatabaseSync(journal + '.sqlite')
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM reservations').get()!.n, 3) } finally { db.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
