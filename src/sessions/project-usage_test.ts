import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { readProjectUsage, readProjectUsagePage } from './project-usage.ts'
import { usageProvider } from './usage.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { projectUsageSchema } from '../projects/usage-contract.ts'
import { sessionsApiPlugin } from './routes.ts'
import { SessionManager } from './session-manager.ts'

const now = Date.parse('2026-10-01T12:00:00Z')
const tokens = { promptTokens: 10, completionTokens: 2, totalTokens: 12, costs: [{ currency: 'USD' as const, amount: 0.2 }] }
for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: Project usage dates, currencies, missing data, segments and isolation survive restart`, async () => {
    await withTempWorkspace(async workspace => {
      let store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const state: SessionState = { sessionId: 'web:usage', projectId: 'p', segmentIndex: 1, physicalIdVersion: 2 }
      const child: SessionState = { sessionId: 'child', projectId: 'p', segmentIndex: 0, parentSessionId: state.sessionId }
      const foreign: SessionState = { sessionId: 'foreign', projectId: 'q', segmentIndex: 0 }
      const event = (id: string, timestamp: string, usage: unknown = tokens, durationMs?: number) => ({ type: 'model_usage', sessionId: state.sessionId, id, timestamp, usage, durationMs })
      const duplicated = event('today', '2026-10-01T00:00:00Z', tokens, 1200)
      try {
        await store.createSessionLog(physicalSessionId(state, 0), [event('old', '2026-09-24T23:59:59Z'), event('seven', '2026-09-25T00:00:00Z'), duplicated])
        await store.createSessionLog(physicalSessionId(state, 1), [duplicated, event('missing', '2026-10-01T01:00:00Z', null), event('other-currency', '2026-10-01T02:00:00Z', { ...tokens, costIncomplete: true, costs: [{ currency: 'CNY', amount: 1 }] }, 0), event('future', '2026-10-01T12:00:00Z'), event('undated', 'invalid'), { role: 'assistant', timestamp: '2026-10-01T01:00:00Z', usage: tokens }])
        await store.createSessionLog(physicalSessionId(child), [{ ...duplicated, sessionId: child.sessionId }])
        await store.createSessionLog(physicalSessionId(foreign), [{ ...duplicated, sessionId: foreign.sessionId }])
        store.close?.(); store = new Store(join(workspace, 'sessions')); await store.init()
        const result = projectUsageSchema.parse(await readProjectUsage(store, [state, child, state, foreign], 'p', now))
        assert.equal(result.total.calls, 6)
        assert.equal(result.total.tokens, 60)
        assert.equal(result.past7Days.calls, 5)
        assert.equal(result.today.calls, 4)
        assert.deepEqual(result.month, result.today)
        assert.equal(result.today.durationMs, 2400)
        assert.equal(result.today.unknownDurationCalls, 1)
        assert.equal(result.today.unknownTokenCalls, 1)
        assert.equal(result.today.unknownCostCalls, 2)
        assert.deepEqual(result.today.costs, [{ currency: 'USD', amount: 0.4 }, { currency: 'CNY', amount: 1 }])
        assert.equal(result.undatedCalls, 1)
        assert.equal(result.untrackedSessions, 0)
        assert.deepEqual(result.daily.find(row => row.date === '2026-10-01')?.usage, result.today)
        assert.equal(result.daily.find(row => row.date === '2026-09-30')?.usage.calls, 0)
      } finally { store.close?.() }
    })
  })
  test(`${Store.name}: provider duration persists for successful and failed calls`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const state: SessionState = { sessionId: 'duration', projectId: 'p', segmentIndex: 0 }
      try {
        await store.createSessionLog(physicalSessionId(state), [])
        let fails = false
        const provider = usageProvider({ name: 'fixture', listModels: () => [], async chat() { if (fails) throw new Error('synthetic'); return { content: '', toolCalls: [], usage: tokens } } }, store, () => ({ sessionId: state.sessionId, physicalId: physicalSessionId(state) }))
        await provider.chat([], [], { model: 'fixture' }); fails = true
        await assert.rejects(provider.chat([], [], { model: 'fixture' }), /synthetic/)
        const result = await readProjectUsage(store, [state], 'p', Date.now() + 1)
        assert.equal(result.total.calls, 2)
        assert.equal(result.total.unknownDurationCalls, 0)
        assert.equal(result.total.unknownTokenCalls, 1)
        assert.ok(result.total.durationMs !== null && result.total.durationMs >= 0)
      } finally { store.close?.() }
    })
  })
}

test('bounded scans, legacy telemetry and abort are explicit', async () => {
  const state = { sessionId: 'a', projectId: 'p', segmentIndex: 0 }
  const store = { async *readSessionLog() { for (let i = 0; i <= 100_000; i++) yield { role: 'assistant' } } } as unknown as SessionStore
  const result = await readProjectUsage(store, [state], 'p', now)
  assert.equal(result.scanLimitReached, true)
  assert.equal(result.untrackedSessions, 1)
  assert.equal(result.total.tokens, null)
  assert.equal(result.total.durationMs, null)
  assert.deepEqual(result.total.costs, [])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readProjectUsage(store, [state], 'p', now, controller.signal), { name: 'AbortError' })
})

test('Project usage HTTP is context-authorized, Project-bound, no-store and forwards abort signal', async () => {
  let called = false
  const manager = { projectId: 'p', getProjectUsage: async (signal: AbortSignal) => { called = true; assert.ok(signal); return { projectId: 'p' } } } as unknown as SessionManager
  const missingAuthorization = new Hono(); sessionsApiPlugin(manager)(missingAuthorization)
  assert.equal((await missingAuthorization.request('/api/project/usage')).status, 401)
  const denied = new Hono(); sessionsApiPlugin(manager, { authorizeContext: () => false })(denied)
  assert.equal((await denied.request('/api/project/usage?projectId=q')).status, 401)
  assert.equal(called, false)
  const allowed = new Hono(); sessionsApiPlugin(manager, { authorizeContext: () => true })(allowed)
  const response = await allowed.request('/api/project/usage?projectId=q')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { projectId: 'p' })
})


test('history pages are bounded, cached, Project-isolated and distinct from recent trends', async () => {
  let scans = 0
  const store = { async *readSessionLog(id: string) {
    scans++
    for (let i = 0; i < 46; i++) yield { type: 'model_usage', sessionId: id.startsWith('p-session') ? 'p-session' : 'q-session', id: String(i), timestamp: new Date(now - (i + 1) * 86400000).toISOString(), usage: tokens }
  } } as unknown as SessionStore
  const states = [{ sessionId: 'p-session', projectId: 'p', segmentIndex: 0 }, { sessionId: 'q-session', projectId: 'q', segmentIndex: 0 }]
  const summary = await readProjectUsage(store, states, 'p', now)
  assert.equal(summary.total.calls, 46)
  assert.equal(summary.daily.length, 31)
  assert.equal(summary.daily.at(-1)?.date, '2026-09-01')
  const first = await readProjectUsagePage(store, states, 'p', now, 1)
  assert.equal(first.daily.length, 10); assert.equal(first.total, 47); assert.equal(first.hasMore, true)
  const last = await readProjectUsagePage(store, states, 'p', now, 5)
  assert.equal(last.daily.length, 7); assert.equal(last.hasMore, false)
  assert.ok(last.daily.every(day => day.date < '2026-09-01'))
  const beyond = await readProjectUsagePage(store, states, 'p', now, 6)
  assert.deepEqual(beyond.daily, []); assert.equal(beyond.hasMore, false)
  assert.equal(scans, 1)
  await readProjectUsagePage(store, states, 'q', now, 1); assert.equal(scans, 2)
  await assert.rejects(readProjectUsagePage(store, states, 'p', now, 0), /Invalid/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(readProjectUsagePage(store, states, 'p', now, 1, abort.signal), { name: 'AbortError' })
})

test('daily endpoint validates pages after authorization and never accepts caller Project scope', async () => {
  let calls = 0
  const manager = { projectId: 'p', getProjectUsagePage: async (page: number, signal: AbortSignal) => { calls++; assert.ok(signal); return { projectId: 'p', page } } } as unknown as SessionManager
  const denied = new Hono(); sessionsApiPlugin(manager, { authorizeContext: () => false })(denied)
  assert.equal((await denied.request('/api/project/usage/daily?page=1')).status, 401)
  assert.equal(calls, 0)
  const app = new Hono(); sessionsApiPlugin(manager, { authorizeContext: () => true })(app)
  for (const value of ['0', '-1', '1.2', '', 'abc', '100001', '1e2']) assert.equal((await app.request('/api/project/usage/daily?page=' + value)).status, 400)
  const response = await app.request('/api/project/usage/daily?page=2&projectId=q')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { projectId: 'p', page: 2 })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: named activity uses source results, UTC windows and logical-call deduplication`, async () => {
    await withTempWorkspace(async workspace => {
      let store: SessionStore = new Store(join(workspace, 'activity')); await store.init()
      const state = { sessionId: 'owner', projectId: 'p', segmentIndex: 1 }
      const child = { sessionId: 'child', projectId: 'p', segmentIndex: 0, parent: { id: 'owner', physicalId: physicalSessionId(state, 0), index: 99 } }
      const foreign = { sessionId: 'foreign', projectId: 'q', segmentIndex: 0 }
      const model = (id: string, timestamp: string, name: unknown = 'z-model') => ({ type: 'model_usage', sessionId: 'owner', id, model: name, timestamp, usage: null })
      const call = (id: string, name: string, args: unknown = {}) => ({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      const tool = (id: string, name: string, timestamp = '2026-10-01T00:00:00Z') => ({ role: 'tool', name, tool_call_id: id, timestamp, content: 'Error: synthetic failure' })
      try {
        await store.createSessionLog(physicalSessionId(state, 0), [
          model('old', '2026-09-24T23:59:59.999Z'),
          model('seven', '2026-09-25T00:00:00Z'),
          model('today', '2026-10-01T00:00:00Z', 'a-model'),
          call('dynamic', 'invoke_tool', { name: 'remote.search', args: {} }),
          tool('dynamic', 'invoke_tool'),
          call('unfinished', 'never-executed'),
          call('cross-segment', 'invoke_tool', { name: 'remote.search' }),
          tool('old-tool', 'read', '2026-09-24T23:59:59.999Z'),
          tool('seven-tool', 'read', '2026-09-25T00:00:00Z'),
        ])
        await store.createSessionLog(physicalSessionId(state, 1), [
          model('today', '2026-10-01T00:00:00Z', 'a-model'),
          model('failed', '2026-10-01T01:00:00Z', 'a-model'),
          model('future', '2026-10-01T12:00:00Z', 'excluded'),
          model('undated', 'invalid', 'excluded'), model('legacy', '2026-10-01T01:00:00Z', null),
          tool('dynamic', 'invoke_tool'), tool('cross-segment', 'invoke_tool'),
          call('batch', 'multi_tool_use.parallel', { tool_uses: [
            { recipient_name: 'functions.read', parameters: {} },
            { recipient_name: 'functions.invoke_tool', parameters: { name: 'remote.search', args: {} } },
          ] }), tool('batch', 'multi_tool_use.parallel'), tool('batch', 'multi_tool_use.parallel'),
          tool('future-tool', 'excluded', '2026-10-01T12:00:00Z'), tool('undated-tool', 'excluded', 'invalid'),
          { ...tool('wrong-owner', 'excluded'), sessionId: 'someone-else' },
          call('init', 'invoke_tool', { source: 'source', args: {} }), tool('init', 'invoke_tool'),
        ])
        // Fork snapshots are references, not copied raw events. Same call IDs in
        // genuinely separate logical sessions still represent separate executions.
        await store.createSessionLog(physicalSessionId(child), [tool('dynamic', 'read')])
        await store.createSessionLog(physicalSessionId(foreign), [tool('foreign', 'excluded')])
        store.close?.(); store = new Store(join(workspace, 'activity')); await store.init()
        const result = await readProjectUsage(store, [state, child, state, foreign], 'p', now)
        assert.deepEqual(result.activity.total.models, [{ name: 'a-model', calls: 2 }, { name: 'z-model', calls: 2 }])
        assert.deepEqual(result.activity.today.models, [{ name: 'a-model', calls: 2 }])
        assert.deepEqual(result.activity.past7Days.models, [{ name: 'a-model', calls: 2 }, { name: 'z-model', calls: 1 }])
        assert.deepEqual(result.activity.total.tools, [{ name: 'read', calls: 4 }, { name: 'remote.search', calls: 3 }])
        assert.deepEqual(result.activity.past7Days.tools, [{ name: 'read', calls: 3 }, { name: 'remote.search', calls: 3 }])
        assert.deepEqual(result.activity.today.tools, [{ name: 'remote.search', calls: 3 }, { name: 'read', calls: 2 }])
        assert.deepEqual(result.activity.month, result.activity.today)
      } finally { store.close?.() }
    })
  })
}

