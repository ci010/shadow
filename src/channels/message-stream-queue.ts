import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { writePrivateFile } from '../utils/private-file.ts'

// One Main process owns each Project's stream. Shared by all stream instances in
// this module, NOT a cross-process exclusion mechanism. Never open the same
// Project data with two Main processes (including dev and packaged instances).
const tails = new Map<string, Promise<void>>()
export function enqueueStreamWrite<T>(file: string, action: () => T): Promise<T> {
  const key = resolve(file)
  const result = (tails.get(key) ?? Promise.resolve()).then(action)
  const tail = result.then(() => {}, () => {}) // A failed job must not poison later arrivals.
  tails.set(key, tail)
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
  return result
}
export async function drainStreamWrites(file: string): Promise<void> {
  // Call after quiescing producers; include work admitted while awaiting a tail.
  while (tails.has(resolve(file))) await tails.get(resolve(file))
}

/** No lock files, reclaim or deletion. Only used inside the Project stream FIFO. */
export class StreamDocument<T> {
  constructor(private file: string, private parse: (value: unknown) => T) {}
  read(fallback: T): T {
    return existsSync(this.file) ? this.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : fallback
  }
  save(state: T): void {
    this.parse(state)
    mkdirSync(dirname(this.file), { recursive: true })
    writePrivateFile(this.file, JSON.stringify(state) + '\n')
  }
}
