import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionSummaryLoader, parseSessionSummary } from './session-summary-snapshot.ts'

test('logical summaries preserve fork, delegation, channel defaults and bounded composer overrides', () => {
  const rows = parseSessionSummary({ sessions: [
    { sessionId: 'task:child', mode: 'task', parentSessionId: 'web:root', executionStatus: 'running', description: 'Working' },
    { sessionId: 'web:root', mode: 'session', parentSessionId: null, inferenceOverrides: { model: 'selected', contextWindow: 123 }, inferenceDefaults: { model: 'default' } },
    { sessionId: 'web:fork', mode: 'session', parentSessionId: null, contextParentSessionId: 'web:root' },
  ] }, 'a')
  assert.equal(rows.find(row => row.sessionId === 'task:child')?.parentSessionId, 'web:root')
  assert.equal(rows.find(row => row.sessionId === 'task:child')?.depth, 1)
  assert.equal(rows.find(row => row.sessionId === 'web:fork')?.contextParentSessionId, 'web:root')
  assert.equal(rows.find(row => row.sessionId === 'web:root')?.config?.model, 'selected')
  assert.equal(rows.find(row => row.sessionId === 'web:root')?.inferenceDefaults?.model, 'default')
  assert.throws(() => parseSessionSummary({ sessions: [{ sessionId: 'web:bad', projectId: 'b' }] }, 'a'))
  assert.throws(() => parseSessionSummary({ sessions: [{ sessionId: 'web:bad', contextParentSessionId: 12 }] }))
})

test('summary reader revalidates without requesting a physical graph and ignores aborted responses', async () => {
  let calls = 0
  const loader = createSessionSummaryLoader('http://main/projects/a', 'a', async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/projects/a/api/sessions/summary')
    calls++
    if (calls === 2) {
      assert.equal(new Headers(init?.headers).get('If-None-Match'), '"one"')
      return new Response(null, { status: 304 })
    }
    return Response.json({ sessions: [{ sessionId: 'web:one', title: 'One' }] }, { headers: { ETag: '"one"' } })
  })
  const first = await loader.load(new AbortController().signal)
  assert.equal(await loader.load(new AbortController().signal), first)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(loader.load(aborted.signal))
})
