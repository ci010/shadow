import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../src/testing/workspace.ts'
import { DatabaseSync as Database } from 'node:sqlite'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { migrateSessionsToSqlite } from './migrate-sessions-to-sqlite.ts'
import { SqliteSessionStore } from '../src/sessions/session-store-sqlite.ts'
import type { SessionState } from '../src/sessions/session-store.ts'
import { OwnershipValidationError } from '../src/projects/ownership.ts'
import { physicalSessionId } from '../src/sessions/session-identity.ts'

for (const physicalIdVersion of [undefined, 2] as const) {
  test(`migration preserves modern SessionState metadata and v${physicalIdVersion ?? 1} JSONL log addresses`, () => checkModernMigration(physicalIdVersion))
}

async function checkModernMigration(physicalIdVersion: 2 | undefined) {
  const sessionsDir = await createTempWorkspace()
  const state: SessionState & { futureMetadata: { retained: boolean } } = {
    ownershipVersion: 2,
    ...(physicalIdVersion === undefined ? {} : { physicalIdVersion }),
    projectId: 'owner',
    folderId: 'directory',
    sessionId: 'discord:complete',
    name: 'User-selected conversation name',
    segmentIndex: 3,
    contextResetAt: '2026-08-26T11:00:00.000Z',
    lastActivityAt: '2026-08-26T12:34:56.000Z',
    lastKnownTokens: 4321,
    recovery: { id: 'recovery-fixture', reason: 'interrupted' },
    config: { model: 'test-model', temperature: 0.4 },
    parent: { id: 'discord:parent', physicalId: 'parent-2', index: 17 },
    workspaceRoot: 'discord:root',
    agentType: 'researcher',
    initiativeId: 'shadow',
    reportTo: 'discord:parent',
    originUser: 'Ada',
    description: 'Check migration parity',
    children: ['discord:child-1'],
    preloadTools: { search: ['--scope', 'docs'] },
    futureMetadata: { retained: true },
  }
  const statePath = join(sessionsDir, 'discord_complete.json')
  const logId = physicalSessionId(state)
  const logPath = join(sessionsDir, `${logId}.jsonl`)
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
    for await (const record of store.readSessionLog(logId)) {
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
}

test('migration translates history aliases with canonical ownership and is repeatable', async () => {
  const sessionsDir = await createTempWorkspace()
  const legacyState = {
    ownershipVersion: 2,
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
      ownershipVersion: 2,
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

test('migration refuses to reinterpret unversioned Project ownership and closes its database', async () => {
  const sessionsDir = await createTempWorkspace()
  const statePath = join(sessionsDir, 'old.json')
  const state = JSON.stringify({ sessionId: 'web:old', segmentIndex: 0, projectId: 'ambiguous' })
  try {
    await writeFile(statePath, state)
    await assertRejects(migrateSessionsToSqlite(sessionsDir), OwnershipValidationError)
    assertEquals(await readFile(statePath, 'utf8'), state)
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})
