import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sessionsApiPlugin } from './routes.ts'
import type { SessionManager } from './session-manager.ts'
import { sessionActivityReadModel } from './activity-invalidation.ts'
import { parseSessionActivity } from '../../app/src/session-activity.ts'
import { sessionActivitySnapshot } from './activity-snapshot.ts'

test('real stages responder and consumer omit defaults and preserve active/idle/request/recovery/waits', async t => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `web:synthetic-session-${String(i).padStart(5, '0')}`)
  const manager = {
    projectId: 'synthetic', listSessions: async () => ids.map(sessionId => ({ sessionId })),
    getActiveSession: (id: string) => id === ids[0] ? { phase: 'idle' }
      : id === ids[1] ? { phase: 'tool', activeRequestId: 'request-1' } : undefined,
    isWaitingForCall: (id: string) => id === ids[2],
    getSessionRecovery: (id: string) => id === ids[3] ? { id: 'recovery-3', reason: 'failed' } : undefined,
    yields: { get: (id: string) => id === ids[4] ? {} : undefined },
  } as unknown as SessionManager
  const app = new Hono()
  sessionsApiPlugin(manager)(app)
  const response = await app.request('/api/sessions/stages')
  assert.equal(response.status, 200)
  const text = await response.text()
  const wire = JSON.parse(text)
  assert.deepEqual(Object.keys(wire), ['activity'])
  assert.equal(Object.keys(wire.activity).length, 5)
  assert.deepEqual(wire.activity[ids[0]], { stage: 'idle' })
  assert.deepEqual(wire.activity[ids[2]], { stage: 'waiting', waitingForCall: true })
  assert.deepEqual(wire.activity[ids[3]], { recovery: { id: 'recovery-3', reason: 'failed' } })
  assert.equal(wire.activity[ids[9999]], undefined)
  const parsed = parseSessionActivity(wire)
  assert.equal(parsed.stages[ids[0]], 'idle')
  assert.equal(parsed.stages[ids[2]], 'waiting-for-call')
  assert.equal(parsed.stages[ids[3]], 'failed')
  assert.equal(parsed.activeRequestIds[ids[1]], 'request-1')
  const old = { stages: {} as Record<string, string>, waitingForCalls: {} as Record<string, boolean>, activeRequestIds: {} as Record<string, string>, recoveries: {} as Record<string, unknown> }
  for (const id of ids) {
    const model = sessionActivityReadModel(manager, id)
    old.stages[id] = model.stage
    old.waitingForCalls[id] = model.waitingForCall
    if (model.activeRequestId !== null) old.activeRequestIds[id] = model.activeRequestId
    if (model.recovery !== null) old.recoveries[id] = model.recovery
  }
  const before = Buffer.byteLength(JSON.stringify(old)), after = Buffer.byteLength(text)
  t.diagnostic(`Synthetic 10,000 sessions (9,995 default inactive): JSON body ${before} -> ${after} bytes; no network timing measured`)
  assert.ok(after < before / 100)
  const unchanged = await app.request('/api/sessions/stages', { headers: { 'If-None-Match': response.headers.get('etag')! } })
  assert.equal(unchanged.status, 304)
  assert.equal(await unchanged.text(), '')
})

test('request-only entries survive even with default stage, and pure defaults are absent', () => {
  const defaults = { stage: 'inactive', waitingForCall: false, activeRequestId: null, recovery: null } as const
  assert.deepEqual(JSON.parse(JSON.stringify(sessionActivitySnapshot([
    ['inactive', defaults], ['request', { ...defaults, activeRequestId: 'turn' }],
  ]))), { activity: { request: { activeRequestId: 'turn' } } })
})