test('activity schema supplies independent empty periods for legacy payloads and validates counts', async () => {
  const store = { async *readSessionLog() {} } as unknown as SessionStore
  const { activity: _activity, ...legacy } = await readProjectUsage(store, [], 'p', now)
  const parsed = projectUsageSchema.parse(legacy)
  assert.deepEqual(parsed.activity, { total: { models: [], tools: [] }, today: { models: [], tools: [] }, past7Days: { models: [], tools: [] }, month: { models: [], tools: [] } })
  const mutable = projectUsageSchema.parse(legacy)
  mutable.activity.total.models.push({ name: 'x', calls: 1 })
  assert.deepEqual(projectUsageSchema.parse(legacy).activity.total.models, [])
  assert.equal(projectUsageSchema.safeParse({ ...legacy, activity: { ...parsed.activity, today: { models: [{ name: 'x', calls: -1 }], tools: [] } } }).success, false)
})

test('activity honors month boundaries and the shared source-record scan cap', async () => {
  const state = { sessionId: 'owner', projectId: 'p', segmentIndex: 0 }
  const store = { async *readSessionLog() {
    yield { type: 'model_usage', sessionId: 'owner', id: 'previous-month', model: 'before', timestamp: '2026-09-30T23:59:59.999Z' }
    yield { type: 'model_usage', sessionId: 'owner', id: 'month', model: 'inside', timestamp: '2026-10-01T00:00:00Z' }
    yield { role: 'tool', name: 'before', tool_call_id: 'before', timestamp: '2026-09-30T23:59:59.999Z' }
    yield { role: 'tool', name: 'inside', tool_call_id: 'inside', timestamp: '2026-10-01T00:00:00Z' }
    for (let i = 4; i < 100_000; i++) yield { role: 'assistant' }
    yield { role: 'tool', name: 'excluded', tool_call_id: 'cap', timestamp: '2026-10-01T00:00:00Z' }
  } } as unknown as SessionStore
  const result = await readProjectUsage(store, [state], 'p', now)
  assert.equal(result.scanLimitReached, true)
  assert.deepEqual(result.activity.month.models, [{ name: 'inside', calls: 1 }])
  assert.deepEqual(result.activity.month.tools, [{ name: 'inside', calls: 1 }])
  assert.deepEqual(result.activity.total.tools, [{ name: 'before', calls: 1 }, { name: 'inside', calls: 1 }])
})


test('Project usage includes archived automation runs and their child session costs', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions')); await store.init()
    const automation = { sessionId: 'automation:run', projectId: 'p', segmentIndex: 0, automation: { jobId: 'job', runId: 'run', startedAt: '2026-10-01T00:00:00Z' } } as SessionState
    const child: SessionState = { sessionId: 'automation:child', projectId: 'p', segmentIndex: 0, parentSessionId: automation.sessionId }
    try {
      for (const state of [automation, child]) await store.createSessionLog(physicalSessionId(state), [{ type: 'model_usage', id: state.sessionId, sessionId: state.sessionId, timestamp: '2026-10-01T01:00:00Z', model: 'fixture', usage: tokens }])
      const states = await SessionManager.prototype.listHistoryStates.call({ sessionStates: {}, deps: { projectId: 'p' }, store: { queryArchivedStates: async () => [automation, child] } } as unknown as SessionManager)
      const usage = await readProjectUsage(store, states, 'p', now)
      assert.equal(usage.total.calls, 2)
      assert.deepEqual(usage.total.costs, [{ currency: 'USD', amount: 0.4 }])
      assert.deepEqual(usage.activity.past7Days.models, [{ name: 'fixture', calls: 2 }])
    } finally { store.close?.() }
  })
})
