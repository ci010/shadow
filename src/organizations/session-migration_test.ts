import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { migrateSessionOrganizations } from './session-migration.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name} migrates organization metadata without changing logical IDs, lineage or history`, async () => {
    await withTempWorkspace(async root => {
      let store: SessionStore = new Store(join(root, 'sessions'))
      try {
      await store.init()
      const state = { sessionId: 'web:legacy', segmentIndex: 2, parent: { id: 'web:parent', physicalId: 'web:parent-1', index: 3 }, projectId: 'legacy-project' }
      const events = [{ previous_physical_id: 'older', timestamp: '2026-01-01T00:00:00Z' }, { role: 'assistant', tool_calls: [{ id: 'call1' }] }, { role: 'tool', tool_call_id: 'call1', content: 'kept' }]
      await store.saveState(state.sessionId, state)
      await store.createSessionLog('physical-segment', events)
      await migrateSessionOrganizations(store, 'default')
      await migrateSessionOrganizations(store, 'default')
      store.close?.()
      store = new Store(join(root, 'sessions'))
      await store.init()
      assert.deepEqual(JSON.parse(JSON.stringify(await store.getState(state.sessionId))), { ...state, organizationId: 'default' })
      const actual = []
      for await (const event of store.readSessionLog('physical-segment')) actual.push(event)
      assert.deepEqual(actual, events)
      await assert.rejects(migrateSessionOrganizations(store, 'other'), /another organization/)
      } finally { store.close?.() }
    })
  })
}
