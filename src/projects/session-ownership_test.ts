import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { assertSessionProjectOwnership, reserveRemoteSessionWorkdirs } from './session-ownership.ts'
import { ProjectCatalog } from './catalog.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name} validates project ownership without changing IDs, lineage or history`, async () => {
    await withTempWorkspace(async root => {
      let store: SessionStore = new Store(join(root, 'sessions'))
      try {
      await store.init()
      const state = { sessionId: 'web:owned', projectId: 'default', segmentIndex: 2, parent: { id: 'web:parent', physicalId: 'web:parent-1', index: 3 }, folderId: 'folder' }
      const events = [{ previous_physical_id: 'older', timestamp: '2026-01-01T00:00:00Z' }, { role: 'assistant', tool_calls: [{ id: 'call1' }] }, { role: 'tool', tool_call_id: 'call1', content: 'kept' }]
      await store.saveState(state.sessionId, state)
      await store.createSessionLog('physical-segment', events)
      await assertSessionProjectOwnership(store, 'default')
      await assertSessionProjectOwnership(store, 'default')
      store.close?.()
      store = new Store(join(root, 'sessions'))
      await store.init()
      assert.deepEqual(JSON.parse(JSON.stringify(await store.getState(state.sessionId))), { ...state, projectId: 'default', ownershipVersion: 2 })
      const actual = []
      for await (const event of store.readSessionLog('physical-segment')) actual.push(event)
      assert.deepEqual(actual, events)
      await assert.rejects(assertSessionProjectOwnership(store, 'other'), /does not belong/)
      await store.saveState('web:unowned', { sessionId: 'web:unowned', segmentIndex: 0 })
      await assert.rejects(assertSessionProjectOwnership(store, 'default'), /does not belong/)
      } finally { store.close?.() }
    })
  })
}

test('remote reservations reject a foreign persistence format before committing claims', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'project-home')
    const directory = join(home, '.sessions')
    const catalog = new ProjectCatalog(join(root, 'host.projects'))
    await catalog.init()
    const jsonl = new JsonlSessionStore(directory)
    await jsonl.init()
    await jsonl.saveState('web:owned', {
      sessionId: 'web:owned', segmentIndex: 0, projectId: 'default',
      workdir: { version: 1, nodeId: 'child', capabilityId: 'grant' },
    })

    test('remote reservations validate and collect each persistence snapshot only once', async t => {
      await withTempWorkspace(async root => {
        const home = join(root, 'home')
        const directory = join(home, '.sessions')
        const catalog = new ProjectCatalog(join(root, 'host.projects'))
        await catalog.init()
        const jsonl = new JsonlSessionStore(directory)
        await jsonl.init()
        await jsonl.saveState('owned-jsonl', {
          sessionId: 'owned-jsonl', segmentIndex: 0, projectId: 'default',
        })
        const sqlite = new SqliteSessionStore(directory)
        try {
          await sqlite.saveState('owned-sqlite', { sessionId: 'owned-sqlite', segmentIndex: 0, projectId: 'default' })
        } finally { sqlite.close() }
        const jsonlReads = t.mock.method(JsonlSessionStore.prototype, 'listAllStates')
        const sqliteReads = t.mock.method(SqliteSessionStore.prototype, 'listAllStates')
        await reserveRemoteSessionWorkdirs(home, catalog, 'default')
        assert.equal(jsonlReads.mock.callCount(), 1)
        assert.equal(sqliteReads.mock.callCount(), 1)
      })
    })
    const sqlite = new SqliteSessionStore(directory)
    try {
      await sqlite.saveState('web:foreign', { sessionId: 'web:foreign', segmentIndex: 0, projectId: 'foreign' })
    } finally { sqlite.close() }
    await assert.rejects(reserveRemoteSessionWorkdirs(home, catalog, 'default'), /does not belong/)
    assert.deepEqual(catalog.remoteClaims(), [])
  })
})
