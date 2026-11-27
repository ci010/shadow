import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { WORK_CREATION_SCHEMA, workRecordObjectSchema, workRecordSchema, type WorkRecord } from '../src/initiatives/work-contract.ts'
import { workKeySchema } from '../src/initiatives/work-key.ts'
import { workArtifactsSchema, workBasisSchema, workKindSchema } from '../src/initiatives/work-notes.ts'
import { WORK_NOTE_SCHEMA, workNoteSchema } from '../src/initiatives/work-note.ts'
import { InitiativeStore } from '../src/initiatives/store.ts'
import { decisionEvidenceSchema } from '../src/sessions/decision-brief.ts'
import { WORK_DISPATCH_ID } from '../src/cron/work-dispatch-contract.ts'

const text = z.string().trim().min(1).max(2000)
const legacyDefinition = z.object({
  objective: z.string().trim().min(1).max(4000),
  acceptance: z.array(z.string().trim().min(1).max(4000)).max(12),
  boundaries: z.array(z.string().trim().min(1).max(4000)).max(12),
  evidence: z.array(decisionEvidenceSchema).max(8),
}).strict()
const legacyNotes = z.object({
  basis: workBasisSchema, kind: workKindSchema, summary: z.string().trim().max(2000),
  plan: z.array(text).max(12), next: z.string().trim().max(2000),
  artifacts: workArtifactsSchema, html: z.string().max(48_000),
  relation: z.object({ kind: z.enum(['supports', 'requires', 'assumption']), reason: text }).strict().optional(),
  attention: z.object({
    kind: z.enum(['assumption', 'scope', 'dependency', 'decision', 'blocker']),
    summary: text, awaitingResponse: z.boolean().optional(), version: z.number().int().positive(),
    at: z.string().datetime(), by: z.string().min(1).max(512),
    reviewed: z.object({
      by: z.string().min(1).max(512), at: z.string().datetime(), conclusion: text,
      disposition: z.enum(['record', 'return_to_assignee']).optional(),
      assignmentRevision: z.number().int().positive().optional(), version: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict()
const legacyRecord = z.object({
  key: workKeySchema, subject: z.object({ kind: z.literal('work'), id: z.string().uuid() }).strict(),
  revision: z.number().int().positive(), sequence: z.number().int().positive(),
  definition: legacyDefinition, origin: z.enum(['human', 'agent_interpretation']),
  changedBy: z.string().min(1), changedAt: z.string().datetime(),
  change: z.enum(['understanding', 'goal', 'authorization', 'pause']), reason: text, paused: z.boolean(),
  creationRequest: z.object({
    creator: z.string().min(1).max(520), key: z.string().min(1).max(200), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().optional(),
  requestSource: decisionEvidenceSchema.extend({ kind: z.literal('user') }).optional(),
  workflow: z.object({
    automaticDispatch: z.enum(['manual', 'ready']).optional(),
    title: z.string().trim().min(1).max(160), parentKey: workKeySchema.optional(),
    manager: z.string().min(1).max(512).nullable(), assignee: z.string().min(1).max(512).nullable(),
    assignmentRevision: z.number().int().positive(), assignmentStarted: z.boolean().optional(),
    status: z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled']),
    blockedReason: text.optional(), blockedScope: z.enum(['step', 'work']).optional(),
    dependencies: z.array(workKeySchema).max(100),
    result: z.object({ summary: text, evidence: z.array(decisionEvidenceSchema).max(8) }).strict().optional(),
  }).strict(),
  notes: legacyNotes.optional(),
  observation: workRecordObjectSchema.shape.observation,
}).strict()

export function convertLegacyWork(value: unknown, at: string): {
  record: WorkRecord
  creation?: { creator: string; key: string; fingerprint: string }
  comments: string[]
} {
  const old = legacyRecord.parse(value)
  if (old.key !== `work:${old.subject.id}`) throw new Error('Legacy Work subject and key disagree')
  if (old.paused) throw new Error('Paused legacy Work requires an explicit lifecycle decision before migration')
  if (old.workflow.automaticDispatch === 'manual') throw new Error('Manual legacy Work requires a per-Work scheduling policy before migration')
  const sections = [old.definition.objective]
  if (old.definition.acceptance.length) sections.push('## Acceptance\n' + old.definition.acceptance.map(item => `- ${item}`).join('\n'))
  if (old.definition.boundaries.length) sections.push('## Boundaries\n' + old.definition.boundaries.map(item => `- ${item}`).join('\n'))
  const evidence = [...old.definition.evidence, ...(old.requestSource ? [old.requestSource] : [])]
  if (evidence.length) sections.push('## Source evidence (historical context, not authorization)\n' + JSON.stringify(evidence, null, 2))
  const { automaticDispatch: _dispatch, blockedScope: _scope, result, ...workflow } = old.workflow
  const record = workRecordSchema.parse({
    key: old.key, revision: old.revision, sequence: old.sequence + 1, ...workflow,
    definition: sections.join('\n\n'), origin: old.origin, changedBy: 'human', changedAt: at,
    kind: old.notes?.kind ?? 'task', summary: old.notes?.summary || result?.summary || '',
    artifacts: old.notes?.artifacts ?? [], basis: old.notes?.basis ?? [],
    ...(old.observation ? { observation: old.observation } : {}),
  })
  const comments = [
    ...(old.notes?.plan ?? []).map(item => `Historical plan: ${item}`),
    ...(old.notes?.next ? [`Historical next step: ${old.notes.next}`] : []),
    ...(old.notes?.attention ? [`Historical attention: ${old.notes.attention.summary}`] : []),
    ...(result?.evidence.length ? ['Historical result evidence:\n' + JSON.stringify(result.evidence, null, 2)] : []),
  ].flatMap(body => {
    const parts: string[] = []
    for (let offset = 0; offset < body.length; offset += 1900) parts.push(body.slice(offset, offset + 1900))
    return parts
  })
  return { record, creation: old.creationRequest, comments }
}

interface Change {
  before: string
  record: WorkRecord
  creation?: { creator: string; key: string; fingerprint: string }
  comments: string[]
}
function changes(db: DatabaseSync, at: string): Change[] {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 6) throw new Error('Only the version-6 canonical Work database is supported')
  return db.prepare('SELECT id,sequence,data FROM work_contracts ORDER BY id').all().flatMap(row => {
    const before = String(row.data), value: unknown = JSON.parse(before)
    const current = workRecordSchema.safeParse(value)
    if (current.success) return []
    const converted = convertLegacyWork(value, at)
    if (row.id !== converted.record.key || row.sequence !== converted.record.sequence - 1) throw new Error('Legacy Work row identity or sequence disagrees')
    return [{ before, ...converted }]
  })
}

function migrateDatabase(db: DatabaseSync, items: Change[], at: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(WORK_CREATION_SCHEMA + WORK_NOTE_SCHEMA + `CREATE TABLE IF NOT EXISTS work_record_migration_archive (
      work_key TEXT PRIMARY KEY REFERENCES work_contracts(id), migrated_at TEXT NOT NULL, original_data TEXT NOT NULL
    ) STRICT;`)
    for (const item of items) {
      const { record } = item
      db.prepare('INSERT INTO work_record_migration_archive VALUES (?,?,?)').run(record.key, at, item.before)
      const update = db.prepare('UPDATE work_contracts SET sequence=?,data=? WHERE id=? AND data=?')
        .run(record.sequence, JSON.stringify(record), record.key, item.before)
      if (update.changes !== 1) throw new Error('Work data changed during migration')
      db.prepare('INSERT INTO work_contract_events (id,work_key,actor,kind,created_at,data) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), record.key, 'human', 'offline_format_migration', at, JSON.stringify(record))
      if (item.creation) db.prepare('INSERT INTO work_creation_receipts VALUES (?,?,?,?)')
        .run(item.creation.creator, item.creation.key, record.key, item.creation.fingerprint)
      for (const body of item.comments) {
        const note = workNoteSchema.parse({ id: randomUUID(), workKey: record.key, author: 'human', createdAt: at, body })
        db.prepare('INSERT INTO work_notes (id,work_key,author,created_at,body) VALUES (?,?,?,?,?)')
          .run(note.id, note.workKey, note.author, note.createdAt, note.body)
      }
    }
    // Old delivery facts remain history but are never replayed on this upgrade.
    db.prepare('UPDATE work_notifications SET pending=0 WHERE pending=1').run()
    if (db.prepare("SELECT count(*) AS n FROM work_effects WHERE status NOT IN ('completed','failed','cancelled')").get()?.n
      || db.prepare("SELECT count(*) AS n FROM work_kickoffs WHERE state='pending'").get()?.n) {
      throw new Error('Unfinished Work effects or kickoffs require inspection before migration')
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export async function migrateWorkRecords(home: string, action: 'plan' | 'apply', runtimeStopped: boolean) {
  if (action === 'apply' && !runtimeStopped) throw new Error('Stop every runtime owning this Project and pass --runtime-stopped')
  home = resolve(home)
  const path = join(home, 'state', 'work.sqlite'), at = new Date().toISOString()
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error('Work database must be a regular, singly linked file')
  const db = new DatabaseSync(path, { readOnly: action === 'plan' })
  try {
    const items = changes(db, at)
    if (!items.length) return { migrated: 0, alreadyCurrent: true }
    const jobsPath = join(home, 'state', 'cron', 'jobs.json')
    const jobsRaw = await readFile(jobsPath, 'utf8')
    const scheduler: unknown = JSON.parse(jobsRaw)
    const jobs = z.object({ jobs: z.array(z.object({
      id: z.string(), enabled: z.boolean().optional(), program: z.unknown().optional(),
    }).passthrough()) }).passthrough().parse(scheduler)
    const dispatch = jobs.jobs.filter(job => job.id === WORK_DISPATCH_ID)
    if (dispatch.length !== 1) throw new Error('Exactly one Work dispatcher must exist before migration')
    dispatch[0]!.enabled = false
    const nextJobs = JSON.stringify(jobs, null, 2) + '\n'
    if (action === 'plan') return { migrated: items.length, automaticDispatch: 'will-disable', auditHistory: 'preserved', sessions: 'unchanged' }
    const directory = join(home, 'state', 'work-record-migrations', randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const backupPath = join(directory, 'work.before.sqlite'), stagedHome = join(directory, 'staged')
    await backup(db, backupPath)
    await writeFile(join(directory, 'jobs.before.json'), jobsRaw, { flag: 'wx', mode: 0o600 })
    await mkdir(join(stagedHome, 'state'), { recursive: true, mode: 0o700 })
    const stagedPath = join(stagedHome, 'state', 'work.sqlite')
    await backup(db, stagedPath)
    const staged = new DatabaseSync(stagedPath)
    try { migrateDatabase(staged, items, at) } finally { staged.close() }
    const check = new InitiativeStore(stagedHome)
    try { check.workRecords(); check.projectFocus() } finally { check.close() }
    const journalPath = join(directory, 'journal.json')
    const journal = { version: 1, state: 'prepared', at, backupPath, jobsPath, jobsSha256: digest(jobsRaw), migrated: items.length }
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (await readFile(jobsPath, 'utf8') !== jobsRaw) throw new Error('Scheduler changed during migration; nothing was migrated')
    // Stop dispatch before committing records. An interrupted apply stays fail-closed.
    const staging = join(directory, 'jobs.disabled.json')
    await writeFile(staging, nextJobs, { flag: 'wx', mode: 0o600 })
    await rename(staging, jobsPath)
    migrateDatabase(db, items, at)
    await writeFile(journalPath, JSON.stringify({ ...journal, state: 'applied', jobsAfterSha256: digest(nextJobs) }, null, 2) + '\n', { mode: 0o600 })
    return { migrated: items.length, automaticDispatch: 'disabled', auditHistory: 'preserved', sessions: 'unchanged', journalPath }
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, home, flag, ...extra] = process.argv.slice(2)
  if ((action !== 'plan' && action !== 'apply') || !home || extra.length || (flag !== undefined && flag !== '--runtime-stopped')) {
    throw new Error('Usage: migrate-work-records.ts plan|apply <Project home> [--runtime-stopped]')
  }
  console.log(JSON.stringify(await migrateWorkRecords(home, action, flag === '--runtime-stopped')))
}
