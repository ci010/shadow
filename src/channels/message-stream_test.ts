import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelMessageStream, type StreamInput } from './message-stream.ts'
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(process.cwd(), '.stream-dedupe-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const stream = new ChannelMessageStream(home, 'p')
  const append = (kind: StreamInput['kind'], content?: string, extra: Partial<StreamInput> = {}) =>
    stream.append({ connection: 'bot', conversation: '10', platform: 'synthetic', message: '1', kind, content, ...extra })
  return { stream, append }
}
test('revisionless updates preserve A -> B -> A but suppress consecutive identical states', t => {
  const f = fixture(t)
  f.append('updated', 'A'); f.append('updated', 'B'); f.append('updated', 'A')
  f.append('updated', 'A')
  assert.deepEqual(f.stream.snapshot().events.map(e => e.content), ['A', 'B', 'A'])
})
test('reliable revision IDs dedupe old replay after a newer state without comparing historical content', t => {
  const f = fixture(t)
  const first = f.append('updated', 'A', { revision: 'r1' })
  f.append('updated', 'B', { revision: 'r2' })
  f.append('updated', 'A', { revision: 'r3' })
  assert.equal(f.append('updated', 'A', { revision: 'r1' }).position, first.position)
  assert.equal(f.append('updated', 'A', { revision: 'r3' }).position, 3)
  assert.equal(f.stream.snapshot().events.length, 3)
})
test('created/history overlap dedupes across updates and tombstones without hiding generic recreation', t => {
  const f = fixture(t)
  f.append('created', 'A')
  f.append('created', 'A', { historical: true })
  f.append('updated', 'B')
  f.append('created', 'B', { historical: true })
  f.append('deleted'); f.append('deleted')
  f.append('created', 'stale history', { historical: true })
  f.append('created', 'A')
  f.append('deleted')
  assert.deepEqual(f.stream.snapshot().events.map(e => e.kind), ['created', 'updated', 'deleted', 'created', 'deleted'])
})
test('reliable creation/deletion revisions distinguish recreation while replaying old revisions stays idempotent', t => {
  const f = fixture(t)
  f.append('created', 'A', { revision: 'create-1' })
  f.append('deleted', undefined, { revision: 'delete-1' })
  f.append('created', 'A', { revision: 'create-2' })
  f.append('deleted', undefined, { revision: 'delete-2' })
  f.append('created', 'A', { revision: 'create-1' })
  f.append('deleted', undefined, { revision: 'delete-1' })
  assert.equal(f.stream.snapshot().events.length, 4)
})
