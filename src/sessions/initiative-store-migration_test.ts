import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { safeSessionId } from '../utils/paths.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'

for (const backend of ['jsonl', 'sqlite'] as const) {
  test(`${backend} rejects legacy context metadata without modifying records or history`, async () => {
    await withTempWorkspace(async directory => {
      const sessionId = 'web:legacy'
      const legacy = { ownershipVersion: 2, projectId: 'domain', folderId: 'folder', projectName: 'cleanup', futureMetadata: { preserved: true } }
      const store = backend === 'jsonl' ? new JsonlSessionStore(directory) : new SqliteSessionStore(directory)
      try {
        await store.saveState(sessionId, { sessionId, segmentIndex: 0 })
        await store.appendMessages('legacy-0', [{ role: 'user', content: 'Keep this history', timestamp: '2026-09-16T00:00:00.000Z' }])
        const path = join(directory, `${safeSessionId(sessionId)}.json`)
        const prototype = JSON.stringify({ version: 1, metadata: legacy })
        if (backend === 'jsonl') await writeFile(path, JSON.stringify({ ...legacy, sessionId, segmentIndex: 0 }))
        else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try { db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?').run(prototype, sessionId) } finally { db.close() }
        }
        await assert.rejects(store.getState(sessionId), /Unsupported legacy Work context/)
        await assert.rejects(store.listAllStates(), /Unsupported legacy Work context/)
        if (backend === 'jsonl') assert.equal(JSON.parse(await readFile(path, 'utf8')).projectName, 'cleanup')
        else {
          const db = new DatabaseSync(join(directory, 'sessions.db'))
          try { assert.equal(db.prepare('SELECT prototype FROM session_states WHERE key=?').get(sessionId)?.prototype, prototype) } finally { db.close() }
        }
        const history = []
        for await (const record of store.readSessionLog('legacy-0')) history.push(record)
        assert.equal(history.length, 1)
        assert.match(JSON.stringify(history), /Keep this history/)
      } finally { await store.close?.() }
    })
  })
}
