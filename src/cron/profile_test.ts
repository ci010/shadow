import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { readAutomationUsage } from '../sessions/automation-usage.ts'
import { AutomationProfileService } from './profile.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { CronService } from './service.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: UTC rolling window, real iterations, zero vs unknown and dedup`, async () => {
  await withTempWorkspace(async workspace => {
    const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
    const state = { sessionId: 'run', segmentIndex: 0 }
    const asOf = Date.parse('2026-10-11T00:00:00Z'), from = asOf - 86400000
    const event = (id: string, timestamp: number, usage: unknown) => ({ type: 'model_usage', sessionId: 'run', id, timestamp: new Date(timestamp).toISOString(), usage })
    const known = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 5 }
    try {
      await store.createSessionLog(physicalSessionId(state), [event('before', from - 1, known), event('boundary', from, known), event('zero', from + 1, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }), event('failed', from + 2, null), event('failed', from + 2, null), event('end', asOf, known),
        { role: 'assistant', timestamp: new Date(from + 2).toISOString(), usage: known },
        { role: 'tool', tool_call_id: 'tool1', timestamp: new Date(from + 2).toISOString() }, { role: 'tool', tool_call_id: 'tool1', timestamp: new Date(from + 2).toISOString() },
        { ...event('foreign', from + 2, known), sessionId: 'foreign' }])
      const usage = await readAutomationUsage(store, [state], from, asOf)
      assert.equal(usage.providerCalls, 3); assert.equal(usage.knownUsageCalls, 2); assert.equal(usage.unknownUsageCalls, 1)
      assert.equal(usage.inputTokens, 10); assert.equal(usage.totalTokens, 12); assert.equal(usage.toolCalls, 1)
      await store.createSessionLog(physicalSessionId({ sessionId: 'old', segmentIndex: 0 }), [{ role: 'assistant', usage: known }])
      const old = await readAutomationUsage(store, [{ sessionId: 'old', segmentIndex: 0 }], from, asOf)
      assert.equal(old.inputTokens, null); assert.equal(old.untrackedSessions, 1)
    } finally { store.close?.() }
  })
})

test('canonical service exact provenance, Project isolation, policy', async () => {
  const asOf = Date.parse('2026-10-11T00:00:00Z')
  const ref = { jobId: 'system:work-organizer', name: 'Organizer', runId: 'run', startedAt: new Date(asOf - 1).toISOString(), contextMode: 'fresh', config: { source: 'system', schedule: 'old', organizationMode: 'delta' }, organization: { status: 'partial' } }
  const states = [{ sessionId: 'run', projectId: 'project', automation: ref }, { sessionId: 'foreign', projectId: 'other', automation: ref }, { sessionId: 'unmarked', projectId: 'project', agentType: 'work-organizer' }]
  let selected: string[] = []
  const sessions = { automationFeatureStates: async () => states, listHistoryStates: async () => states, listSessions: () => states, getSessionState: (id: string) => states.find(state => state.sessionId === id), getAutomationUsage: async (ids: string[]) => { selected = ids; return { providerCalls: 3, knownUsageCalls: 0, unknownUsageCalls: 3, inputTokens: null, outputTokens: null, totalTokens: null, toolCalls: 0, trackedSessions: 1, untrackedSessions: 0 } } } as unknown as SessionManager
  const service = new AutomationProfileService({ listJobs: () => [] } as unknown as CronService, sessions, 'project', () => ({ kind: 'event', scope: 'current_runtime', description: 'Explicit full or delta organization' }), () => asOf)
  const profile = await service.query('system:work-organizer')
  assert.deepEqual(selected, ['run']); assert.equal(profile?.runs.partial, 1); assert.equal(profile?.runs.delta, 1); assert.equal(profile?.usage.providerCalls, 3)
  assert.equal(profile?.frequency.kind, 'event'); assert.equal(profile?.coverage, 'partial')

})

test('profile HTTP reads only mounted Project feature and returns sanitized aggregates', async () => {
  const { Hono } = await import('hono')
  const { registerAutomationRoutes } = await import('./routes.ts')
  const app = new Hono()
  const sessions = { automationFeatureStates: async () => [], listHistoryStates: async () => [], listSessions: () => [], getAutomationUsage: async () => ({ providerCalls: 0, knownUsageCalls: 0, unknownUsageCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null, toolCalls: 0, trackedSessions: 0, untrackedSessions: 0 }) } as unknown as SessionManager
  const cron = { listJobs: () => [] } as unknown as CronService
  registerAutomationRoutes(app, cron, sessions, 'project')
  const response = await app.request('/api/automations/system%3Awork-organizer/profile')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.profile.coverage, 'unknown'); assert.equal(body.profile.usage.inputTokens, null)
  assert.equal(JSON.stringify(body).includes('prompt'), false)
  assert.equal((await app.request('/api/automations/another-project-feature/profile')).status, 404)
})

test('foreground source scan is bounded and exposes lower-bound telemetry', async () => {
  const store = { async *readSessionLog() { for (let i = 0; i < 100_001; i++) yield { type: 'model_usage', sessionId: 'run', id: String(i), timestamp: '2026-10-10T12:00:00Z', usage: null } } } as unknown as SessionStore
  const result = await readAutomationUsage(store, [{ sessionId: 'run', segmentIndex: 0 }], Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z'))
  assert.equal(result.providerCalls, 100_000); assert.equal(result.scanLimitReached, true); assert.equal(result.untrackedSessions, 1)
})

test('learning ledger partial is counted; absent outcome is unknown, never invented completion', async () => {
  const asOf = Date.parse('2026-10-11T00:00:00Z')
  const states = ['partial', 'missing'].map(id => ({ sessionId: id, projectId: 'project', executionStatus: 'completed', automation: { jobId: 'learning:reflector', name: 'Reflection', runId: id, startedAt: new Date(asOf - 1).toISOString(), contextMode: 'fresh', config: { source: 'learning', schedule: 'every 30m' } } }))
  const sessions = { automationFeatureStates: async () => states, listHistoryStates: async () => states, listSessions: () => states, getSessionState: (id: string) => states.find(state => state.sessionId === id), getAutomationUsage: async () => ({ providerCalls: 0, knownUsageCalls: 0, unknownUsageCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null, toolCalls: 0, trackedSessions: 0, untrackedSessions: 2 }) } as unknown as SessionManager
  const service = new AutomationProfileService({ listJobs: () => [] } as unknown as CronService, sessions, 'project', undefined, () => asOf, id => id === 'partial' ? { status: 'partial', summary: '', artifacts: 0, events: 0, evaluated: 0 } : undefined)
  const profile = await service.query('learning:reflector')
  assert.equal(profile?.runs.partial, 1); assert.equal(profile?.runs.unknown, 1); assert.equal(profile?.runs.completed, 0)
})

test('Project-mounted profile URLs normalize trailing slash and preserve encoded feature IDs', async () => {
  const { Hono } = await import('hono')
  const { registerAutomationRoutes } = await import('./routes.ts')
  const { automationProfileUrl, sessionProfileUrl } = await import('../../app/src/profile-api.ts')
  const { projectBase } = await import('../../app/src/api-url.ts')
  const project = new Hono(), gateway = new Hono()
  const sessions = { automationFeatureStates: async () => [], listHistoryStates: async () => [], listSessions: () => [], getAutomationUsage: async () => ({ providerCalls: 0, knownUsageCalls: 0, unknownUsageCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null, toolCalls: 0, trackedSessions: 0, untrackedSessions: 0 }) } as unknown as SessionManager
  registerAutomationRoutes(project, { listJobs: () => [] } as unknown as CronService, sessions, 'project')
  gateway.route('/projects/project', project)
  const base = projectBase('http://localhost:3000/', 'project')
  // The former template-string join inserts a double slash and misses the mounted route.
  assert.equal((await gateway.request(`${base}/api/automations/system%3Awork-organizer/profile`)).status, 404)
  for (const candidate of [base, base.replace(/\/$/, '')]) {
    const url = automationProfileUrl(candidate, 'system:work-organizer')
    assert.equal(url.pathname, '/projects/project/api/automations/system%3Awork-organizer/profile')
    const response = await gateway.request(url.toString())
    assert.equal(response.status, 200)
    assert.equal((await response.json()).profile.featureId, 'system:work-organizer')
    assert.equal(sessionProfileUrl(candidate, 'web:root').pathname, '/projects/project/api/sessions/web%3Aroot/profile')
    assert.equal((await gateway.request(automationProfileUrl(candidate, 'foreign:feature').toString())).status, 404)
  }
})


test('organizer business progress and execution failure remain independent aggregates',async()=>{
  const asOf=Date.parse('2026-10-11T00:00:00Z')
  const states=['failed','cancelled','completed'].map((executionStatus,i)=>({sessionId:'axis-'+i,projectId:'project',executionStatus,
    automation:{jobId:'system:work-organizer',name:'Organizer',runId:'axis-'+i,startedAt:new Date(asOf-1).toISOString(),contextMode:'fresh',
      config:{source:'system',schedule:'event',organizationMode:'delta'},
      ...(i<2?{organization:{mode:'delta',status:'partial',patches:1,coveredCount:1,manifestCount:3}}:{})}}))
  const sessions={listHistoryStates:async()=>states,getAutomationUsage:async()=>({providerCalls:0,knownUsageCalls:0,unknownUsageCalls:0,inputTokens:null,outputTokens:null,totalTokens:null,toolCalls:0,trackedSessions:0,untrackedSessions:0})} as unknown as SessionManager
  const profile=await new AutomationProfileService({listJobs:()=>[]} as unknown as CronService,sessions,'project',undefined,()=>asOf).query('system:work-organizer')
  assert.deepEqual(profile?.executionOutcomes,{failed:1,cancelled:1,completed:1,running:0,unknown:0})
  assert.deepEqual(profile?.organizationOutcomes,{completed:0,partial:2,running:0,unknown:1,committedRuns:2,patches:2,coveredCount:2})
  assert.equal(profile?.runs.failed,1)
  assert.equal(profile?.runs.cancelled,1)
})
