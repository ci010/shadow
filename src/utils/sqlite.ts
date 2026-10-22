import type { DatabaseSync } from 'node:sqlite'

/** Commit a synchronous unit of work, rolling back every failed write. */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
