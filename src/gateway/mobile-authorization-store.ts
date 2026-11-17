import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Device authorization state, not session history (neither JSONL nor session SQLite).
 * Only SHA-256 bearer digests are durable. Bridge tokens and file tickets stay ephemeral.
 */
export interface MobileAuthorization {
  id: string
  accessHash: string
  expiresAt: number | null
}
export interface MobileAuthorizationStore {
  load(): MobileAuthorization[]
  save(records: MobileAuthorization[]): void
}
export function validateMobileAuthorizations(value: unknown): MobileAuthorization[] {
  const data = value as { version: number; authorizations: MobileAuthorization[] }
  if (!data || data.version !== 1 || !Array.isArray(data.authorizations) || data.authorizations.length > 32) throw new TypeError('Invalid mobile authorization state')
  const ids = new Set<string>(), hashes = new Set<string>()
  return data.authorizations.map(record => {
    if (!record || Object.keys(record).sort().join(',') !== 'accessHash,expiresAt,id'
      || typeof record.id !== 'string' || typeof record.accessHash !== 'string'
      || !/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.accessHash)
      || !(record.expiresAt === null || (Number.isSafeInteger(record.expiresAt) && record.expiresAt! > 0))
      || ids.has(record.id) || hashes.has(record.accessHash)) throw new TypeError('Invalid mobile authorization state')
    ids.add(record.id); hashes.add(record.accessHash)
    return { id: record.id, accessHash: record.accessHash, expiresAt: record.expiresAt }
  })
}

/** Matches the device registry's versioned, owner-only atomic snapshot boundary.
 * Synchronous tiny (max 32) writes serialize grant/revoke with request authorization.
 */
export class AtomicMobileAuthorizationStore implements MobileAuthorizationStore {
  constructor(readonly filePath: string) {}
  load(): MobileAuthorization[] {
    let text: string
    try { text = readFileSync(this.filePath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return validateMobileAuthorizations(JSON.parse(text))
  }
  save(records: MobileAuthorization[]): void {
    const data = { version: 1, authorizations: records }
    validateMobileAuthorizations(data)
    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.filePath)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
}
