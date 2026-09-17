import { deepEqual as assertEquals, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync as Database } from 'node:sqlite'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState } from './session-store.ts'
import { localFolderWorkdirRef } from './locality.ts'

test('SqliteSessionStore preserves folder identity alongside unknown prototype metadata', async () => {
  const sessionsDir = await createTempWorkspace()
  const dbPath = join(sessionsDir, 'sessions.db')
  try {
    const writer = new SqliteSessionStore(sessionsDir)
    await writer.saveState('web:folder', { sessionId: 'web:folder', segmentIndex: 2 })
    writer.close()
    const metadata = {
      ownershipVersion: 2,
      folderId: 'folder-folder',
      initiativeId: 'planning-notes',
      workdir: localFolderWorkdirRef('folder-folder'),
      futureMetadata: { preserved: true },
    }
    const db = new Database(dbPath)
    db.prepare('UPDATE session_states SET prototype = ? WHERE key = ?')
      .run(JSON.stringify({ version: 1, metadata }), 'web:folder')
    db.close()
    const reader = new SqliteSessionStore(sessionsDir)
    try {
      const state = (await reader.getState('web:folder'))!
      assertEquals(state.folderId, 'folder-folder')
      assertEquals(state.workdir, metadata.workdir)
      state.description = 'Updated session'
      await reader.saveState(state.sessionId, state)
    } finally {
      reader.close()
    }
    const verify = new Database(dbPath)
    try {
      const row = verify.prepare('SELECT prototype FROM session_states WHERE key = ?')
        .get('web:folder') as { prototype: string }
      assertEquals(JSON.parse(row.prototype).metadata, {
        ...metadata,
        description: 'Updated session',
      })
    } finally {
      verify.close()
    }
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})

test('SqliteSessionStore round-trips complete SessionState metadata', async () => {
  const sessionsDir = await createTempWorkspace()
  const state: SessionState = {
    ownershipVersion: 2,
    sessionId: 'discord:complete',
    mode: 'task',
    executionId: 'discord:complete',
    executionStatus: 'completed',
    executionKey: 'parent:turn:tool',
    completionReported: true,
    parentSessionId: 'discord:parent',
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
    initiativeId: 'shadow',
    folderId: 'folder-folder-a',
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

test('SqliteSessionStore rejects config-only prototypes instead of adopting unowned sessions', async () => {
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
    try {
      await rejects(reader.getState('legacy:session'), /Unsupported session prototype/)
      await rejects(reader.listAllStates(), /Unsupported session prototype/)
    } finally { reader.close() }
  } finally {
    await rm(sessionsDir, { recursive: true })
  }
})
