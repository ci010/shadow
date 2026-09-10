import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync as Database } from 'node:sqlite'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState } from './session-store.ts'

test('SqliteSessionStore round-trips complete SessionState metadata', async () => {
  const sessionsDir = await createTempWorkspace()
  const state: SessionState = {
    sessionId: 'discord:complete',
    segmentIndex: 3,
    lastActivityAt: '2026-08-26T12:34:56.000Z',
    lastKnownTokens: 4321,
    config: {
      triggerMode: 'mention',
      model: 'test-model',
      temperature: 0.4,
      maxTokens: 8192,
      defaultShell: 'powershell',
      reasoningEffort: 'max',
    },
    parent: { id: 'discord:parent', physicalId: 'parent-2', index: 17 },
    workspaceRoot: 'discord:root',
    workdir: {
      version: 1,
      nodeId: 'local',
      capabilityId: 'managed-session-v1:discord%3Aroot',
      displayName: 'Managed session folder',
    },
    agentType: 'researcher',
    projectName: 'shadow',
    reportTo: 'discord:parent',
    originUser: 'Ada',
    description: 'Check SQLite parity',
    children: ['discord:child-1', 'discord:child-2'],
    preloadTools: {
      search: ['--scope', 'docs'],
      calculator: [],
    },
  }

  try {
    const writer = new SqliteSessionStore(sessionsDir)
    await writer.saveState(state.sessionId, state)
    writer.close()

    const reader = new SqliteSessionStore(sessionsDir)
    assertEquals(await reader.getState(state.sessionId), state)
    assertEquals(await reader.listAllStates(), { [state.sessionId]: state })
    reader.close()

    const db = new Database(join(sessionsDir, 'sessions.db'))
    const row = db.prepare(
      'SELECT prototype FROM session_states WHERE key = ?',
    ).get(state.sessionId) as { prototype: string }
    assertEquals(JSON.parse(row.prototype).version, 1)
    db.close()
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})

test('SqliteSessionStore loads legacy config-only prototype rows', async () => {
  const sessionsDir = await createTempWorkspace()
  const dbPath = join(sessionsDir, 'sessions.db')

  try {
    const store = new SqliteSessionStore(sessionsDir)
    store.close()

    const db = new Database(dbPath)
    db.prepare(`
      INSERT INTO session_states
        (key, segment_count, last_activity_at, last_known_tokens, prototype)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'legacy:session',
      2,
      '2026-08-25T01:02:03.000Z',
      900,
      JSON.stringify({ model: 'legacy-model', temperature: 0.2 }),
    )
    db.close()

    const reader = new SqliteSessionStore(sessionsDir)
    const legacyState = await reader.getState('legacy:session')
    assertEquals(legacyState, {
      sessionId: 'legacy:session',
      segmentIndex: 2,
      lastActivityAt: '2026-08-25T01:02:03.000Z',
      lastKnownTokens: 900,
      config: { model: 'legacy-model', temperature: 0.2 },
    })
    await reader.saveState('legacy:session', legacyState!)
    reader.close()

    const migratedDb = new Database(dbPath)
    const migratedRow = migratedDb.prepare(
      'SELECT prototype FROM session_states WHERE key = ?',
    ).get('legacy:session') as { prototype: string }
    assertEquals(JSON.parse(migratedRow.prototype), {
      version: 1,
      metadata: {
        config: { model: 'legacy-model', temperature: 0.2 },
      },
    })
    migratedDb.close()
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})
