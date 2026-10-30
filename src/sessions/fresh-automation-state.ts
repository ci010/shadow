import { parseSessionRecovery, parseContextResetAt, parseDecisionOwner } from './session-store.ts'
import { parseWorkPolicy } from './work-policy.ts'
import { parseTopicSessionFields } from './topic-contract.ts'
import { parseSessionName } from './session-name.ts'
import { parseChannelBoundary } from '../channels/integration-contract.ts'
import { transaction } from '../utils/sqlite.ts'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionState, ArchivedStateQuery, ArchiveReference } from './session-store.ts'
import { validateOwnership } from '../projects/ownership.ts'
import { parseAutomationSessionRef } from '../cron/contracts.ts'
import { parseWorkdirRef } from './locality.ts'
import { parsePhysicalIdVersion } from './session-identity.ts'

/** Explicitly assigned at creation; legacy automation classification never opts records in. */
export interface FreshAutomationPolicy { version: 1; kind: 'fresh-automation'; jobId: string }

export function validateFreshAutomationState(state: SessionState): SessionState {
  state = validateOwnership({ ...state }) as unknown as SessionState
  const policy = state.statePersistence
  const automation = parseAutomationSessionRef(state.automation)
  if (!policy || policy.version !== 1 || policy.kind !== 'fresh-automation' || !policy.jobId
    || automation?.contextMode !== 'fresh' || automation.jobId !== policy.jobId
    || state.mode !== 'task' || state.parent?.index !== undefined || [state.projectId, state.sessionId, state.executionId].some(value => typeof value !== 'string' || !value)
    || !Number.isSafeInteger(state.segmentIndex) || state.segmentIndex < 0) {
    throw new Error('Invalid fresh automation state identity')
  }
  if (state.executionKey !== undefined && (typeof state.executionKey !== 'string' || !state.executionKey)) throw new Error('Invalid automation execution key')
  if (state.parentSessionId !== undefined && state.parentSessionId !== null && typeof state.parentSessionId !== 'string') throw new Error('Invalid automation parent')
  if (state.children !== undefined && (!Array.isArray(state.children) || state.children.some(id => typeof id !== 'string' || !id))) throw new Error('Invalid automation children')
  parsePhysicalIdVersion(state.physicalIdVersion)
  if (state.workdir && !parseWorkdirRef(state.workdir)) throw new Error('Invalid fresh automation workdir')
  parseSessionRecovery(state.recovery)
  parseContextResetAt(state.contextResetAt)
  parseDecisionOwner(state.decisionOwnerSessionId)
  parseWorkPolicy(state.workPolicy)
  parseTopicSessionFields(state)
  parseChannelBoundary(state.channelBoundary)
  for (const name of [state.name, state.generatedTitle, state.chatName]) if (name !== undefined) parseSessionName(name)
  if (state.automationCallerSettled !== undefined && typeof state.automationCallerSettled !== 'boolean') throw new Error('Invalid automation caller barrier')
  if (state.completionReported !== undefined && typeof state.completionReported !== 'boolean') throw new Error('Invalid automation report barrier')
  return state
}

/** Compare persisted revisions, normalizing only locality and JSON's omitted undefined values. */
function sameRevision(a: SessionState, b: SessionState): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
}

interface Slot { version: 1; projectId: string; jobId: string; active: Record<string, SessionState> }
interface Row { session_id: string; project_id: string; job_id: string; run_id: string; execution_id: string; state: string | null; archived: number; workdir: string | null }

/**
 * Small active pointers, separate indexed immutable finalized metadata. No log migration.
 * JSON commit precedes index update; boot reads only slots and repairs active index entries.
 * Archive commit precedes pointer removal; duplicates after interruption stay active until
 * the caller retries finalization. Serialized updates never remove another overlapping run.
 */
export class FreshAutomationStateStore {
  private db?: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private readonly directory: string
  private readonly databasePath: string

  constructor(private root: string, private format: 'jsonl' | 'sqlite', private readOnly = false) {
    this.directory = join(root, `.fresh-automation-v1-${format}`)
    this.databasePath = join(this.directory, 'archive.db')
  }

