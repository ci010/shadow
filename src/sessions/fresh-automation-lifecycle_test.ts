import { backgroundTasksPlugin } from '../agent/background-task-routes.ts'
import { projectWorkOverview } from '../projects/work-routes.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { Tools } from '../tools/registry.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import { sessionsApiPlugin } from './routes.ts'
import { SessionProfileService } from './profile.ts'
import { createSessionsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from '../tools/context.ts'

function fixture(root: string, store: SessionStore, emit: () => Promise<void> = async () => {}) {
  const requests: ChatMessage[][] = []
  const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat(messages) {
    requests.push(structuredClone(messages))
    return { content: `result-${requests.length}`, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  } }
  const manager = new SessionManager({ workspace: root, store, projectId: 'fixture-project', bus: new Bus(), provider,
    tools: new Tools(root), backgroundTasks: { listTasks: () => [] },
    agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }) },
    handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
    events: { emit }, context: { buildSystemPrompt: async (context: unknown) => JSON.stringify(context) },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
  } as unknown as SessionManagerDeps)
  return { manager, requests }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: explicit caller barrier, historical APIs and indexed execution-key replay after restart`, async () => {
    await withTempWorkspace(async root => {
      const store = new Store(join(root, 'sessions')); await store.init()
      const f = fixture(root, store)
      try {
        await f.manager.start()
        const ids: string[] = []
        for (let index = 0; index < 3; index++) {
          const runId = crypto.randomUUID(), id = `cron:${runId}`
          ids.push(id)
          await f.manager.startSession({ channel: 'cron', chatId: runId, agentType: 'general', mode: 'task',
            task: `run-sentinel-${index}`, waitForCompletion: true,
            automation: { jobId: 'fixture-job', name: 'Fixture', runId, contextMode: 'fresh', startedAt: new Date().toISOString() },
            statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'fixture-job' },
          })
          const state = f.manager.getSessionState(id)!
          assert.equal(state.executionStatus, 'completed')
          assert.equal(await store.readArchivedState(id), null, 'completion is not caller finalization')
          state.executionKey = `fixture-key-${index}`
          await store.saveState(id, state)
          assert.equal(await f.manager.finalizeAutomation(id), true)
          assert.equal(f.manager.getSessionState(id), null)
          assert.equal(f.manager.getActiveSession(id), undefined)
          const result = await f.manager.getExecutionResult(id)
          assert.equal(result?.content, `result-${index + 1}`)
          const history = await f.manager.getHistory(id)
          assert.ok(JSON.stringify(history.messages).includes(`run-sentinel-${index}`))
          assert.ok(!JSON.stringify(f.requests[index]).includes(`run-sentinel-${index - 1}`))
        }
        const archived = (await f.manager.readSessionState(ids[0]!))!
        await assert.rejects((f.manager as unknown as { saveState(id: string, state: SessionState): Promise<void> }).saveState(archived.sessionId, archived), /already archived/)
        assert.equal(f.manager.getSessionState(archived.sessionId), null, 'late manager writes do not repopulate live maps')
        const physicalId = physicalSessionId(archived)
        assert.equal((await f.manager.getHistory(ids[0]!, { physicalId })).total > 0, true)
        const details = await f.manager.getSessionDetails(ids[0]!)
        assert.equal(details?.sessionId, ids[0])
        const profile = await new SessionProfileService(f.manager, 'fixture-project').query(ids[0]!)
        assert.equal(profile?.sessionId, ids[0])
        const app = new Hono(); sessionsApiPlugin(f.manager)(app)
        backgroundTasksPlugin({ listTasks: () => [] }, async id => !!await f.manager.readSessionState(id))(app)
        assert.equal((await app.request(`/api/sessions/${encodeURIComponent(ids[0]!)}/background-tasks`)).status, 200)
        const originalAlignment = f.manager.alignment
        f.manager.alignment = { store: { workRecords: () => [], workEffects: () => [], projectFocus: () => undefined }, decisionContext: () => undefined } as unknown as NonNullable<typeof f.manager.alignment>
        try {
          const overview = await projectWorkOverview(f.manager)
          assert.equal(overview.sessions.length, 3)
          assert.ok(overview.sessions.every(session => !session.assignable && session.activity === 'completed'))
        } finally { f.manager.alignment = originalAlignment }
        assert.equal((await app.request(`/api/sessions/${encodeURIComponent(ids[0]!)}`)).status, 200)
        assert.equal((await app.request(`/api/sessions/${encodeURIComponent(ids[0]!)}/details`)).status, 200)
        assert.equal((await app.request(`/api/sessions/${encodeURIComponent(ids[0]!)}/cancel`, { method: 'POST' })).status, 404)
        const virtual = createSessionsHandler(f.manager)
        const context = { projectId: 'fixture-project', sessionId: 'web:owner', signal: new AbortController().signal } as ExecutionContext
        assert.match(await virtual.read(ids[0]!, context), /run-sentinel-0/)
        assert.equal(f.manager.listSessions().length, 0)
        await f.manager.stop()
        await f.manager.start()
        let replays = 0
        const receipt = JSON.parse(await f.manager.executeOnce('fixture-key-0', async () => { replays++; return 'never' }))
        assert.equal(receipt.sessionId, ids[0])
        assert.equal(receipt.status, 'completed')
        assert.equal(replays, 0)
        assert.equal(f.requests.length, 3)
        assert.equal(f.manager.getSessionState(ids[0]!), null)
        assert.equal(f.manager.hasHistoricalWorkdir({ version: 1, nodeId: 'foreign', capabilityId: 'foreign' }), false)
        await assert.rejects(f.manager.buildSession(ids[0]!), /existing session/)
      } finally { await f.manager.stop(); store.close() }
    })
  })

  test(`${Store.name}: interrupted caller/report barriers survive restart without provider replay`, async () => {
    await withTempWorkspace(async root => {
      const store = new Store(join(root, 'sessions')); await store.init()
      const owner: SessionState = { sessionId: 'web:owner', projectId: 'fixture-project', ownershipVersion: 2, mode: 'session', segmentIndex: 0 }
      const run: SessionState = { sessionId: 'cron:interrupted', executionId: 'cron:interrupted', projectId: 'fixture-project', ownershipVersion: 2,
        physicalIdVersion: 2, mode: 'task', segmentIndex: 0, executionStatus: 'completed', reportTo: owner.sessionId,
        lastActivityAt: new Date().toISOString(), automationCallerSettled: true,
        automation: { jobId: 'job', name: 'Fixture', runId: 'run', contextMode: 'fresh', startedAt: new Date().toISOString() },
        statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'job' } }
      await store.saveState(owner.sessionId, owner); await store.saveState(run.sessionId, run)
      await store.createSessionLog(physicalSessionId(run), [{ execution_receipt: { sessionId: run.sessionId, turnId: 'turn', inputId: 'input',
        source: { kind: 'session', sessionId: owner.sessionId }, status: 'completed', content: 'durable-result' } }])
      let reports = 0, fail = true
      const f = fixture(root, store, async () => { reports++; if (fail) throw new Error('Synthetic report failure') })
      try {
        await assert.rejects(f.manager.start(), /Synthetic report failure/)
        assert.equal((await store.listAllStates())[run.sessionId]?.completionReported, undefined)
        assert.equal(await store.readArchivedState(run.sessionId), null)
        assert.equal(f.requests.length, 0)
        await f.manager.stop(); fail = false
        await f.manager.start()
        assert.equal(reports, 2)
        assert.equal((await store.readArchivedState(run.sessionId))?.completionReported, true)
        assert.equal(f.manager.getSessionState(run.sessionId), null)
        assert.equal(f.requests.length, 0)
      } finally { await f.manager.stop(); store.close() }
    })
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: archived automation retains exact descendant usage and indexed pages`, async () => {
  await withTempWorkspace(async root => {
    const store = new Store(join(root, 'sessions')); await store.init()
    const parent: SessionState = { sessionId: 'cron:parent', executionId: 'cron:parent', projectId: 'fixture-project', ownershipVersion: 2,
      physicalIdVersion: 2, mode: 'task', segmentIndex: 0, executionStatus: 'completed', children: ['virtual:child'], automationCallerSettled: true,
      automation: { jobId: 'job', name: 'Fixture', runId: 'run', contextMode: 'fresh', startedAt: '2026-01-01T00:00:00.000Z' },
      statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'job' } }
    const child: SessionState = { sessionId: 'virtual:child', executionId: 'virtual:child', projectId: 'fixture-project', ownershipVersion: 2,
      physicalIdVersion: 2, mode: 'task', segmentIndex: 0, executionStatus: 'completed', parentSessionId: parent.sessionId }
    for (const state of [parent, child]) {
      await store.saveState(state.sessionId, state)
      await store.createSessionLog(physicalSessionId(state), [{ type: 'model_usage', sessionId: state.sessionId, id: 'provider-call', timestamp: '2026-01-01T01:00:00.000Z', usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }])
    }
    const f = fixture(root, store)
    try {
      await f.manager.start()
      assert.equal(f.manager.getSessionState(parent.sessionId), null)
      assert.ok(f.manager.getSessionState(child.sessionId))
      assert.equal((await f.manager.getChildren(parent.sessionId))[0]?.sessionId, child.sessionId)
      const own = await f.manager.getProfileUsage([parent.sessionId], -Infinity, Infinity, undefined, false)
      const inclusive = await f.manager.getProfileUsage([parent.sessionId], -Infinity, Infinity)
      assert.equal(own.providerCalls, 1)
      assert.equal(inclusive.providerCalls, 2)
      const page = await f.manager.querySessionHistoryStates({ jobId: 'job', limit: 1 })
      assert.equal(page.total, 1)
      assert.equal(page.states[0]?.sessionId, parent.sessionId)
      assert.equal((await f.manager.automationFeatureStates()).filter(state => state.automation).length, 1)
      assert.equal(f.requests.length, 0)
    } finally { await f.manager.stop(); store.close() }
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: observer receipt and organizer outcome barriers settle independently, interrupted organizer stays live`, async () => {
  await withTempWorkspace(async root => {
    const { systemAutomationRef } = await import('../cron/contracts.ts')
    const store = new Store(join(root, 'sessions')); await store.init()
    const f = fixture(root, store)
    try {
      await f.manager.start()
      for (const role of ['work-organizer', 'work-observer'] as const) {
        const chatId = crypto.randomUUID(), id = `${role}:${chatId}`
        const automation = systemAutomationRef(role, id, role === 'work-organizer' ? 'delta' : undefined)
        await f.manager.startSession({ channel: role, chatId, agentType: role, mode: 'task', task: role, waitForCompletion: true,
          automation, statePersistence: { version: 1, kind: 'fresh-automation', jobId: automation.jobId },
          executionLimits: { allowedTools: [], inferenceRequests: 1, toolCalls: 1, argumentBytes: 1 } })
        assert.equal(await store.readArchivedState(id), null)
        if (role === 'work-organizer') {
          await f.manager.stop(); await f.manager.start()
          assert.ok(f.manager.getSessionState(id), 'execution complete without the domain outcome remains unsettled after restart')
          assert.equal(f.requests.length, 1, 'recovery does not replay provider work')
          await f.manager.updateAutomationOrganization(id, { mode: 'delta', status: 'partial', coveredCount: 1, manifestCount: 2, patches: 1 }, 'unfinished')
        }
        assert.equal((await f.manager.getExecutionResult(id))?.status, 'completed')
        assert.equal(await f.manager.finalizeAutomation(id), true)
        const archived = (await f.manager.readSessionState(id))!
        assert.equal(archived.automationCallerSettled, true)
        if (role === 'work-organizer') {
          assert.equal(archived.automation?.organization?.status, 'partial')
          assert.equal(archived.automation?.organizationProblem, 'unfinished')
        }
        assert.equal(f.manager.getSessionState(id), null)
      }
      assert.equal(f.requests.length, 2)
    } finally { await f.manager.stop(); store.close() }
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const archived of [false, true]) test(`${Store.name}: deletion preflight preserves entire tree with ${archived ? 'archived' : 'live'} fresh descendant`, async () => {
    await withTempWorkspace(async root => {
      const store = new Store(join(root, 'sessions')); await store.init()
      const parent: SessionState = { sessionId: 'web:delete-parent', projectId: 'fixture-project', ownershipVersion: 2, physicalIdVersion: 2, mode: 'session', segmentIndex: 0 }
      const sibling: SessionState = { ...parent, sessionId: 'virtual:sibling', parentSessionId: parent.sessionId, mode: 'task', executionStatus: 'completed' }
      const bridge: SessionState = { ...sibling, sessionId: 'virtual:bridge' }
      const fresh: SessionState = { ...sibling, sessionId: 'cron:fresh', executionId: 'cron:fresh', parentSessionId: bridge.sessionId,
        automationCallerSettled: archived,
        automation: { jobId: 'delete-job', name: 'Delete fixture', runId: 'fresh', contextMode: 'fresh', startedAt: '2026-01-01T00:00:00.000Z' },
        statePersistence: { version: 1, kind: 'fresh-automation', jobId: 'delete-job' } }
      for (const state of [parent, sibling, bridge, fresh]) {
        await store.saveState(state.sessionId, state)
        await store.createSessionLog(physicalSessionId(state), [{ sentinel: state.sessionId }])
      }
      if (archived) await store.archiveState(fresh)
      const f = fixture(root, store)
      try {
        await f.manager.start()
        const snapshot = async () => ({ live: await store.listAllStates(), archive: await store.queryArchivedStates({}),
          logs: await Promise.all([parent, sibling, bridge, fresh].map(async state => {
            const rows = []; for await (const row of store.readSessionLog(physicalSessionId(state))) rows.push(row)
            return rows
          })), manager: structuredClone([parent, sibling, bridge, fresh].map(state => f.manager.getSessionState(state.sessionId))) })
        const before = await snapshot()
        for (const id of [parent.sessionId, fresh.sessionId]) {
          await assert.rejects(f.manager.deleteSession(id), /Fresh automation history deletion is not supported/)
          assert.deepEqual(await snapshot(), before)
        }
        assert.deepEqual(await f.manager.deleteSession(sibling.sessionId), [sibling.sessionId], 'unrelated ordinary deletion remains available')
      } finally { await f.manager.stop(); store.close() }
    })
  })

  test(`${Store.name}: tied history pages use identical archive/live/legacy ordering`, async () => {
    await withTempWorkspace(async root => {
      const store = new Store(join(root, 'sessions')); await store.init()
      const f = fixture(root, store)
      try {
        for (const name of ['a', 'b', 'c', 'B', 'd', 'e']) {
          const state: SessionState = { sessionId: `cron:${name}`, executionId: `cron:${name}`, projectId: 'fixture-project', ownershipVersion: 2,
            physicalIdVersion: 2, mode: 'task', segmentIndex: 0, executionStatus: 'completed', automationCallerSettled: !['d', 'e'].includes(name),
            automation: { jobId: 'ties', name: 'Ties', runId: name, contextMode: 'fresh', startedAt: '2026-01-01T00:00:00.000Z' },
            ...(name !== 'e' ? { statePersistence: { version: 1 as const, kind: 'fresh-automation' as const, jobId: 'ties' } } : {}) }
          await store.saveState(state.sessionId, state)
          if (!['d', 'e'].includes(name)) await store.archiveState(state)
        }
        await f.manager.start()
        const expected = ['e', 'd', 'c', 'b', 'a', 'B'].map(name => `cron:${name}`)
        assert.deepEqual((await store.queryArchivedStates({ jobId: 'ties' })).map(state => state.sessionId), expected.slice(2))
        for (const limit of [1, 2, 3, 10]) for (let offset = 0; offset <= expected.length; offset++) {
          const page = await f.manager.querySessionHistoryStates({ jobId: 'ties', offset, limit })
          assert.equal(page.total, expected.length)
          assert.deepEqual(page.states.map(state => state.sessionId), expected.slice(offset, offset + limit))
        }
      } finally { await f.manager.stop(); store.close() }
    })
  })
}
