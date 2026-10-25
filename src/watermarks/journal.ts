import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writePrivateFile } from '../config/store.ts'

/** Synchronous project-local optimistic journal. A crashed writer leaves a lock: fail closed,
 * rather than steal a live writer's lock. Operators may remove it after stopping writers. */
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
    mkdirSync(lock) // exclusive across instances/processes
    try {
      const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined
      if (current !== this.revision) throw new Error('Watermark journal conflict; reload before retrying')
      const next = JSON.stringify(state) + '\n'
      writePrivateFile(this.file, next)
      this.revision = next
    } finally { rmdirSync(lock) }
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