  private database(create = false): DatabaseSync | undefined {
    if (this.db) return this.db
    if (!create && !existsSync(this.databasePath)) return undefined
    if (!this.readOnly) mkdirSync(this.directory, { recursive: true })
    const db = new DatabaseSync(this.databasePath, { readOnly: this.readOnly })
    if (!this.readOnly) db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS features (
        project_id TEXT NOT NULL, job_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
        PRIMARY KEY(project_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS claims (
        project_id TEXT NOT NULL, folder_id TEXT NOT NULL, workdir TEXT NOT NULL,
        PRIMARY KEY(project_id, folder_id, workdir)
      );
      CREATE TABLE IF NOT EXISTS runs (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
        run_id TEXT NOT NULL, execution_id TEXT NOT NULL, execution_key TEXT,
        parent_id TEXT, started_at TEXT NOT NULL, archived INTEGER NOT NULL,
        state TEXT, folder_id TEXT, workdir TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_job ON runs(project_id, job_id, started_at, session_id);
      CREATE INDEX IF NOT EXISTS runs_execution_key ON runs(execution_key);
      CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_id);
      CREATE INDEX IF NOT EXISTS runs_active ON runs(archived);
      CREATE INDEX IF NOT EXISTS runs_ownership ON runs(project_id, folder_id, workdir);
    `)
    this.db = db
    return db
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  private slotPath(projectId: string, jobId: string): string {
    return join(this.directory, `${createHash('sha256').update(JSON.stringify([projectId, jobId])).digest('hex')}.json`)
  }

  private async readSlot(projectId: string, jobId: string): Promise<Slot> {
    let raw: string
    try { raw = await readFile(this.slotPath(projectId, jobId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projectId, jobId, active: {} }; throw error }
    const slot = JSON.parse(raw) as Slot
    this.validateSlot(slot)
    if (slot.projectId !== projectId || slot.jobId !== jobId) throw new Error('Fresh automation slot identity mismatch')
    return slot
  }

  private validateSlot(slot: Slot): void {
    if (slot.version !== 1 || typeof slot.projectId !== 'string' || !slot.projectId || typeof slot.jobId !== 'string' || !slot.jobId || !slot.active || typeof slot.active !== 'object' || Array.isArray(slot.active)) throw new Error('Invalid fresh automation slot')
    for (const [id, state] of Object.entries(slot.active)) {
      slot.active[id] = validateFreshAutomationState(state)
      if (id !== state.sessionId || slot.projectId !== state.projectId || slot.jobId !== state.statePersistence!.jobId) throw new Error('Fresh automation slot identity mismatch')
    }
  }

  private async writeSlot(slot: Slot): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.slotPath(slot.projectId, slot.jobId)
    const staging = `${target}.${crypto.randomUUID()}.pending`
    try { await writeFile(staging, JSON.stringify(slot)); await rename(staging, target) }
    finally { await rm(staging, { force: true }) }
  }

  private row(id: string): Row | undefined {
    return this.database()?.prepare('SELECT session_id, project_id, job_id, run_id, execution_id, state, archived, workdir FROM runs WHERE session_id = ?').get(id) as Row | undefined
  }

  private validateRow(row: Row): SessionState {
    if (!row.state) throw new Error('Missing archived automation state')
    const state = validateFreshAutomationState(JSON.parse(row.state))
    this.assertIdentity(row, state)
    this.assertIndexedWorkdir(row, state)
    if (row.archived && (!state.automationCallerSettled || !['completed', 'failed', 'cancelled'].includes(state.executionStatus ?? '')
      || state.recovery || state.reportTo && !state.completionReported)) throw new Error('Invalid finalized automation archive')
    return state
  }

  private assertIndexedWorkdir(row: Row, state: SessionState): void {
    const indexedWorkdir = row.workdir === null ? undefined : this.parseClaim(row.workdir)
    if (indexedWorkdir?.nodeId !== state.workdir?.nodeId || indexedWorkdir?.workdirId !== state.workdir?.workdirId) {
      throw new Error('Fresh automation indexed workdir mismatch')
    }
  }

  private assertIdentity(row: Row, state: SessionState): void {
    if (row.session_id !== state.sessionId || row.project_id !== state.projectId || row.job_id !== state.automation!.jobId
      || row.run_id !== state.automation!.runId || row.execution_id !== state.executionId) throw new Error('Fresh automation immutable identity mismatch')
  }

  private index(state: SessionState, archived: boolean): void {
    const db = this.database(true)!
    transaction(db, () => {
    db.prepare(`INSERT INTO runs(session_id, project_id, job_id, run_id, execution_id, execution_key, parent_id,
      started_at, archived, state, folder_id, workdir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET archived=excluded.archived, state=excluded.state,
      execution_key=excluded.execution_key, parent_id=excluded.parent_id, folder_id=excluded.folder_id, workdir=excluded.workdir`)
      .run(state.sessionId, state.projectId!, state.automation!.jobId, state.automation!.runId, state.executionId!, state.executionKey ?? null,
        state.parentSessionId ?? state.parent?.id ?? null, state.automation!.startedAt, archived ? 1 : 0,
        archived || this.format === 'sqlite' ? JSON.stringify(state) : null, state.folderId ?? null, state.workdir ? JSON.stringify(state.workdir) : null)
    if (archived) db.prepare(`INSERT INTO features(project_id, job_id, session_id, started_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, job_id) DO UPDATE SET session_id=excluded.session_id, started_at=excluded.started_at
      WHERE features.started_at < excluded.started_at OR (features.started_at = excluded.started_at AND features.session_id < excluded.session_id)`)
      .run(state.projectId!, state.automation!.jobId, state.sessionId, state.automation!.startedAt)
    db.prepare('INSERT OR IGNORE INTO claims(project_id, folder_id, workdir) VALUES (?, ?, ?)')
      .run(state.projectId!, state.folderId ?? '', state.workdir ? JSON.stringify(state.workdir) : '')
    })
  }

  async has(id: string): Promise<boolean> { await this.queue; return !!this.row(id) }

  async history(): Promise<SessionState[]> {
    const states = new Map(Object.values(await this.listActive()).map(state => [state.sessionId, state]))
    for (let offset = 0; ; offset += 1000) {
      const page = await this.query({ offset, limit: 1000 })
      for (const state of page) if (!states.has(state.sessionId)) states.set(state.sessionId, state)
      if (page.length < 1000) break
    }
    return [...states.values()]
  }

  async summaries() {
    return (await this.history()).map(state => ({ sessionId: state.sessionId, name: state.name,
      segmentIndex: state.segmentIndex, lastActivityAt: state.lastActivityAt, folderId: state.folderId,
      sessionKind: state.sessionKind, topic: state.topic, createdBySessionId: state.createdBySessionId }))
  }

  async save(state: SessionState): Promise<void> {
    const snapshot = structuredClone(validateFreshAutomationState(state))
    return this.serialized(async () => {
      const existing = this.row(snapshot.sessionId)
      if (existing) {
        this.assertIdentity(existing, snapshot)
        // Finalized rows are immutable. A delayed completion write cannot revive a run.
        if (existing.archived) throw new Error('Fresh automation execution already archived')
        if (this.format === 'sqlite') this.validateRow(existing)
        else {
          const active = (await this.readSlot(existing.project_id, existing.job_id)).active[snapshot.sessionId]
          if (!active) throw new Error('Fresh automation active state missing')
          this.assertIndexedWorkdir(existing, active)
        }
      }
      if (this.format === 'jsonl') {
        const slot = await this.readSlot(snapshot.projectId!, snapshot.automation!.jobId)
        slot.active[snapshot.sessionId] = snapshot
        await this.writeSlot(slot)
      }
      this.index(snapshot, false)
    })
  }

  async getActive(id: string): Promise<SessionState | null> {
    await this.queue
    const row = this.row(id)
    if (!row) return null
    if (this.format === 'jsonl') {
      const state = (await this.readSlot(row.project_id, row.job_id)).active[id]
      if (state) { this.assertIdentity(row, state); this.assertIndexedWorkdir(row, state); return state }
      return null
    }
    return row.archived ? null : this.validateRow(row)
  }

  async listActive(): Promise<Record<string, SessionState>> {
    await this.queue
    if (this.format === 'sqlite') {
      const rows = this.database()?.prepare('SELECT * FROM runs WHERE archived = 0').all() as Row[] | undefined
      return Object.fromEntries((rows ?? []).map(row => { const state = this.validateRow(row); return [state.sessionId, state] }))
    }
    let names: string[]
    try { names = await readdir(this.directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    const states: Record<string, SessionState> = {}
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const slot = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Slot
      this.validateSlot(slot)
      if (join(this.directory, name) !== this.slotPath(slot.projectId, slot.jobId)) throw new Error('Fresh automation slot address mismatch')
      for (const state of Object.values(slot.active)) {
        const row = this.row(state.sessionId)
        if (row) { this.assertIdentity(row, state); this.assertIndexedWorkdir(row, state) }
        // Preserve archive-first duplicates as unsettled; never hydrate the archive.
        if (!row && !this.readOnly) this.index(state, false)
        states[state.sessionId] = state
      }
    }
    return states
  }

  async archived(id: string): Promise<SessionState | null> {
    await this.queue
    const row = this.row(id)
    return row?.archived ? this.validateRow(row) : null
  }

  async archive(state: SessionState): Promise<void> {
    const snapshot = structuredClone(validateFreshAutomationState(state))
    if (!snapshot.automationCallerSettled || !['completed', 'failed', 'cancelled'].includes(snapshot.executionStatus ?? '')
      || snapshot.recovery || snapshot.reportTo && !snapshot.completionReported) throw new Error('Fresh automation finalization is unsettled')
    return this.serialized(async () => {
      const row = this.row(snapshot.sessionId)
      if (!row) throw new Error('Fresh automation active state missing')
      this.assertIdentity(row, snapshot)
      if (row.archived && !sameRevision(this.validateRow(row), snapshot)) throw new Error('Fresh automation archive revision conflict')
      if (this.format === 'jsonl') {
        const slot = await this.readSlot(snapshot.projectId!, snapshot.automation!.jobId)
        const active = slot.active[snapshot.sessionId]
        if (active) this.assertIndexedWorkdir(row, active)
        if (active && !sameRevision(active, snapshot)) throw new Error('Fresh automation active revision conflict')
        if (!row.archived) this.index(snapshot, true)
        delete slot.active[snapshot.sessionId]
        await this.writeSlot(slot)
      } else {
        if (!row.archived && !sameRevision(this.validateRow(row), snapshot)) throw new Error('Fresh automation active revision conflict')
        if (!row.archived) this.index(snapshot, true)
      }
    })
  }

  private selection(query: ArchivedStateQuery) {
    const clauses = ['archived = 1']
    const args: (string | number)[] = []
    for (const [field, value] of [['project_id', query.projectId], ['job_id', query.jobId], ['parent_id', query.parentId], ['execution_key', query.executionKey]] as const) {
      if (value !== undefined) { clauses.push(`${field} = ?`); args.push(value) }
    }
    if (query.from !== undefined) { clauses.push('started_at >= ?'); args.push(query.from) }
    if (query.before !== undefined) { clauses.push('started_at < ?'); args.push(query.before) }
    return { clauses, args }
  }

  async count(query: ArchivedStateQuery = {}): Promise<number> {
    await this.queue
    const { clauses, args } = this.selection(query)
    const row = this.database()?.prepare(`SELECT count(*) AS count FROM runs WHERE ${clauses.join(' AND ')}`).get(...args) as { count: number } | undefined
    return row?.count ?? 0
  }

  async features(projectId?: string): Promise<SessionState[]> {
    await this.queue
    const rows = this.database()?.prepare(`SELECT runs.* FROM features JOIN runs ON runs.session_id = features.session_id${projectId ? ' WHERE features.project_id = ?' : ''}`)
      .all(...(projectId ? [projectId] : [])) as unknown as Row[] | undefined
    return (rows ?? []).map(row => this.validateRow(row))
  }

  async query(query: ArchivedStateQuery = {}): Promise<SessionState[]> {
    await this.queue
    const db = this.database()
    if (!db) return []
    const { clauses, args } = this.selection(query)
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid archive page')
    const rows = db.prepare(`SELECT * FROM runs WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC, session_id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as Row[]
    return rows.map(row => this.validateRow(row))
  }

  async references(): Promise<ArchiveReference[]> {
    await this.queue
    // Compact columns only: finalized state blobs are not hydrated at startup.
    const rows = this.database()?.prepare(`SELECT project_id, folder_id, workdir, 'claim' AS source FROM claims
      UNION SELECT project_id, folder_id, workdir, 'run' AS source FROM runs`).all() as Array<{ project_id: string; folder_id: string | null; workdir: string | null; source: 'claim' | 'run' }> | undefined
    const refs = (rows ?? []).map(row => ({ projectId: row.project_id, ...(row.folder_id ? { folderId: row.folder_id } : {}),
      ...(row.workdir !== null && (row.source === 'run' || row.workdir !== '') ? { workdir: this.parseClaim(row.workdir) } : {}) }))
    return [...new Map(refs.map(ref => [JSON.stringify([ref.projectId, ref.folderId, ref.workdir?.nodeId, ref.workdir?.workdirId]), ref])).values()]
  }

  private parseClaim(raw: string) {
    const ref = parseWorkdirRef(JSON.parse(raw))
    if (!ref) throw new Error('Invalid archived workdir claim')
    return ref
  }

  close(): void { this.db?.close(); this.db = undefined }
}
