import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'

for (const backend of ['jsonl', 'sqlite'] as const) {
  test(`${backend} migrates planning context alongside Project/Folder identities and preserves history`, async () => {
    await withTempWorkspace(async directory => {
      const sessionId = 'web:legacy'
      const legacy = {
        ownershipVersion: 2,
        projectId: 'domain',
        folderId: 'folder',
        projectName: 'cleanup',
        futureMetadata: { preserved: true },
      }
      const store: SessionStore = backend === 'jsonl'
        ? new JsonlSessionStore(directory) : new SqliteSessionStore(directory)
      try {
        await store.saveState(sessionId, { sessionId, segmentIndex: 0 })
        await store.appendMessages('legacy-0', [{ role: 'user', content: 'Keep this history', timestamp: '2026-09-16T00:00:00.000Z' }])
        if (backend === 'jsonl') {
          await writeFile(join(directory, `${safeSessionId(sessionId)}.json`),
            JSON.stringify({ ...legacy, sessionId, segmentIndex: 0 }))
        } else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try {
            db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?')
              .run(JSON.stringify({ version: 1, metadata: legacy }), sessionId)
          } finally { db.close() }
        }
        const state = await store.getState(sessionId)
        assert(state)
        assert.equal(state.projectId, 'domain')
        assert.equal(state.folderId, 'folder')
        assert.equal(state.initiativeId, 'cleanup')
        assert.equal('projectName' in state, false)
        assert.equal((await store.listAllStates())[sessionId].initiativeId, 'cleanup')
        await store.saveState(sessionId, state)
        const history = []
        for await (const record of store.readSessionLog('legacy-0')) history.push(record)
        assert.equal(history.length, 1)
        assert.match(JSON.stringify(history), /Keep this history/)
        let saved: Record<string, unknown>
        if (backend === 'jsonl') {
          saved = JSON.parse(await readFile(join(directory, `${safeSessionId(sessionId)}.json`), 'utf8'))
        } else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try {
            const row = db.prepare('SELECT prototype FROM session_states WHERE key = ?').get(sessionId)
            assert.equal(typeof row?.prototype, 'string')
            saved = JSON.parse(String(row?.prototype)).metadata
          } finally { db.close() }
        }
        assert.equal(saved.initiativeId, 'cleanup')
        assert.equal(saved.projectName, undefined)
        assert.deepEqual(saved.futureMetadata, { preserved: true })
      } finally { await store.close?.() }
    })
  })

  test(`${backend} refuses conflicting persisted initiative references`, async () => {
    await withTempWorkspace(async directory => {
      const sessionId = 'web:conflict'
      const invalid = { ownershipVersion: 2, initiativeId: 'one', projectName: 'two' }
      const store: SessionStore = backend === 'jsonl'
        ? new JsonlSessionStore(directory) : new SqliteSessionStore(directory)
      try {
        await store.saveState(sessionId, { sessionId, segmentIndex: 0 })
        if (backend === 'jsonl') {
          await writeFile(join(directory, `${safeSessionId(sessionId)}.json`),
            JSON.stringify({ ...invalid, sessionId, segmentIndex: 0 }))
        } else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try {
            db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?')
              .run(JSON.stringify({ version: 1, metadata: invalid }), sessionId)
          } finally { db.close() }
        }
        await assert.rejects(store.getState(sessionId), /Conflicting/)
        await assert.rejects(store.listAllStates(), /Conflicting/)
      } finally { await store.close?.() }
    })
  })
}
