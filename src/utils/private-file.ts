import { randomUUID } from 'node:crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** Replace a persisted document atomically, without exposing a partially written file. */
export function writePrivateFile(path: string, content: string): void {
  const staging = `${path}.${randomUUID()}.new`
  try {
    writeFileSync(staging, content, { mode: 0o600, flag: 'wx' })
    chmodSync(staging, 0o600)
    renameSync(staging, path)
  } finally {
    rmSync(staging, { force: true })
  }
}
