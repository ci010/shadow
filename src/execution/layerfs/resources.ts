import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, toNamespacedPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const immutableImageSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const repositorySchema = z.string().url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash }, 'Credential-free HTTPS repository required')
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
export const resourceSchema = z.object({
  name: identifier, runtimeId: identifier, layerfsProject: identifier,
  baselineRef: z.string().regex(/^(?:[a-f0-9]{2})+$/), image: immutableImageSchema,
  source: z.object({ repository: repositorySchema, commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
}).strict()
export const resourceRecordSchema = resourceSchema.extend({ revision: z.string().uuid(), projectId: z.string().min(1) })
export type LayerFSResource = z.infer<typeof resourceRecordSchema>
/** Immutable registrations only. Old pipeline records are neither read nor migrated. */
export class LayerFSResourceCatalog {
  private readonly file: string
  constructor(directory: string, readonly projectId: string) {
    if (!projectId) throw Error('Project ID required')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = toNamespacedPath(join(directory, 'resources.sqlite'))
    this.transaction(db => {
      db.exec('CREATE TABLE IF NOT EXISTS scope (project TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS resources (revision TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resource_workspaces (binding TEXT PRIMARY KEY)')
      const rows = db.prepare('SELECT project FROM scope').all()
      if (rows.length && (rows.length !== 1 || rows[0]!.project !== projectId)) throw Error('Resource catalog belongs to another Project')
      if (!rows.length) db.prepare('INSERT INTO scope VALUES (?)').run(projectId)
    })
  }
  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.file)
    try { db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE'); const result = fn(db); db.exec('COMMIT'); return result } finally { db.close() }
  }
  private decode(row: Record<string, unknown> | undefined) {
    if (!row) throw Error('Unknown resource ID')
    const value = resourceRecordSchema.parse(JSON.parse(String(row.document)))
    if (value.projectId !== this.projectId || value.revision !== row.revision) throw Error('Invalid resource identity')
    return value
  }
  register(input: z.infer<typeof resourceSchema>) {
    const value = resourceRecordSchema.parse({ ...resourceSchema.parse(input), revision: randomUUID(), projectId: this.projectId })
    return this.transaction(db => { db.prepare('INSERT INTO resources VALUES (?, ?)').run(value.revision, JSON.stringify(value)); return value })
  }
  bindWorkspace(binding: string) { this.transaction(db => { db.prepare('INSERT OR IGNORE INTO resource_workspaces VALUES (?)').run(binding) }) }
  hasWorkspace(binding: string) { return this.transaction(db => !!db.prepare('SELECT binding FROM resource_workspaces WHERE binding = ?').get(binding)) }
  get(id: string) { return this.transaction(db => this.decode(db.prepare('SELECT * FROM resources WHERE revision = ?').get(id))) }
  list() { return this.transaction(db => db.prepare('SELECT * FROM resources ORDER BY rowid').all().map(row => this.decode(row))) }
}
