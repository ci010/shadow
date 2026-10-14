import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { FreshAutomationStateStore } from './fresh-automation-state.ts'
import type { SessionState } from './session-store.ts'

const state = (id: string, jobId = 'daily'): SessionState => ({
  sessionId: `cron:${id}`, executionId: `execution:${id}`, executionKey: `key:${id}`,
  ownershipVersion: 2, projectId: 'fixture-project', mode: 'task', executionStatus: 'completed',
  physicalIdVersion: 2, segmentIndex: 0, parentSessionId: 'web:owner',
  automation: { jobId, runId: `run:${id}`, name: jobId, contextMode: 'fresh', startedAt: '2026-01-01T00:00:00.000Z' },
  statePersistence: { version: 1, kind: 'fresh-automation', jobId }, automationCallerSettled: true,
  workdir: { version: 1, nodeId: 'remote-fixture', capabilityId: 'cap-fixture' },
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: future-only slots, indexed history, bounded boot and preserved legacy state`, async () => {
    await withTempWorkspace(async root => {
      let store = new Store(root)
      await store.init()
      const legacy: SessionState = { sessionId: 'cron:legacy', projectId: 'fixture-project', ownershipVersion: 2, segmentIndex: 0 }
      await store.saveState(legacy.sessionId, legacy)
      await assert.rejects(store.saveState(legacy.sessionId, { ...state('legacy'), sessionId: legacy.sessionId }), /Existing legacy state/)
      const legacyPath = Store === JsonlSessionStore ? join(root, (await readdir(root)).find(name => name.endsWith('.json'))!) : undefined
      const bytes = legacyPath ? await readFile(legacyPath) : undefined
      const prototype = Store === SqliteSessionStore ? (() => { const db = new DatabaseSync(join(root, 'sessions.db')); try { return db.prepare('SELECT * FROM session_states').all() } finally { db.close() } })() : undefined
      for (let index = 0; index < 220; index++) {
        const run = state(String(index))
        await store.saveState(run.sessionId, run)
        await store.archiveState(run)
      }
      const pending = { ...state('pending'), executionStatus: 'running' as const, automationCallerSettled: false }
      await store.saveState(pending.sessionId, pending)
      store.close()
      store = new Store(root)
      try {
        assert.deepEqual(Object.keys(await store.listAllStates()).sort(), [legacy.sessionId, pending.sessionId].sort())
        assert.equal(await store.getState('cron:100'), null)
        assert.equal((await store.readArchivedState('cron:100'))?.executionId, 'execution:100')
        assert.equal((await store.queryArchivedStates({ executionKey: 'key:100' }))[0]?.sessionId, 'cron:100')
        assert.equal((await store.queryArchivedStates({ jobId: 'daily', offset: 10, limit: 7 })).length, 7)
        assert.equal((await store.queryArchivedStates({ projectId: 'foreign' })).length, 0)
        assert.equal((await store.listSessions()).length, 222)
        assert.equal((await store.listArchiveReferences()).length, 1, 'claims are distinct, not one row per settled run')
        assert.deepEqual(Object.keys(await store.listAllStates()).sort(), [legacy.sessionId, pending.sessionId].sort(), 'history does not hydrate startup selection')
        if (bytes) assert.deepEqual(await readFile(legacyPath!), bytes)
        if (prototype) { const db = new DatabaseSync(join(root, 'sessions.db')); try { assert.deepEqual(db.prepare('SELECT * FROM session_states').all(), prototype) } finally { db.close() } }
        if (Store === JsonlSessionStore) {
          const slotDir = join(root, '.fresh-automation-v1-jsonl')
          const slots = (await readdir(slotDir)).filter(name => name.endsWith('.json'))
          assert.equal(slots.length, 1)
          const slot = JSON.parse(await readFile(join(slotDir, slots[0]!), 'utf8'))
          assert.deepEqual(Object.keys(slot.active), [pending.sessionId])
          assert.ok(JSON.stringify(slot).length < 2000, 'settled metadata is not accumulated in the JSON envelope')
        }
      } finally { store.close() }
    })
  })

  test(`${Store.name}: overlap, late writes, pending reports and policy stripping fail closed`, async () => {
    await withTempWorkspace(async root => {
      const store = new Store(root)
      await store.init()
      try {
        const older = state('older'), newer = state('newer')
        await Promise.all([store.saveState(older.sessionId, older), store.saveState(newer.sessionId, newer)])
        await store.archiveState(newer)
        assert.deepEqual(Object.keys(await store.listAllStates()), [older.sessionId])
        await store.archiveState(older)
        await assert.rejects(store.saveState(older.sessionId, { ...older, executionStatus: 'running' }), /already archived/)
        await assert.rejects(store.saveState(older.sessionId, { ...older, statePersistence: undefined }), /policy cannot be removed/)
        await assert.rejects(store.saveState(older.sessionId, { ...older, projectId: 'foreign' }), /identity mismatch/)
        assert.deepEqual(await store.listAllStates(), {})
        const report = { ...state('report'), reportTo: 'web:owner', completionReported: false }
        await store.saveState(report.sessionId, report)
        await assert.rejects(store.archiveState(report), /unsettled/)
        const unsettled = { ...state('caller'), automationCallerSettled: false }
        await store.saveState(unsettled.sessionId, unsettled)
        await assert.rejects(store.archiveState(unsettled), /unsettled/)
        assert.equal(Object.keys(await store.listAllStates()).length, 2)
        const finished = { ...report, completionReported: true }
        await store.saveState(finished.sessionId, finished)
        await store.archiveState(finished)
        assert.equal((await store.readArchivedState(finished.sessionId))?.completionReported, true)
      } finally { store.close() }
    })
  })
}

test('JSON slot archive-first crash retains unsettled pointer and reconciles idempotently', async () => {
  await withTempWorkspace(async root => {
    let store = new FreshAutomationStateStore(root, 'jsonl')
    const run = state('crash')
    await store.save(run)
    const internals = store as unknown as { writeSlot: (...args: unknown[]) => Promise<void> }
    internals.writeSlot = async () => { throw new Error('Synthetic pointer replacement failure') }
    await assert.rejects(store.archive(run), /Synthetic/)
    assert.equal((await store.archived(run.sessionId))?.sessionId, run.sessionId)
    store.close()
    store = new FreshAutomationStateStore(root, 'jsonl')
    try {
      assert.equal((await store.listActive())[run.sessionId]?.sessionId, run.sessionId)
      await store.archive(run)
      assert.deepEqual(await store.listActive(), {})
      await store.archive(run)
      assert.deepEqual(await store.listActive(), {})
    } finally { store.close() }
  })
})

test('invalid/foreign slot identity fails closed without reading archived state blobs at startup', async () => {
  await withTempWorkspace(async root => {
    const store = new JsonlSessionStore(root)
    await store.init()
    const run = state('corrupt-archive')
    await store.saveState(run.sessionId, run)
    await store.archiveState(run)
    store.close()
    const directory = join(root, '.fresh-automation-v1-jsonl')
    const db = new DatabaseSync(join(directory, 'archive.db'))
    db.prepare('UPDATE runs SET state = ? WHERE session_id = ?').run('{bad', run.sessionId)
    db.close()
    const reopened = new JsonlSessionStore(root)
    try {
      assert.deepEqual(await reopened.listAllStates(), {}, 'startup never parses finalized blobs')
      await assert.rejects(reopened.readArchivedState(run.sessionId))
      const slotPath = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!)
      const slot = JSON.parse(await readFile(slotPath, 'utf8'))
      slot.projectId = 'foreign-project'
      await writeFile(slotPath, JSON.stringify(slot))
      await assert.rejects(reopened.listAllStates(), /address mismatch/)
    } finally { reopened.close() }
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: archived remote ownership is reserved from compact claims without reading blobs`, async () => {
  await withTempWorkspace(async root => {
    const { projectStoragePath } = await import('../utils/data-paths.ts')
    const { ProjectCatalog } = await import('../projects/catalog.ts')
    const { assertSessionProjectOwnership, reserveRemoteSessionWorkdirs } = await import('../projects/session-ownership.ts')
    const home = join(root, 'home'), directory = projectStoragePath(home, '.sessions')
    const store = new Store(directory); await store.init()
    const run = { ...state('remote'), projectId: 'default' }
    await store.saveState(run.sessionId, run); await store.archiveState(run); store.close()
    const db = new DatabaseSync(join(directory, `.fresh-automation-v1-${Store === JsonlSessionStore ? 'jsonl' : 'sqlite'}`, 'archive.db'))
    db.prepare('UPDATE runs SET state = ?').run('{not-parsed-at-boot'); db.close()
    const reopened = new Store(directory)
    const catalog = new ProjectCatalog(join(root, 'catalog')); await catalog.init()
    try {
      await assertSessionProjectOwnership(reopened, 'default')
      await reserveRemoteSessionWorkdirs(home, catalog, 'default')
      assert.equal(catalog.remoteClaims().length, 1)
      assert.match(JSON.stringify(catalog.remoteClaims()), /cap-fixture/)
      await assert.rejects(assertSessionProjectOwnership(reopened, 'foreign'), /does not belong/)
      await assert.rejects(reopened.readArchivedState(run.sessionId))
    } finally { reopened.close() }
  })
})
