import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Bus } from '../bus/bus.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionState, SessionStore } from './session-store.ts'

function manager(workspace: string, store: SessionStore) {
  return new SessionManager({
    workspace, projectId: 'fixture', store, bus: new Bus(), tools: new Tools(workspace),
    provider: { name: 'fixture', listModels: () => [], chat: async () => { throw new Error('No inference expected') } },
    backgroundTasks: { listTasks: () => [] },
    agentTypes: { resolve: (name: string) => ({ name, prompt: '', defaultMode: 'session' }) },
    context: { buildSystemPrompt: async () => '' },
    handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
  } as unknown as SessionManagerDeps)
}

// Deliberately invalid snapshots: any accidental archive hydration fails loudly.
// This is an index/startup scaling fixture, not a realistic compression benchmark.
for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: 1k/10k/100k cold index entries stay out of startup and navigation`, async t => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      let store: SessionStore = new Store(directory)
      await store.init()
      const state: SessionState = { sessionId: 'web:chat-seed', projectId: 'fixture', physicalIdVersion: 2,
        segmentIndex: 0, mode: 'session', executionStatus: 'completed', lastActivityAt: '2020-01-01T00:00:00.000Z' }
      await store.saveState(state.sessionId, state)
      await store.createSessionLog(physicalSessionId(state), [{ role: 'user', content: 'seed', timestamp: state.lastActivityAt }])
      const current = (await store.getState(state.sessionId))!
      await store.archiveConversation!({ ...current, retirement: {
        retiredAt: '2020-01-02T00:00:00.000Z', fingerprint: 'a'.repeat(64), assessorSessionId: 'cron:fixture', reason: 'fixture',
      } })
      const activeIds = Array.from({ length: 20 }, (_, index) => `web:chat-active-${index}`)
      for (const sessionId of activeIds) await store.saveState(sessionId, { ...state, sessionId })
      store.close?.()
      const db = new DatabaseSync(join(directory, '.conversation-archive-v1', 'archive.db'))
      db.exec('PRAGMA busy_timeout=5000')
      try {
        const insert = db.prepare('INSERT INTO archives(id,project,at,summary,state,pending,committed) VALUES(?,?,?,?,?,NULL,1)')
        let count = 0
        for (const target of [1000, 10000, 100000]) {
          db.exec('BEGIN')
          try {
            for (; count < target; count++) {
              const id = `web:chat-cold-${String(count).padStart(6, '0')}`
              const summary = { sessionId: id, projectId: 'fixture', archivedAt: '2021-01-01T00:00:00.000Z', segmentIndex: 0, recordCount: 0, byteLength: 0 }
              insert.run(id, 'fixture', summary.archivedAt, JSON.stringify(summary), 'not-json: must never hydrate at startup')
            }
            db.exec('COMMIT')
          } catch (error) { db.exec('ROLLBACK'); throw error }
          store = new Store(directory)
          const started = performance.now()
          await store.init()
          const sessions = manager(workspace, store)
          try {
            await sessions.start()
            const startupMs = performance.now() - started
            assert.deepEqual(sessions.listSessions().map(row => row.sessionId).sort(), [...activeIds].sort())
            assert.deepEqual(Object.keys(await store.listAllStates()).sort(), [...activeIds].sort())
            assert.deepEqual((await sessions.listSummaryStates()).map(row => row.sessionId).sort(), [...activeIds].sort())
            const queried = performance.now()
            const page = await sessions.queryConversationArchives({ limit: 50 })
            assert.equal(page.items.length, 50)
            assert.ok(page.nextCursor)
            const next = await sessions.queryConversationArchives({ limit: 50, cursor: page.nextCursor })
            assert.equal(new Set([...page.items, ...next.items].map(item => item.sessionId)).size, 100)
            t.diagnostic(JSON.stringify({ activeStates: activeIds.length, indexEntries: target + 1, startupMs: +startupMs.toFixed(2), twoPagesMs: +(performance.now() - queried).toFixed(2), hydratedColdStates: 0 }))
          } finally { await sessions.stop(); store.close?.() }
        }
      } finally { db.close(); store.close?.() }
    })
  })
}
