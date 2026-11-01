import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { writePrivateFile } from '../config/store.ts'

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function deadLocalOwner(lock: string): boolean {
  try {
    if (!lstatSync(lock).isDirectory() || !lstatSync(join(lock, 'owner.json')).isFile()) return false
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
    if (owner?.version !== 1 || owner.hostname !== hostname() ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.acquiredAt !== 'string' || !Number.isFinite(Date.parse(owner.acquiredAt))) return false
    try { process.kill(owner.pid, 0) } catch (error) { return isErrorCode(error, 'ESRCH') }
    return false
  } catch { return false }
}

function acquireLock(lock: string): void {
  try { mkdirSync(lock); return } catch (error) {
    if (!isErrorCode(error, 'EEXIST') || !deadLocalOwner(lock)) throw error
    // Serialize reclaimers independently of the directory being removed. A rename
    // is not safe here: it can move a replacement writer's lock after a race.
    const recovery = `${lock}.recovery`
    try { mkdirSync(recovery) } catch { throw error }
    try {
      // A previous reclaimer may already have replaced the lock. Recheck only
      // under the gate, and never touch a live, incomplete or ambiguous owner.
      if (!deadLocalOwner(lock)) throw error
      unlinkSync(join(lock, 'owner.json'))
      rmdirSync(lock) // Nonempty/unexpected directories fail closed; no recursive deletion.
      mkdirSync(lock) // A competing ordinary writer may win; EEXIST is safe.
    } finally { rmdirSync(recovery) }
  }
}

/** Synchronous project-local optimistic journal. Reclaim only a recorded same-host
 * owner whose PID probe returns ESRCH. Live/reused PIDs, foreign hosts, legacy or
 * incomplete metadata fail closed. Requires a local filesystem and unique host
 * identity/PID namespace, with all reclaimers following this protocol. A crash
 * before owner publication or during recovery leaves an ambiguous lock/gate;
 * operators must remove those only after stopping writers. No age-based expiry. */
export class Journal<T> {
  private revision: string | undefined
  constructor(private file: string, private parse: (value: unknown) => T) {
    this.revision = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
  read(fallback: T): T { return this.revision === undefined ? fallback : this.parse(JSON.parse(this.revision)) }
  save(state: T): void {
    this.parse(state)
    mkdirSync(dirname(this.file), { recursive: true })
    const lock = `${this.file}.lock`
    acquireLock(lock) // exclusive across instances/processes
    const ownerFile = join(lock, 'owner.json')
    let ownerWritten = false
    try {
      // Publish ownership only after exclusive acquisition. Missing/partial metadata
      // is deliberately not recoverable automatically.
      writeFileSync(ownerFile, JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
      ownerWritten = true
      const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined
      if (current !== this.revision) throw new Error('Watermark journal conflict; reload before retrying')
      const next = JSON.stringify(state) + '\n'
      writePrivateFile(this.file, next)
      this.revision = next
    } finally {
      if (ownerWritten) unlinkSync(ownerFile)
      rmdirSync(lock)
    }
  }
}

export interface Batch { state: 'pending' | 'running' | 'done'; attempts: string[] }
export function bindBatch(batch: Batch, attempt: string): void {
  if (batch.state !== 'pending') throw new Error('Watermark batch is not pending')
  if (batch.attempts.includes(attempt)) throw new Error('Watermark attempt must be unique')
  batch.attempts.push(attempt); batch.state = 'running'
}
export function finishBatch(batch: Batch, acknowledged: boolean): void {
  if (batch.state !== 'running') throw new Error('Watermark batch is not running')
  batch.state = acknowledged ? 'done' : 'pending'
}
