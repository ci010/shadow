import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { projectStoragePath } from '../utils/data-paths.ts'
import { StreamDocument } from './message-stream-queue.ts'
import { join } from 'node:path'
import { ChannelMessageStream, type StreamInput } from './message-stream.ts'
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(process.cwd(), '.stream-dedupe-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const stream = new ChannelMessageStream(home, 'p')
  const append = (kind: StreamInput['kind'], content?: string, extra: Partial<StreamInput> = {}) =>
    stream.append({ connection: 'bot', conversation: '10', platform: 'synthetic', message: '1', kind, content, ...extra })
  return { home, stream, append }
}
test('revisionless updates preserve A -> B -> A but suppress consecutive identical states', async t => {
  const f = fixture(t)
  await f.append('updated', 'A'); await f.append('updated', 'B'); await f.append('updated', 'A')
  await f.append('updated', 'A')
  assert.deepEqual(f.stream.snapshot().events.map(e => e.content), ['A', 'B', 'A'])
})
test('reliable revision IDs dedupe old replay after a newer state without comparing historical content', async t => {
  const f = fixture(t)
  const first = await f.append('updated', 'A', { revision: 'r1' })
  await f.append('updated', 'B', { revision: 'r2' })
  await f.append('updated', 'A', { revision: 'r3' })
  assert.equal((await f.append('updated', 'A', { revision: 'r1' })).position, first.position)
  assert.equal((await f.append('updated', 'A', { revision: 'r3' })).position, 3)
  assert.equal(f.stream.snapshot().events.length, 3)
})
test('created/history overlap dedupes across updates and tombstones without hiding generic recreation', async t => {
  const f = fixture(t)
  await f.append('created', 'A')
  await f.append('created', 'A', { historical: true })
  await f.append('updated', 'B')
  await f.append('created', 'B', { historical: true })
  await f.append('deleted'); await f.append('deleted')
  await f.append('created', 'stale history', { historical: true })
  await f.append('created', 'A')
  await f.append('deleted')
  assert.deepEqual(f.stream.snapshot().events.map(e => e.kind), ['created', 'updated', 'deleted', 'created', 'deleted'])
})
test('reliable creation/deletion revisions distinguish recreation while replaying old revisions stays idempotent', async t => {
  const f = fixture(t)
  await f.append('created', 'A', { revision: 'create-1' })
  await f.append('deleted', undefined, { revision: 'delete-1' })
  await f.append('created', 'A', { revision: 'create-2' })
  await f.append('deleted', undefined, { revision: 'delete-2' })
  await f.append('created', 'A', { revision: 'create-1' })
  await f.append('deleted', undefined, { revision: 'delete-1' })
  assert.equal(f.stream.snapshot().events.length, 4)
})

test('concurrent appends from multiple instances share FIFO, dedupe and durable local positions', async t => {
  const f = fixture(t)
  const other = new ChannelMessageStream(f.home, 'p')
  const input = (message: string): StreamInput => ({ connection: 'bot', conversation: '10', platform: 'synthetic', kind: 'created', message })
  const rows = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    (i % 2 ? f.stream : other).append(input(String(Math.floor(i / 2))))))
  assert.deepEqual(rows.map(row => row.position), Array.from({ length: 60 }, (_, i) => Math.floor(i / 2) + 1))
  await other.drain()
  assert.deepEqual(other.snapshot().events.map(row => row.message), Array.from({ length: 30 }, (_, i) => String(i)))
  assert.equal(other.snapshot().next, 31)
})

test('one failed append rejects its caller but does not poison later queued work or drain', async t => {
  const f = fixture(t)
  const save = StreamDocument.prototype.save
  let fail = true
  t.mock.method(StreamDocument.prototype, 'save', function(this: StreamDocument<unknown>, state: unknown) {
    if (fail) { fail = false; throw Object.assign(new Error('synthetic write failure'), { code: 'ENOSPC' }) }
    return save.call(this, state)
  })
  const bad = f.append('updated', 'failed write')
  const good = f.append('updated', 'valid')
  const failure = assert.rejects(bad, /synthetic write failure/)
  await f.stream.drain()
  await failure
  assert.equal((await good).position, 1)
  assert.deepEqual(f.stream.snapshot().events.map(row => row.content), ['valid'])
})

test('legacy lock directories are ignored and left untouched by the queued events path', async t => {
  const f = fixture(t)
  const home = f.home
  const file = projectStoragePath(home, '.channel-stream', 'events.json')
  const lock = `${file}.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), 'synthetic legacy owner')
  await f.append('created', 'received despite old lock')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).events.length, 1)
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), 'synthetic legacy owner')
  assert.equal(existsSync(`${lock}.recovery`), false)
})
