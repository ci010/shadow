import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionFileChanges, emptySessionFileChanges } from './session-file-changes.ts'
import { recordedFileChange } from '../../src/tools/file-change.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const rows = Array.from({ length: 65 }, (_, index) => ({
  ...recordedFileChange({ sessionId: 'web:session', toolCallId: `write-${index}`, path: 'memory/notes.md', mode: 'edit', before: 'old\n', after: 'new\n' }),
  id: `write-${index}`,
}))
function fixture() {
  const state = emptySessionFileChanges()
  const requests: Array<{ offset: number; signal: AbortSignal; finish(value?: unknown, status?: number): void }> = []
  const request: typeof fetch = async (input, init) => new Promise(resolve => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/a/api/sessions/web%3Asession/file-changes')
    assert.equal(init?.cache, 'no-store')
    const offset = Number(url.searchParams.get('offset'))
    requests.push({ offset, signal: init!.signal!, finish(value = { changes: rows.slice(offset, offset + 30), total: 65, offset }, status = 200) {
      resolve(Response.json(value, { status }))
    } })
  })
  const history = createSessionFileChanges('http://fixture/projects/a', 'web:session', state, { request, delayMs: 0 })
  return { state, history, requests }
}
test('recorded writes are lazy, append with a wire cursor and retain their rows through refresh failure and retries', async t => {
  const { state, history, requests } = fixture()
  t.after(history.dispose)
  history.loadMore()
  await settle()
  assert.equal(requests.length, 0)
  history.refresh()
  await settle()
  requests[0].finish()
  await settle()
  for (let index = 0; index < 10; index++) history.loadMore()
  await settle()
  assert.equal(requests.length, 2)
  requests[1].finish()
  await settle()
  assert.equal(state.changes.length, 60)
  assert.equal(state.nextOffset, 60)
  const original = state.changes
  history.refresh()
  await settle()
  requests[2].finish()
  await settle()
  assert.equal(state.changes, original)
  requests[3].finish({}, 503)
  await settle()
  assert.equal(state.changes, original)
  assert.match(state.error, /503/)
  history.retry()
  await settle()
  requests[4].finish()
  await settle()
  requests[5].finish()
  await settle()
  assert.equal(state.error, '')
  history.loadMore()
  await settle()
  requests[6].finish()
  await settle()
  assert.equal(state.changes.length, 65)
  assert.equal(state.nextOffset, 65)
})
test('invalid ownership, response shape and access denial never become empty successful history', async t => {
  for (const [value, status] of [
    [{ changes: [{ ...rows[0], sessionId: 'web:other' }], offset: 0, total: 1 }, 200],
    [{ changes: [], offset: 0, total: 2 }, 200],
    [{ changes: [rows[0], rows[0]], offset: 0, total: 2 }, 200],
    [{ changes: [{ ...rows[0], patch: '@@ -1,9 +1,1 @@\n+bad\n' }], offset: 0, total: 1 }, 200],
    [{ error: 'denied' }, 403],
  ] as const) {
    const { state, history, requests } = fixture()
    t.after(history.dispose)
    history.refresh()
    await settle()
    requests[0].finish(value, status)
    await settle()
    assert.equal(state.loaded, false)
    assert.ok(state.error)
    history.dispose()
  }
})
test('disposing a hidden or replaced history aborts its request and cannot apply a late response', async () => {
  const { state, history, requests } = fixture()
  history.refresh()
  await settle()
  history.dispose()
  assert.equal(requests[0].signal.aborted, true)
  requests[0].finish()
  await settle()
  assert.equal(state.loaded, false)
  assert.equal(state.changes.length, 0)
})
