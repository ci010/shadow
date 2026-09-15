import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../src/testing/workspace.ts'
import { DatabaseSync as Database } from 'node:sqlite'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { migrateSessionsToSqlite } from './migrate-sessions-to-sqlite.ts'
import { SqliteSessionStore } from '../src/sessions/session-store-sqlite.ts'
import type { SessionState } from '../src/sessions/session-store.ts'

test('migration preserves modern SessionState metadata and JSONL logs', async () => {
  const sessionsDir = await createTempWorkspace()
  const state: SessionState & { futureMetadata: { retained: boolean } } = {
    sessionId: 'discord:complete',
    segmentIndex: 3,
    lastActivityAt: '2026-08-26T12:34:56.000Z',
    lastKnownTokens: 4321,
    recovery: { id: 'recovery-fixture', reason: 'interrupted' },
    config: { model: 'test-model', temperature: 0.4 },
    parent: { id: 'discord:parent', physicalId: 'parent-2', index: 17 },
    workspaceRoot: 'discord:root',
    agentType: 'researcher',
    projectName: 'shadow',
    reportTo: 'discord:parent',
    originUser: 'Ada',
    description: 'Check migration parity',
    children: ['discord:child-1'],
    preloadTools: { search: ['--scope', 'docs'] },
    futureMetadata: { retained: true },
  }
  const statePath = join(sessionsDir, 'discord_complete.json')
  const logPath = join(sessionsDir, 'discord_complete-3.jsonl')
  const stateSource = JSON.stringify(state, null, 2)
  const logSource = '{"type":"start"}\n{"role":"user","content":"hello"}\n'

  try {
    await writeFile(statePath, stateSource)
    await writeFile(logPath, logSource)

    const summary = await migrateSessionsToSqlite(sessionsDir)
    assertEquals(summary.stateCount, 1)
    assertEquals(summary.logFileCount, 1)
    assertEquals(summary.logRecordCount, 2)

    const store = new SqliteSessionStore(sessionsDir)
    const migrated = await store.getState(state.sessionId)
    const { futureMetadata: _futureMetadata, ...runtimeState } = state
    assertEquals(migrated, runtimeState)
    const log = []
    for await (const record of store.readSessionLog('discord_complete-3')) {
      log.push(record)
    }
    assertEquals(log, [{ type: 'start' }, { role: 'user', content: 'hello' }])
    store.close()

    const db = new Database(join(sessionsDir, 'sessions.db'))
    const row = db.prepare(
      'SELECT segment_count, prototype FROM session_states WHERE key = ?',
    ).get(state.sessionId) as { segment_count: number; prototype: string }
    assertEquals(row.segment_count, 3)
    assertEquals(JSON.parse(row.prototype), {
      version: 1,
      metadata: Object.fromEntries(
        Object.entries(state).filter(([key]) =>
          !['sessionId', 'segmentIndex', 'lastActivityAt', 'lastKnownTokens']
            .includes(key)
        ),
      ),
    })
    db.close()

    assertEquals(await readFile(statePath, 'utf8'), stateSource)
    assertEquals(await readFile(logPath, 'utf8'), logSource)
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})

test('migration translates legacy state aliases and is repeatable', async () => {
  const sessionsDir = await createTempWorkspace()
  const legacyState = {
    key: 'legacy:key',
    currentSessionId: 'legacy-segment-2',
    historyChain: ['legacy-segment-0', 'legacy-segment-1', 'legacy-segment-2'],
    lastActivityAt: '2026-08-25T01:02:03.000Z',
    lastKnownTokens: 900,
    config: { model: 'legacy-model' },
  }

  try {
    await writeFile(
      join(sessionsDir, 'legacy.json'),
      JSON.stringify(legacyState),
    )
    await writeFile(
      join(sessionsDir, 'legacy-segment-2.jsonl'),
      '{"event":"only-once"}\n',
    )

    await migrateSessionsToSqlite(sessionsDir)
    await migrateSessionsToSqlite(sessionsDir)

    const store = new SqliteSessionStore(sessionsDir)
    assertEquals(await store.getState('legacy:key'), {
      sessionId: 'legacy:key',
      segmentIndex: 2,
      lastActivityAt: legacyState.lastActivityAt,
      lastKnownTokens: 900,
      config: { model: 'legacy-model' },
    })
    assertEquals(await store.countSessionLog('legacy-segment-2'), 1)
    store.close()
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})
