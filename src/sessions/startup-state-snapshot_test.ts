import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { startupStateSnapshot } from './startup-state-snapshot.ts'
import { assertSessionProjectOwnership, reserveRemoteSessionWorkdirs, type StartupOwnershipStates } from '../projects/session-ownership.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { projectStoragePath } from '../utils/data-paths.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: startup reuses reads, returns isolated copies, invalidates writes and closes`, async t => {
    await withTempWorkspace(async root => {
      const disk: SessionStore = new Store(join(root, 'sessions'))
      await disk.init()
      const state = { sessionId: 'web:test', projectId: 'default', segmentIndex: 0 }
      await disk.saveState(state.sessionId, state)
      const reads = t.mock.method(disk, 'listAllStates')
      const startup = startupStateSnapshot(disk)
      assert.equal(typeof startup.store.close, typeof disk.close, 'optional lifecycle methods stay optional')
      try {
        await assertSessionProjectOwnership(startup.store, 'default')
        const loaded = await startup.store.listAllStates()
        loaded[state.sessionId]!.segmentIndex = 99
        assert.equal((await startup.store.listAllStates())[state.sessionId]!.segmentIndex, 0)
        assert.equal((await startup.store.getState(state.sessionId))!.segmentIndex, 0)
        assert.equal(reads.mock.callCount(), 1)
        await startup.store.saveState(state.sessionId, { ...state, segmentIndex: 1 })
        assert.equal((await startup.store.listAllStates())[state.sessionId]!.segmentIndex, 1)
        await startup.store.listAllStates()
        assert.equal(reads.mock.callCount(), 3)
        const again = startupStateSnapshot(disk)
        await again.store.listAllStates()
        await again.store.deleteState(state.sessionId)
        assert.equal(await again.store.getState(state.sessionId), null)
        again.close()
        startup.close()
        const closed = startupStateSnapshot(disk)
        await closed.store.listAllStates()
        const beforeClose = reads.mock.callCount()
        closed.close()
        await closed.store.listAllStates()
        assert.equal(reads.mock.callCount(), beforeClose + 1)
        const failed = startupStateSnapshot(disk)
        await failed.store.listAllStates()
        const beforeFailure = reads.mock.callCount()
        await assert.rejects(failed.store.saveState('bad', { ...state, ownershipVersion: 9000 as 2 }))
        await failed.store.listAllStates()
        assert.equal(reads.mock.callCount(), beforeFailure + 1)
        failed.close()
      } finally { disk.close?.() }
    })
  })
}

test('host reservation -> project ownership -> session load reads each format once', async t => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home'), directory = projectStoragePath(home, '.sessions')
    const catalog = new ProjectCatalog(join(root, 'catalog'))
    await catalog.init()
    for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
      const writer: SessionStore = new Store(directory)
      await writer.init()
      await writer.saveState('web:test', { sessionId: 'web:test', projectId: 'default', segmentIndex: 0 })
      writer.close?.()
    }
    const jsonReads = t.mock.method(JsonlSessionStore.prototype, 'listAllStates')
    const sqlReads = t.mock.method(SqliteSessionStore.prototype, 'listAllStates')
    const initial: StartupOwnershipStates = {}
    await reserveRemoteSessionWorkdirs(home, catalog, 'default', initial)
    for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
      const disk: SessionStore = new Store(directory)
      await disk.init()
      const startup = startupStateSnapshot(disk, initial[Store === JsonlSessionStore ? 'jsonl' : 'sqlite'])
      try {
        await assertSessionProjectOwnership(startup.store, 'default')
        assert.ok((await startup.store.listAllStates())['web:test'])
        await assert.rejects(assertSessionProjectOwnership(startup.store, 'foreign'), /does not belong/)
      } finally { startup.close(); disk.close?.() }
    }
    assert.equal(jsonReads.mock.callCount(), 1)
    assert.equal(sqlReads.mock.callCount(), 1)
  })
})

test('in-flight pre-mutation snapshot cannot refill startup cache', async t => {
  await withTempWorkspace(async root => {
    const disk = new JsonlSessionStore(join(root, 'sessions'))
    await disk.init()
    const old = { sessionId: 'web:test', segmentIndex: 0 }
    await disk.saveState(old.sessionId, old)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let captured!: () => void
    const ready = new Promise<void>(resolve => { captured = resolve })
    const original = disk.listAllStates.bind(disk)
    let count = 0
    t.mock.method(disk, 'listAllStates', async () => {
      count++
      const states = await original()
      if (count === 1) { captured(); await gate }
      return states
    })
    const startup = startupStateSnapshot(disk)
    const pending = startup.store.listAllStates()
    // Wait until the read has captured the old record before performing mutation.
    await ready
    await startup.store.saveState(old.sessionId, { ...old, segmentIndex: 2 })
    release()
    await pending
    assert.equal((await startup.store.listAllStates())[old.sessionId]!.segmentIndex, 2)
    assert.equal(count, 2)
    startup.close()
  })
})


test('archival invalidates startup snapshots even when archival fails', async t => {
  await withTempWorkspace(async root => {
    const disk: SessionStore = new JsonlSessionStore(join(root, 'sessions'))
    await disk.init()
    const state = { sessionId: 'web:archive-fixture', projectId: 'default', segmentIndex: 0 }
    await disk.saveState(state.sessionId, state)
    const reads = t.mock.method(disk, 'listAllStates')
    disk.archiveState = async value => { await disk.deleteState(value.sessionId) }
    const startup = startupStateSnapshot(disk)
    assert.ok((await startup.store.listAllStates())[state.sessionId])
    await startup.store.archiveState!(state)
    assert.equal((await startup.store.listAllStates())[state.sessionId], undefined)
    assert.equal(reads.mock.callCount(), 2)
    startup.close()
    const failed = startupStateSnapshot(disk)
    await failed.store.listAllStates()
    const before = reads.mock.callCount()
    disk.archiveState = async () => { throw new Error('archive fixture failure') }
    await assert.rejects(failed.store.archiveState!(state), /archive fixture failure/)
    await failed.store.listAllStates()
    assert.equal(reads.mock.callCount(), before + 1)
    failed.close()
    disk.close?.()
  })
})
