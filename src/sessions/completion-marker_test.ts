import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { selfSessionMetadata } from './session-metadata.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: completion marker validates and roundtrips without legacy backfill`, async () => withTempWorkspace(async workspace => {
    const path = join(workspace, 'sessions')
    let store = new Store(path)
    await store.init()
    const base = { sessionId: 'web:legacy', segmentIndex: 0, completed: true }
    try {
      await store.saveState(base.sessionId, base)
      assert.equal((await store.getState(base.sessionId))!.completedAt, undefined)
      const completedAt = '2026-11-17T12:00:00.000Z'
      await store.saveState(base.sessionId, { ...base, completedAt })
      store.close?.()
      store = new Store(path)
      await store.init()
      const saved = (await store.getState(base.sessionId))!
      assert.equal(saved.completedAt, completedAt)
      assert.equal('completedAt' in selfSessionMetadata(saved), false)
      for (const bad of ['bad', '', 42, null, '2026-11-17']) {
        await assert.rejects(store.saveState(base.sessionId, { ...saved, completedAt: bad as never }))
        assert.equal((await store.getState(base.sessionId))!.completedAt, completedAt)
      }
      await store.saveState(base.sessionId, { ...saved, completed: false, completedAt: undefined })
      assert.equal((await store.getState(base.sessionId))!.completedAt, undefined)
    } finally { store.close?.() }
  }))

  test(`${Store.name}: self completion is host-stamped, cleared explicitly and saved atomically`, async () => withTempWorkspace(async workspace => {
    const store = new Store(join(workspace, 'sessions'))
    await store.init()
    await store.saveState('web:self', { sessionId: 'web:self', segmentIndex: 0, mode: 'session' })
    const sessions = new SessionManager({ workspace, store, bus: new Bus(),
      agentTypes: { resolve: () => ({ name: 'general' }) },
    } as unknown as SessionManagerDeps)
    try {
      await sessions.start()
      await assert.rejects(sessions.updateSelfMetadata('web:self', { completedAt: new Date().toISOString() }), /Unknown/)
      const before = Date.now()
      await sessions.updateSelfMetadata('web:self', { completed: true })
      const marker = sessions.getSessionState('web:self')!.completedAt!
      assert(Date.parse(marker) >= before && Date.parse(marker) <= Date.now())
      assert.equal((await store.getState('web:self'))!.completedAt, marker)
      await sessions.updateSelfMetadata('web:self', { focus: 'No freshness renewal' })
      assert.equal(sessions.getSessionState('web:self')!.completedAt, marker)
      const save = store.saveState.bind(store)
      store.saveState = async () => { throw new Error('synthetic disk failure') }
      await assert.rejects(sessions.updateSelfMetadata('web:self', { completed: false }), /disk failure/)
      assert.equal(sessions.getSessionState('web:self')!.completedAt, marker)
      assert.equal(sessions.getSessionState('web:self')!.completed, true)
      store.saveState = save
      await sessions.updateSelfMetadata('web:self', { completed: false })
      assert.equal(sessions.getSessionState('web:self')!.completedAt, undefined)
      assert.equal((await store.getState('web:self'))!.completedAt, undefined)
    } finally { await sessions.stop(); store.close?.() }
  }))
}
