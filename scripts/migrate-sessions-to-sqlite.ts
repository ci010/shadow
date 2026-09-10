#!/usr/bin/env node
/**
 * Migrate session history from JSONL files to SQLite.
 *
 * Usage:
 *   pnpm migrate:sessions <sessions-dir>
 *
 * Example:
 *   pnpm migrate:sessions ./workspace/.sessions
 *
 * What it does:
 *   1. Scans <sessions-dir> for *.json state files and *.jsonl log files
 *   2. Creates (or opens) <sessions-dir>/sessions.db
 *   3. Inserts all state and log records into the SQLite database
 *   4. Prints a summary of migrated sessions and log records
 *
 * The original JSONL files are NOT deleted — you can verify the migration
 * and remove them manually afterwards.
 */

import { DatabaseSync as Database } from 'node:sqlite'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import process from 'node:process'

const PROTOTYPE_VERSION = 1

export interface MigrationSummary {
  dbPath: string
  stateCount: number
  logFileCount: number
  logRecordCount: number
}

// ── Schema (must match SqliteSessionStore) ────────────────────────────────

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      key               TEXT PRIMARY KEY,
      segment_count     INTEGER NOT NULL DEFAULT 0,
      last_activity_at  TEXT,
      last_known_tokens INTEGER,
      prototype         TEXT
    );

    CREATE TABLE IF NOT EXISTS session_logs (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_session ON session_logs(session_id);
  `)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MODERN_STATE_FIELDS = new Set([
  'sessionId',
  'segmentIndex',
  'lastActivityAt',
  'lastKnownTokens',
])

const LEGACY_STATE_FIELDS = new Set([
  'key',
  'current',
  'currentSessionId',
  'history',
  'historyChain',
  'lastActivityAt',
  'lastKnownTokens',
])

interface MigratedState {
  key: string
  segmentIndex: number
  lastActivityAt: string | null
  lastKnownTokens: number | null
  prototype: string
  referencedSessionIds: string[]
}

function metadataPrototype(
  state: Record<string, unknown>,
  excludedFields: Set<string>,
): string {
  return JSON.stringify({
    version: PROTOTYPE_VERSION,
    metadata: Object.fromEntries(
      Object.entries(state).filter(([key]) => !excludedFields.has(key)),
    ),
  })
}

function parseState(state: unknown): MigratedState | null {
  if (!isRecord(state)) return null

  if (
    typeof state.sessionId === 'string' &&
    Number.isInteger(state.segmentIndex) &&
    (state.segmentIndex as number) >= 0
  ) {
    return {
      key: state.sessionId,
      segmentIndex: state.segmentIndex as number,
      lastActivityAt: typeof state.lastActivityAt === 'string'
        ? state.lastActivityAt
        : null,
      lastKnownTokens: typeof state.lastKnownTokens === 'number'
        ? state.lastKnownTokens
        : null,
      prototype: metadataPrototype(state, MODERN_STATE_FIELDS),
      referencedSessionIds: [state.sessionId],
    }
  }

  const key = typeof state.key === 'string' ? state.key : null
  const current = typeof state.current === 'string'
    ? state.current
    : typeof state.currentSessionId === 'string'
    ? state.currentSessionId
    : null
  const historyValue = Array.isArray(state.history)
    ? state.history
    : Array.isArray(state.historyChain)
    ? state.historyChain
    : []
  const history = historyValue.filter((id): id is string =>
    typeof id === 'string'
  )

  if (!key || !current) return null

  return {
    key,
    segmentIndex: Math.max(0, history.length - 1),
    lastActivityAt: typeof state.lastActivityAt === 'string'
      ? state.lastActivityAt
      : null,
    lastKnownTokens: typeof state.lastKnownTokens === 'number'
      ? state.lastKnownTokens
      : null,
    prototype: metadataPrototype(state, LEGACY_STATE_FIELDS),
    referencedSessionIds: [...history, current],
  }
}

// ── JSONL streaming (inlined to avoid importing from src) ─────────────────

async function* streamJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        stream.off('error', onError)
        resolve()
      }
      const onError = (err: NodeJS.ErrnoException) => {
        stream.off('open', onOpen)
        if (err.code === 'ENOENT') resolve()
        else reject(err)
      }
      stream.once('open', onOpen)
      stream.once('error', onError)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  try {
    let buffer = ''
    for await (const chunk of stream as AsyncIterable<string>) {
      buffer += chunk
      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) break
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line.trim()) yield line
      }
    }

    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    if (tail.trim()) yield tail
  } finally {
    stream.destroy()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function migrateSessionsToSqlite(
  sessionsDir: string,
): Promise<MigrationSummary> {
  const info = await stat(sessionsDir)
  if (!info.isDirectory()) throw new Error(`${sessionsDir} is not a directory`)

  const dbPath = join(sessionsDir, 'sessions.db')
  console.info(`Opening database: ${dbPath}`)

  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  initSchema(db)

  const insertState = db.prepare(`
    INSERT OR REPLACE INTO session_states
      (key, segment_count, last_activity_at, last_known_tokens, prototype)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertLog = db.prepare(
    'INSERT INTO session_logs (session_id, data) VALUES (?, ?)',
  )
  const deleteLog = db.prepare(
    'DELETE FROM session_logs WHERE session_id = ?',
  )

  let stateCount = 0
  let logFileCount = 0
  let logRecordCount = 0
  const migratedSessionIds = new Set<string>()

  // ── Pass 1: Migrate state files (.json) ──────────────────────────────

  console.info('\n── Migrating state files ──')

  for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue

    const filePath = join(sessionsDir, entry.name)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`  Skipping malformed state file: ${entry.name}`)
      continue
    }

    const state = parseState(parsed)
    if (!state) {
      console.warn(`  Skipping unrecognized state file: ${entry.name}`)
      continue
    }

    insertState.run(
      state.key,
      state.segmentIndex,
      state.lastActivityAt,
      state.lastKnownTokens,
      state.prototype,
    )

    for (const id of state.referencedSessionIds) migratedSessionIds.add(id)

    stateCount++
    console.info(
      `  [state] ${state.key} → segment=${state.segmentIndex}`,
    )
  }

  // ── Pass 2: Migrate session logs (.jsonl) ────────────────────────────

  console.info('\n── Migrating session logs ──')

  for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue

    const sessionId = entry.name.replace(/\.jsonl$/, '')
    const filePath = join(sessionsDir, entry.name)

    let recordCount = 0

    // Read all lines first (can't use async inside a sync transaction)
    const lines: string[] = []
    for await (const line of streamJsonlLines(filePath)) {
      lines.push(line)
    }

    if (lines.length === 0) {
      console.info(`  [log] ${sessionId}: empty, skipping`)
      continue
    }

    // Insert in a transaction
    db.exec('BEGIN')
    try {
      deleteLog.run(sessionId)
      for (const line of lines) {
        // Validate it's valid JSON before inserting
        try {
          JSON.parse(line)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          console.warn(`  [log] ${sessionId}: skipping malformed line`)
          continue
        }
        insertLog.run(sessionId, line)
        recordCount++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }

    logFileCount++
    logRecordCount += recordCount

    const inChain = migratedSessionIds.has(sessionId)
      ? ''
      : ' (orphan, no state references it)'
    console.info(`  [log] ${sessionId}: ${recordCount} records${inChain}`)
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  db.close()

  console.info('\n── Migration complete ──')
  console.info(`  States migrated:      ${stateCount}`)
  console.info(`  Log files migrated:   ${logFileCount}`)
  console.info(`  Total log records:    ${logRecordCount}`)
  console.info(`  Database written to:  ${dbPath}`)
  console.info('')
  console.info('Original JSONL files were NOT deleted.')
  console.info(
    'After verifying the migration, you can remove the .json and .jsonl files manually.',
  )

  return {
    dbPath,
    stateCount,
    logFileCount,
    logRecordCount,
  }
}

async function main() {
  const sessionsDir = process.argv[2]
  if (!sessionsDir) {
    console.error('Usage: migrate-sessions-to-sqlite.ts <sessions-dir>')
    console.error(
      'Example: migrate-sessions-to-sqlite.ts ./workspace/.sessions',
    )
    process.exit(1)
  }

  await migrateSessionsToSqlite(sessionsDir)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
}
