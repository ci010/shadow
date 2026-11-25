import assert from 'node:assert/strict'
import { rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { parseSessionFollowUp, selfSessionMetadata } from './session-metadata.ts'
import type { SessionState } from './session-store.ts'

const sessionId = 'follow-up'
const base: SessionState = { sessionId, segmentIndex: 0, topic: 'Topic', focus: 'Focus' }
const recovery = { dueAt: 2000, wakes: 0, startedAt: 1000, phase: 'self_check', inputId: 'wake-id' } as const
const legacySelf = { topic: 'Topic', focus: 'Focus', completed: false }

for (const kind of ['jsonl', 'sqlite'] as const) {
  test(`${kind} persists follow-up, opt-out and recovery without exposing internal state`, async () => {
    const dir = await createTempWorkspace()
    const open = () => kind === 'sqlite' ? new SqliteSessionStore(dir) : new JsonlSessionStore(dir)
    let store = open()
    const close = () => { if (store instanceof SqliteSessionStore) store.close() }
    const reload = async () => {
      close()
      store = open()
      return (await store.getState(sessionId))!
    }
    const rawMetadata = async (edit?: (metadata: Record<string, unknown>) => void) => {
      if (kind === 'jsonl') {
        const path = join(dir, `${sessionId}.json`)
        const metadata = JSON.parse(await readFile(path, 'utf8'))
        if (edit) { edit(metadata); await writeFile(path, JSON.stringify(metadata)) }
        return metadata
      }
      const db = new DatabaseSync(join(dir, 'sessions.db'))
      try {
        const row = db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(sessionId) as { prototype: string }
        const prototype = JSON.parse(row.prototype)
        if (edit) {
          edit(prototype.metadata)
          db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?').run(JSON.stringify(prototype), sessionId)
        }
        return prototype.metadata
      } finally { db.close() }
    }
    try {
      await store.saveState(sessionId, { ...base, followUp: { next: '  Check results ', after: 5 }, sessionFollowUp: recovery })
      const state = await reload()
      assert.deepEqual(state.sessionFollowUp, recovery)
      assert.deepEqual(selfSessionMetadata(state), { ...legacySelf, followUp: { next: 'Check results', after: 5 } })
      await store.saveState(sessionId, { ...base, followUp: null })
      const optedOut = await reload()
      assert.deepEqual(selfSessionMetadata(optedOut), { ...legacySelf, followUp: null })
      assert.equal(optedOut.sessionFollowUp, undefined)
      await store.saveState(sessionId, base)
      assert.deepEqual(selfSessionMetadata(await reload()), legacySelf)
      const absent = await rawMetadata()
      assert.equal(Object.hasOwn(absent, 'followUp'), false)
      assert.equal(Object.hasOwn(absent, 'sessionFollowUp'), false)
      for (const invalid of [null, { ...recovery, wakes: -1 }, { ...recovery, dueAt: '2000' }, { ...recovery, startedAt: 1.5 }, { ...recovery, phase: 'unknown' }, { ...recovery, inputId: ' ' }]) {
        await assert.rejects(store.saveState(sessionId, { ...base, sessionFollowUp: invalid as SessionState['sessionFollowUp'] }))
        await rawMetadata(metadata => { metadata.sessionFollowUp = invalid })
        await assert.rejects(store.getState(sessionId))
      }
    } finally { close(); await rm(dir, { recursive: true, force: true }) }
  })
}

test('follow-up parser rejects invalid requests without coercion', () => {
  assert.equal(parseSessionFollowUp(null), null)
  const next = 'a'.repeat(2000)
  assert.deepEqual(parseSessionFollowUp({ next: ` ${next} `, after: 86400 }), { next, after: 86400 })
  for (const value of [undefined, [], {}, { next: ' ', after: 5 }, { next: `${next}a`, after: 5 }, ...[4, 86401, 5.1, '5', NaN].map(after => ({ next, after }))]) {
    assert.throws(() => parseSessionFollowUp(value), TypeError)
  }
})
