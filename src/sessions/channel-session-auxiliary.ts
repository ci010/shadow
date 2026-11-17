import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export const channelAuxiliaryDirectories = new Set(['.fresh-automation-v1-jsonl', '.fresh-automation-v1-sqlite', '.conversation-archive-v1'])

/** Preserve unrelated auxiliary stores byte-for-byte, but prove first that no
 * changed logical/physical identity occurs in their keys, indices or payloads.
 * Do not open live SQLite files: read a disposable copy including WAL frames. */
export async function inspectChannelAuxiliary(directory: string, identities: ReadonlyMap<string, string>): Promise<{ directories: number; files: number }> {
  const changed = new Set([...identities].filter(([from, to]) => from !== to).map(([from]) => from))
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (changed.has(value)) throw new Error('Auxiliary store references a migrated channel identity; explicit auxiliary reference migration required')
      try { const parsed = JSON.parse(value); if (parsed !== value) inspect(parsed) } catch (error) { if (!(error instanceof SyntaxError)) throw error }
    } else if (Array.isArray(value)) value.forEach(inspect)
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { inspect(key); inspect(child) }
  }
  let directories = 0, files = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!channelAuxiliaryDirectories.has(entry.name)) {
      if ((await readdir(join(directory, entry.name))).length) throw new Error('Unknown nonempty auxiliary directory')
      continue
    }
    directories++
    const source = join(directory, entry.name), entries = await readdir(source, { withFileTypes: true })
    for (const file of entries) {
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unsupported auxiliary store entry')
      if (!file.name.endsWith('.json') && !['archive.db', 'archive.db-wal', 'archive.db-shm'].includes(file.name)) throw new Error('Unknown auxiliary store file')
      if (file.name.endsWith('.json')) inspect(JSON.parse(await readFile(join(source, file.name), 'utf8')))
      files++
    }
    if (!entries.some(file => file.name === 'archive.db')) {
      if (entries.some(file => file.name.startsWith('archive.db-'))) throw new Error('Auxiliary SQLite sidecar without database')
      continue
    }
    const snapshot = await mkdtemp(join(tmpdir(), 'shadow-channel-aux-'))
    try {
      await cp(source, snapshot, { recursive: true })
      const db = new DatabaseSync(join(snapshot, 'archive.db'), { readOnly: true })
      try {
        const allowed = entry.name === '.conversation-archive-v1'
          ? new Set(['archives', 'segments', 'blocks', 'resources'])
          : new Set(['features', 'claims', 'runs', 'archive_revision'])
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        for (const table of tables) {
          const name = String(table.name)
          if (!allowed.has(name)) throw new Error('Unknown auxiliary SQLite table')
          for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) for (const [key, value] of Object.entries(row)) {
            if (value instanceof Uint8Array) {
              if (name !== 'blocks' || key !== 'data') throw new Error('Unknown auxiliary binary payload')
              const decoded = gunzipSync(value, { maxOutputLength: 16777216 })
              if (decoded.length !== row.size || createHash('sha256').update(decoded).digest('hex') !== row.checksum) throw new Error('Auxiliary archive block checksum mismatch')
              inspect(JSON.parse(decoded.toString('utf8')))
            } else inspect(value)
          }
        }
      } finally { db.close() }
    } finally { await rm(snapshot, { recursive: true, force: true }) }
  }
  return { directories, files }
}
