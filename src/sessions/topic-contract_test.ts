import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { parseTopicMetadata, parseTopicSessionFields, TopicMetadataError } from './topic-contract.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { projectPaths } from '../projects/contracts.ts'
import { assertSessionProjectOwnership, reserveRemoteSessionWorkdirs } from '../projects/session-ownership.ts'
import { projectStoragePath } from '../utils/data-paths.ts'

test('topic metadata bounds match the public topic service', () => {
  const topic = { title: 'x'.repeat(160), goal: 'x'.repeat(4000), scope: 'x'.repeat(4000), nonGoals: 'x'.repeat(4000) }
  assert.deepEqual(parseTopicMetadata(topic), topic)
  for (const key of ['title', 'goal', 'scope', 'nonGoals'] as const) {
    assert.throws(() => parseTopicMetadata({ ...topic, [key]: `${topic[key]}x` }), TopicMetadataError)
  }
})

test('JSONL atomic state replacement serializes concurrent writes and deletion', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(workspace)
    await store.init()
    const state = { sessionId: 'web:topic', segmentIndex: 0, mode: 'session' as const, sessionKind: 'topic' as const }
    await Promise.all(Array.from({ length: 100 }, (_, index) => store.saveState(state.sessionId, {
      ...state, topic: { title: `Update ${index}`, goal: 'Goal', scope: '' },
    })))
    assert.equal((await store.getState(state.sessionId))?.topic?.title, 'Update 99')
    await Promise.all([store.saveState(state.sessionId, state), store.deleteState(state.sessionId)])
    assert.equal(await store.getState(state.sessionId), null)
    assert.deepEqual(await readdir(workspace), [])
  })
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: malformed JSON is not mistaken for missing or empty session state`, async () => {
    await withTempWorkspace(async directory => {
      const store = new Store(directory)
      const state = { sessionId: 'web:broken', segmentIndex: 0 }
      const statePath = join(directory, `${safeSessionId(state.sessionId)}.json`)
      try {
        await store.init()
        assert.equal(await store.getState(state.sessionId), null)
        for (const raw of ['', '{ "private": "synthetic-sensitive-text", broken', 'null', '[]', '{}']) {
          await store.saveState(state.sessionId, state)
          if (store instanceof JsonlSessionStore) await writeFile(statePath, raw)
          else {
            const db = new DatabaseSync(join(directory, 'sessions.db'))
            try { db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?').run(raw, state.sessionId) }
            finally { db.close() }
          }
          for (const read of [() => store.getState(state.sessionId), () => store.listAllStates(), () => store.listSessions()]) {
            await assert.rejects(read, error => {
              assert(error instanceof Error)
              assert.doesNotMatch(error.message, /synthetic-sensitive-text/)
              return true
            })
          }
          if (store instanceof JsonlSessionStore) assert.equal(await readFile(statePath, 'utf8'), raw)
        }
      } finally { store.close() }
    })
  })

  test(`${Store.name}: retired coordinators load as ordinary sessions without losing identity or history`, async () => {
    await withTempWorkspace(async root => {
      const home = projectPaths(root, 'default').home
      const directory = projectStoragePath(home, '.sessions')
      const catalog = new ProjectCatalog(root)
      await catalog.init()
      let store = new Store(directory)
      await store.init()
      const state = {
        ownershipVersion: 2 as const, projectId: 'default', sessionId: 'web:orchestrator', segmentIndex: 2,
        mode: 'session' as const, agentType: 'general', physicalIdVersion: 2 as const,
        name: 'Saved conversation', generatedTitle: 'Original title', config: { model: 'fixture' },
        folderId: 'folder', workdir: { version: 2 as const, nodeId: 'local', workdirId: 'folder' },
        parent: { id: 'web:parent', physicalId: 'parent-segment', index: 1 }, children: ['task:child'],
      }
      const legacy = { ...state, sessionKind: 'orchestrator', agentType: 'orchestrator', futureMetadata: { preserved: true } }
      const history = [
        { role: 'user', content: 'Keep the original conversation' },
        { role: 'assistant', tool_calls: [{ id: 'call1' }] },
        { role: 'tool', tool_call_id: 'call1', content: 'Saved result' },
      ]
      const statePath = join(directory, `${safeSessionId(state.sessionId)}.json`)
      const rawMetadata = async (): Promise<Record<string, unknown>> => {
        if (store instanceof JsonlSessionStore) return JSON.parse(await readFile(statePath, 'utf8'))
        const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
        try {
          const row = db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(state.sessionId)
          return JSON.parse(String(row?.prototype)).metadata
        } finally { db.close() }
      }
      try {
        await store.saveState(state.sessionId, state)
        await store.createSessionLog('preserved-physical-segment', history)
        if (store instanceof JsonlSessionStore) {
          await writeFile(statePath, JSON.stringify(legacy))
        } else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try {
            db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?')
              .run(JSON.stringify({ version: 1, metadata: legacy }), state.sessionId)
          } finally { db.close() }
        }
        const loaded = await store.getState(state.sessionId)
        assert(loaded)
        assert.equal(loaded.sessionKind, undefined)
        assert.equal(loaded.agentType, 'general')
        for (const [key, value] of Object.entries(state)) assert.deepEqual(Reflect.get(loaded, key), value, key)
        assert.equal((await store.listAllStates())[state.sessionId].sessionKind, undefined)
        assert.equal((await store.listAllStates())[state.sessionId].agentType, 'general')
        assert.equal((await store.listSessions())[0].sessionKind, undefined)
        await assertSessionProjectOwnership(store, 'default')
        await assert.rejects(assertSessionProjectOwnership(store, 'foreign'), /does not belong/)
        await reserveRemoteSessionWorkdirs(home, catalog, 'default')
        assert.deepEqual(await rawMetadata(), legacy, 'Read-time compatibility must not rewrite files')
        await store.saveState(state.sessionId, loaded)
        const saved = await rawMetadata()
        assert.equal('sessionKind' in saved, false)
        assert.equal(saved.agentType, 'general')
        assert.deepEqual(saved.futureMetadata, legacy.futureMetadata)
        store.close()
        store = new Store(directory)
        assert.equal((await store.getState(state.sessionId))?.agentType, 'general')
        assert.equal((await store.getState(state.sessionId))?.segmentIndex, 2)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog('preserved-physical-segment')), history)
        assert.throws(() => parseTopicSessionFields(legacy), TopicMetadataError, 'New sessions cannot use the retired kind')
      } finally { store.close() }
    })
  })

  test(`${Store.name}: invalid persisted topic fields fail closed across all read APIs`, async () => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      const store = new Store(directory)
      await store.init()
      const state = {
        ownershipVersion: 2 as const, sessionId: 'web:topic', segmentIndex: 0,
        mode: 'session' as const, sessionKind: 'topic' as const,
        topic: { title: 'Title', goal: 'Goal', scope: '' },
      }
      try {
        for (const invalid of [
          { topic: { ...state.topic, title: '' } },
          { topic: { ...state.topic, scope: 42 } },
          { topic: { ...state.topic, nonGoals: 'x'.repeat(8001) } },
          { topic: { ...state.topic, unknown: 'extra' } },
          { sessionKind: 'unknown' },
          { createdBySessionId: '' },
          { topicRequestHash: 'not-a-hash' },
          { sessionKind: 'orchestrator', topic: { ...state.topic, title: '' } },
          { sessionKind: 'orchestrator', createdBySessionId: '' },
        ]) {
          await store.saveState(state.sessionId, state)
          const corrupt = { ...state, ...invalid }
          if (store instanceof JsonlSessionStore) {
            await writeFile(join(directory, `${safeSessionId(state.sessionId)}.json`), JSON.stringify(corrupt))
          } else {
            const db = new DatabaseSync(join(directory, 'sessions.db'))
            try {
              db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?')
                .run(JSON.stringify({ version: 1, metadata: corrupt }), state.sessionId)
            } finally { db.close() }
          }
          await assert.rejects(store.getState(state.sessionId), TopicMetadataError)
          await assert.rejects(store.listAllStates(), TopicMetadataError)
          await assert.rejects(store.listSessions(), TopicMetadataError)
        }
      } finally { if (store instanceof SqliteSessionStore) store.close() }
    })
  })
}
