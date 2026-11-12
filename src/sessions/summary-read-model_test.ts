import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from './session-manager.ts'
import { SummaryRowCache } from './summary-read-model.ts'

test('summary archive snapshot reads once, overlays live state, and invalidates archive/deletion', async () => {
  let revision = '0', reads = 0
  let archived = [{ sessionId: 'old', segmentIndex: 0 }]
  const live: Record<string, { sessionId: string; segmentIndex: number }> = { live: { sessionId: 'live', segmentIndex: 0 } }
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    deps: { projectId: 'p', store: { archiveRevision: async () => revision, queryArchivedStates: async () => { reads++; return archived } } }, sessionStates: live,
  }) as SessionManager
  assert.equal((await manager.listSummaryStates()).length, 2)
  await manager.listSummaryStates()
  assert.equal(reads, 1, 'unchanged navigation must not reread archive pages')
  live.live.segmentIndex++
  assert.equal((await manager.listSummaryStates())[0].segmentIndex, 1)
  assert.equal(reads, 1, 'a live row change does not reread the archive')
  archived = [...archived, live.live]; delete live.live; revision = '1'
  assert.equal((await manager.listSummaryStates()).length, 2)
  assert.equal(reads, 2)
  archived = archived.slice(1); revision = '2'
  assert.deepEqual((await manager.listSummaryStates()).map(s => s.sessionId), ['live'])
  assert.equal(reads, 3)
})

test('row fingerprints reuse unchanged assembly, replace one row, prune deleted identities and bound memory', () => {
  const cache = new SummaryRowCache<object>(1000)
  let assembled = 0
  const get = (id: string, version: string) => {
    let row = cache.get(id, version)
    if (!row) { assembled++; row = { id, version }; cache.set(id, version, row) }
    return row
  }
  const a = get('a', '0'), b = get('b', '0')
  assert.equal(get('a', '0'), a); assert.equal(get('b', '0'), b)
  assert.equal(assembled, 2)
  get('a', '1'); assert.equal(get('b', '0'), b); assert.equal(assembled, 3)
  cache.retain(new Set(['a'])); assert.equal(cache.get('b', '0'), undefined)
  cache.set('large', 'x'.repeat(1001), {}); assert.equal(cache.get('large', 'x'.repeat(1001)), undefined)
})

test('pull validation detaches nested navigation inputs and never serializes cache hits', () => {
  const cache = new SummaryRowCache<object>()
  const input = { config: { model: 'old' }, waiting: false }
  const row = { title: 'Row' }
  cache.set('id', input, row)
  const stringify = JSON.stringify
  try {
    JSON.stringify = (() => { throw new Error('cache hit must not serialize') }) as typeof JSON.stringify
    assert.equal(cache.get('id', { config: { model: 'old' }, waiting: false }), row)
    input.config.model = 'new'
    assert.equal(cache.get('id', input), undefined)
  } finally { JSON.stringify = stringify }
})
