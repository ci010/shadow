import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sessionsApiPlugin } from './routes.ts'
import { SessionManager } from './session-manager.ts'
import type { SessionState } from './session-store.ts'
import { createSessionSummaryLoader, parseSessionSummary } from '../../app/src/session-summary-snapshot.ts'
import { searchQuickOpenSessions } from '../../app/src/session-quick-open.ts'

export function automationInventory(count = 1000): SessionState[] {
  const runs = Array.from({ length: count }, (_, i) => ({
    sessionId: `run:${i}`, segmentIndex: 0, mode: 'task' as const, name: `Saved automation ${i}`,
    lastActivityAt: new Date(1_750_000_000_000 + i * 1000).toISOString(), executionStatus: 'completed' as const,
    automation: { jobId: 'job', name: 'Scheduled review', runId: `r${i}`, contextMode: 'fresh' as const,
      startedAt: new Date(1_750_000_000_000 + i * 1000).toISOString() },
  }))
  return [...runs,
    { sessionId: 'ordinary', segmentIndex: 0, name: 'Ordinary chat' },
    { sessionId: 'ordinary-task', segmentIndex: 0, name: 'Ordinary completed task', mode: 'task', executionStatus: 'completed' },
    { sessionId: 'ordinary-call', segmentIndex: 0, name: 'Ordinary call', mode: 'call', executionStatus: 'completed' },
    { sessionId: 'active', segmentIndex: 0, name: 'Active child', mode: 'task', parentSessionId: 'run:3', executionStatus: 'running' },
    { sessionId: 'waiting', segmentIndex: 0, name: 'Waiting child', mode: 'task', parentSessionId: 'run:4', executionStatus: 'completed' },
    { sessionId: 'fork', segmentIndex: 0, name: 'Ordinary fork', parent: { id: 'run:5', physicalId: 'run_5-0', index: 0 } },
    { sessionId: 'old-child', segmentIndex: 0, name: 'Historical child', mode: 'call', parentSessionId: 'run:8', executionStatus: 'completed' },
  ]
}

export function summaryFixture(states = automationInventory()) {
  const manager = {
    projectId: 'a', listSummaryStates: async () => states,
    historySessionSummary: SessionManager.prototype.historySessionSummary,
    getSessionInferenceDefaults: () => ({ model: 'default' }),
    getFirstUserMessage: async () => { throw Error('named rows must not read logs') },
    isWaitingForCall: (id: string) => id === 'waiting', yields: new Map(), inputs: new Map(),
  } as unknown as SessionManager
  const app = new Hono(); sessionsApiPlugin(manager)(app)
  return { app, states }
}

test('navigation reduces historical automation inventory, retains ordinary rows, live children and both ancestor kinds; full scope searches archives', async t => {
  const { app, states } = summaryFixture()
  const full = await app.request('/api/sessions/summary')
  const fullText = await full.text()
  const nav = await app.request('/api/sessions/summary?scope=navigation')
  const navText = await nav.text()
  const rows = JSON.parse(navText).sessions
  assert.deepEqual(rows.map((r: { sessionId: string }) => r.sessionId).sort(),
    ['ordinary', 'ordinary-task', 'ordinary-call', 'active', 'waiting', 'fork', 'run:3', 'run:4', 'run:5', 'run:999'].sort())
  assert.ok(navText.length < fullText.length / 30)
  t.diagnostic(`1000 completed runs: full ${states.length} rows / ${Buffer.byteLength(fullText)} bytes; navigation ${rows.length} rows / ${Buffer.byteLength(navText)} bytes`)
  const request: typeof fetch = async (input, init) => app.request(String(input), init)
  const loader = createSessionSummaryLoader('http://main', 'a', request)
  const search = searchQuickOpenSessions((await loader.load(new AbortController().signal)).map(row => ({ ...row, projectId: 'a' })), 'Saved automation 88')
  assert.ok(search.some(row => row.sessionId === 'run:88'))
  assert.equal(rows.some((row: { sessionId: string }) => row.sessionId === 'run:88'), false)
  assert.equal(searchQuickOpenSessions(parseSessionSummary(JSON.parse(fullText), 'a').map(row => ({ ...row, projectId: 'a' })), '').some(row => row.automation), false)
  const partial = await app.request('/api/sessions/summary?scope=navigation&sessionIds=' + encodeURIComponent(JSON.stringify(['run:88'])))
  assert.deepEqual((await partial.json()).sessions.map((row: { sessionId: string }) => row.sessionId), ['run:88'])
  assert.equal((await app.request('/api/sessions/summary?scope=invalid')).status, 400)
  const etag = nav.headers.get('etag')!
  assert.equal((await app.request('/api/sessions/summary?scope=navigation', { headers: { 'If-None-Match': etag } })).status, 304)
  const cross = await app.request('/api/sessions/summary', { headers: { 'If-None-Match': etag, Accept: 'application/vnd.shadow.session-summary-delta+json' } })
  assert.equal(cross.status, 200); assert.equal((await cross.json()).delta, undefined)
  states[0]!.executionStatus = 'running'
  const changed = await app.request('/api/sessions/summary?scope=navigation', { headers: { 'If-None-Match': 'W/' + etag, Accept: 'application/vnd.shadow.session-summary-delta+json' } })
  const patch = await changed.json()
  assert.equal(patch.delta, 1); assert.equal(patch.base, 'W/' + etag)
  assert.ok(patch.upsert.some((row: { sessionId: string }) => row.sessionId === 'run:0'))
})

test('only explicitly fresh automation owners are pruned; existing and unknown legacy roots retain descendants', async () => {
  const { navigationSummary } = await import('./summary-navigation.ts')
  const fresh = { jobId: 'job', startedAt: '2026-01-01T00:00:00Z', contextMode: 'fresh' }
  const rows = [
    { sessionId: 'old-fresh', executionStatus: 'completed', automation: fresh },
    { sessionId: 'latest-fresh', executionStatus: 'completed', automation: { ...fresh, startedAt: '2026-03-01T00:00:00Z' } },
    { sessionId: 'old-existing', mode: 'session', executionStatus: 'completed', automation: { ...fresh, contextMode: 'existing' } },
    { sessionId: 'existing-child', mode: 'task', parentSessionId: 'old-existing', executionStatus: 'completed' },
    { sessionId: 'unknown-legacy', mode: 'session', executionStatus: 'completed', automation: { jobId: 'job', startedAt: fresh.startedAt } },
    { sessionId: 'legacy-child', mode: 'call', parentSessionId: 'unknown-legacy', executionStatus: 'completed' },
    { sessionId: 'unknown-under-fresh', mode: 'task', parentSessionId: 'old-fresh', executionStatus: 'completed', automation: { jobId: 'job' } },
    { sessionId: 'unknown-descendant', mode: 'call', parentSessionId: 'unknown-under-fresh', executionStatus: 'completed' },
    { sessionId: 'pruned-fresh', executionStatus: 'completed', automation: { ...fresh, startedAt: '2026-02-01T00:00:00Z' } },
    { sessionId: 'pruned-child', mode: 'task', parentSessionId: 'pruned-fresh', executionStatus: 'completed' },
  ]
  assert.deepEqual(navigationSummary(rows).map(row => row.sessionId), [
    'old-fresh', 'latest-fresh', 'old-existing', 'existing-child', 'unknown-legacy', 'legacy-child',
    'unknown-under-fresh', 'unknown-descendant',
  ])
})
