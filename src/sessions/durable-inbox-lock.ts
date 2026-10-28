import { DatabaseSync } from 'node:sqlite'

/** Dedicated advisory lock database, never a session/Project database. SQLite's
 * OS locks release on process death; no timeout-based lock stealing or PID race.
 * Callers serialize same-process contenders and retry SQLITE_BUSY externally.
 * No session records, logs, binding data or broker receipts are written here. */
export function acquireDurableInboxLock(path: string): () => void {
  const database = new DatabaseSync(path)
  try { database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE') }
  catch (error) { database.close(); throw error }
  return () => { try { database.exec('ROLLBACK') } finally { database.close() } }
}
