import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { parseSessionFocus, selfSessionMetadata, sessionTopic } from './session-metadata.ts'
import { sessionMetadata } from '../vfs/session-index.ts'
import { sessionTopicSequence } from './lightweight-topic.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: canonical topic overrides old titles and focus survives reopening`, async () => withTempWorkspace(async home => {
    const directory = join(home, 'sessions')
    const topic = 'Stable topic'
    let store = new Store(directory)
    await store.init()
    try {
      await store.saveState('web:metadata', { sessionId: 'web:metadata', segmentIndex: 0, mode: 'session', name: 'Historical title', topic, description: 'Old description is not focus' })
      const old = (await store.getState('web:metadata'))!
      assert.deepEqual(selfSessionMetadata(old), { topic: 'Stable topic', focus: '', completed: false })
      assert.equal(sessionTopic({ name: 'Historical title' }), 'Historical title')
      assert.deepEqual(sessionMetadata(old), ['topic: Stable topic'])
      const sequence = sessionTopicSequence(old)
      await store.saveState(old.sessionId, { ...old, focus: 'Debugging a subtask' })
      store.close?.()
      store = new Store(directory)
      await store.init()
      const saved = (await store.getState(old.sessionId))!
      assert.deepEqual(saved.topic, topic)
      assert.equal(saved.description, 'Old description is not focus')
      assert.deepEqual(selfSessionMetadata(saved), { topic: 'Stable topic', focus: 'Debugging a subtask', completed: false })
      assert.notEqual(sessionTopicSequence(saved), sequence)
      assert.deepEqual(sessionMetadata(saved), ['topic: Stable topic', 'focus: Debugging a subtask'])
      assert.deepEqual(sessionMetadata({ ...saved, focus: 'Stable topic' }), ['topic: Stable topic'])
      await store.saveState(saved.sessionId, { ...saved, focus: '' })
      assert.equal((await store.getState(saved.sessionId))!.focus, '')
      await assert.rejects(store.saveState(saved.sessionId, { ...saved, focus: 42 as never }))
      await assert.rejects(store.saveState(saved.sessionId, { ...saved, focus: 'x'.repeat(4001) }))
    } finally { store.close?.() }
  }))
}

test('focus validation and task discovery adaptation do not reinterpret descriptions', () => {
  assert.equal(parseSessionFocus('  Current step  '), 'Current step')
  assert.throws(() => parseSessionFocus(null), /Focus/)
  const task = { sessionId: 'task', segmentIndex: 0, mode: 'task' as const, name: 'Parent task title', description: 'Parent task discovery' }
  assert.deepEqual(selfSessionMetadata(task), { topic: 'Parent task title', focus: '', completed: false })
  assert.deepEqual(sessionMetadata(task), ['topic: Parent task title', 'description: Parent task discovery'])
})
