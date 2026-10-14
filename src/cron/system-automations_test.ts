import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { resolveAutomationSession, systemAutomationRef, parseAutomationSessionRef } from './contracts.ts'
import { registerAutomationRoutes } from './routes.ts'
import type { CronService } from './service.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { groupFolderSessions, parseSessionGraph } from '../../app/src/folders-sidebar.ts'

const organizerId = 'work-organizer:11111111-2222-4333-8444-555555555555'
const stamp = '2026-10-12T10:00:00.000Z'
const old = { sessionId: organizerId, agentType: 'work-organizer', automationVersion: 1 as const, lastActivityAt: stamp }
test('historical internal provenance is a read-only automation view; names alone never classify', () => {
  const before = JSON.stringify(old)
  assert.equal(resolveAutomationSession(old)?.jobId, 'system:work-organizer')
  assert.equal(resolveAutomationSession(old)?.legacy, true)
  assert.equal(JSON.stringify(old), before)
  assert.equal(resolveAutomationSession({ ...old, sessionId: 'web:ordinary' }), undefined)
  assert.equal(resolveAutomationSession({ ...old, agentType: 'custom' }), undefined)
  assert.equal(resolveAutomationSession({ ...old, parentSessionId: 'web:parent' }), undefined)
  assert.equal(resolveAutomationSession({ ...old, sessionId: 'work-organizer:unrelated-name' }), undefined)
  assert.equal(resolveAutomationSession({ sessionId: 'work-observer:work-observer-1750000000001', agentType: 'work-observer', automationVersion: 1 })?.jobId, 'system:work-observer')
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: metadata survives storage and internal runs are visible only in Automation`, async () => {
  await withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions'))
    await store.init()
    try {
      const ref = systemAutomationRef('work-organizer', organizerId, 'delta')
      ref.organizationProblem = 'unfinished'
      ref.organization = { mode: 'delta', status: 'partial', coveredCount: 1, manifestCount: 3, patches: 1 }
      const current: SessionState = { ...old, segmentIndex: 0, projectId: 'fixture', mode: 'task', executionStatus: 'completed', automation: ref }
      await store.saveState(organizerId, current)
      const state = await store.getState(organizerId)
      assert.deepEqual(state?.automation, ref)
      const historical = { ...old, sessionId: organizerId.replace('11111111', 'aaaaaaaa'), projectId: 'fixture', segmentIndex: 0, mode: 'task', executionStatus: 'completed' } as SessionState
      const states = [state!, historical]
      const manager = {
        listSessions: () => states.map(s => ({ sessionId: s.sessionId })),
        getSessionState: (id: string) => states.find(s => s.sessionId === id),
        getFirstUserMessage: () => { throw new Error('System prompt must not become the title') },
      } as unknown as SessionManager
      const app = new Hono()
      registerAutomationRoutes(app, { listJobs: () => [] } as unknown as CronService, manager, 'fixture')
      const catalog = await (await app.request('/api/automations')).json()
      assert.equal(catalog.automations[0].source, 'system')
      assert.equal(catalog.automations[0].editable, false)
      assert.equal((await app.request('/api/automations/system:work-organizer', { method: 'PATCH', body: '{"enabled":false}' })).status, 404)
      const history = await (await app.request('/api/automations/system:work-organizer/runs')).json()
      assert.equal(history.total, 2)
      assert(history.runs.every((r: {title:string}) => !r.title.includes('{')))
      assert.equal(history.runs.find((r: {id:string}) => r.id === organizerId).scope, 'delta')
      assert.equal(history.runs.find((r: {id:string}) => r.id === organizerId).organizationProblem, 'unfinished')
      assert.equal(history.runs.find((r: {id:string}) => r.id === organizerId).organization.status, 'partial')
      const graph = parseSessionGraph({ nodes: [], sessions: states.map(s => ({ ...s, title: 'concise', automation: resolveAutomationSession(s) })) })
      const grouped = groupFolderSessions([], graph)
      assert.equal(grouped.chats.length, 0)
      assert.equal(grouped.automations[0].sessions.length, 2)
      assert.equal(historical.automation, undefined)
    } finally { store.close?.() }
  })
})
test('organization receipt contract rejects unbounded or inconsistent counts', () => {
  const ref = systemAutomationRef('work-organizer', organizerId, 'full')
  assert.throws(() => parseAutomationSessionRef({ ...ref, organization: { mode:'full', status:'partial', coveredCount: 4, manifestCount: 3, patches: 1 } }))
})
