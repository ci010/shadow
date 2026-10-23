import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { parseTopicMetadata, TopicMetadataError } from './topic-contract.ts'

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
