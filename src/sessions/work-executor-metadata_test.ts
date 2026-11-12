import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from '../cron/work-dispatch-contract.ts'
import { resolveAutomationSession } from '../cron/contracts.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState } from './session-store.ts'
import { normalizeWorkExecutorMetadata } from './work-executor-metadata.ts'

function legacy(): SessionState {
  const sessionId = 'work-executor:historical'
  return { sessionId, segmentIndex: 2, mode: 'session', agentType: 'general', projectId: 'fixture',
    folderId: 'isolated', workdir: { version: 2, nodeId: 'remote', workdirId: 'isolated' },
    automaticWork: { key: 'work:fixture', jobId: WORK_DISPATCH_ID, limits: workDispatchConfigSchema.parse({ kind: 'work-dispatch' }) },
    automation: { jobId: WORK_DISPATCH_ID, name: 'Work auto-dispatch', runId: sessionId, startedAt: '2026-11-12T00:00:00.000Z', contextMode: 'fresh' },
    recovery: { id: 'recovery', reason: 'interrupted', pendingToolCalls: 1 },
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: historical worker classification is read-only and preserves execution metadata and history`, async () => withTempWorkspace(async directory => {
    const store = new Store(directory)
    await store.init()
    const original = legacy()
    try {
      await store.saveState(original.sessionId, original)
      await store.appendMessages('worker-log', [{ role: 'user', content: 'Preserved history', timestamp: '2026-11-12T00:00:00.000Z' }])
      const persisted = async () => {
        if (Store === JsonlSessionStore) return readFile(join(directory, `${safeSessionId(original.sessionId)}.json`), 'utf8')
        const db = new DatabaseSync(join(directory, 'sessions.db'))
        try { return db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(original.sessionId)?.prototype }
        finally { db.close() }
      }
      const before = await persisted()
      const expected = { ...original, ownershipVersion: 2, automationVersion: 1 }
      delete expected.automation
      const state = await store.getState(original.sessionId)
      assert.deepEqual(JSON.parse(JSON.stringify(state)), expected)
      assert.equal(resolveAutomationSession(state!), undefined)
      assert.deepEqual(JSON.parse(JSON.stringify((await store.listAllStates())[original.sessionId])), expected)
      assert.equal(await persisted(), before, 'read compatibility must not rewrite persisted records')
      const messages = []
      for await (const record of store.readSessionLog('worker-log')) messages.push(record)
      assert.match(JSON.stringify(messages), /Preserved history/)
    } finally { store.close() }
  }))
}

test('normalization preserves recovery and does not reclassify dispatcher or unrelated runs', () => {
  const worker = legacy()
  const recovery = worker.recovery
  normalizeWorkExecutorMetadata(worker)
  assert.equal(worker.recovery, recovery)
  assert.equal(worker.automation, undefined)
  for (const fields of [
    { sessionId: 'cron:dispatcher', mode: 'task' as const, agentType: 'dispatcher' },
    { automaticWork: undefined },
    { automation: { ...legacy().automation!, jobId: 'unrelated' } },
    { automation: { ...legacy().automation!, runId: 'another-run' } },
  ]) {
    const state = { ...legacy(), ...fields }
    const original = structuredClone(state)
    assert.deepEqual(normalizeWorkExecutorMetadata(state), original)
    assert.deepEqual(resolveAutomationSession(state), original.automation)
  }
})
