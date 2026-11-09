import { projectFocusSnapshotSchema, type ProjectFocusSnapshot } from '../projects/focus-contract.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { WORK_SCHEMA, WorkConflict, workKey, workRecordSchema, workSubjectSchema, workObservationSchema,
  type WorkSubject, type WorkAuthority, type WorkRecord, type WorkObservation } from './work-contract.ts'

export type InitiativeRow = Record<string, string | number | null>

export interface InitiativeStoreOptions {
  sessionTopicSequence?: (sessionId: string) => number | undefined
  /** Informative only, never releases work. True is live, false inactive, undefined unknown. */
  isSessionActive?: (sessionId: string) => boolean | undefined
  /** If supplied, new owner/assignee targets must belong to this Project runtime. */
  isSessionKnown?: (sessionId: string) => boolean
}

const MAX_TABLE_ROWS = 5000
const MAX_RESULT_BYTES = 262_144

export class InitiativeStore {
  readonly home: string
  #db: DatabaseSync
  #closed = false
  #busy = false
  #writeAccess = false
  #options: InitiativeStoreOptions

  constructor(home: string, options: InitiativeStoreOptions = {}) {
    this.home = resolve(home)
    this.#options = options
    const filename = projectStoragePath(this.home, 'initiatives.sqlite')
    mkdirSync(dirname(filename), { recursive: true })
    if (existsSync(filename)) {
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Work database must be a regular file, not a symbolic link')
      if (stat.size > 134_217_728) throw new Error('Work database file size limit exceeded')
    }
    this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false })
    try {
      const version = this.#db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (![0, 6].includes(version.user_version)) throw new Error('Unsupported Work database version. Legacy databases are not imported; preserve the file and select a current Work database.')
      if (version.user_version === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (tables.length) throw new Error('Unrecognized initiative database schema')
        this.#db.exec(`BEGIN IMMEDIATE; ${WORK_SCHEMA} PRAGMA user_version=6; COMMIT;`)
      }
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;')
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_observations (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS project_focus_summary (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;')
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_session_links (session_id TEXT NOT NULL, work_key TEXT NOT NULL, PRIMARY KEY(session_id,work_key)) STRICT;')
      const integrity = this.#db.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Corrupt initiative database')
      }
      this.#installAuthorizer()
      this.#validateWorkGraph(this.workRecords())
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  close(): void {
    if (this.#busy) throw new Error('Cannot close InitiativeStore during an operation')
    if (!this.#closed) { this.#db.close(); this.#closed = true }
  }

  workAuthority(subject: WorkSubject): WorkAuthority {
    subject = workSubjectSchema.parse(subject)
    const record = this.#transaction('', () => {
      const row = this.#one('work_contracts', workKey(subject))
      return row ? workRecordSchema.parse(JSON.parse(String(row.data))) : undefined
    }, undefined, true)
    if (record?.workflow) {
      const { manager, assignee, status } = record.workflow
      return { manager, executor: assignee, active: !['done', 'cancelled'].includes(status) }
    }
    if (subject.kind === 'work' || subject.kind === 'initiative') {
      return { manager: null, executor: null, active: false }
    }
    if (subject.kind === 'topic') {
      if (!this.#options.isSessionKnown?.(subject.sessionId)) return { manager: subject.sessionId, executor: null, active: false }
      return { manager: subject.sessionId, executor: subject.sessionId, active: true }
    }
    return { manager: null, executor: null, active: false }
  }

  workRecords(): WorkRecord[] {
    return this.#transaction('', () => this.#all('SELECT data FROM work_contracts ORDER BY id')
      .map(row => workRecordSchema.parse(JSON.parse(String(row.data)))), undefined, true)
  }

  projectFocus(): ProjectFocusSnapshot | undefined {
    return this.#transaction('', () => {
      const row = this.#one('project_focus_summary', 'current')
      return row ? projectFocusSnapshotSchema.parse(JSON.parse(String(row.data))) : undefined
    }, undefined, true)
  }

  saveProjectFocus(value: ProjectFocusSnapshot, impactedKeys?: readonly string[], expectedRevision?: number, validatedSources?: readonly {key:string;sequence:number}[]): void {
    const snapshot = projectFocusSnapshotSchema.parse(value)
    this.#transaction('work-organizer', () => {
      if (expectedRevision !== undefined) {
        const current = this.#one('project_focus_summary', 'current')
        const revision = current ? (JSON.parse(String(current.data)).revision ?? 0) : 0
        if (revision !== expectedRevision) throw new WorkConflict('Presentation revision changed.')
      }
      for (const source of validatedSources ?? snapshot.sources.filter(source => !impactedKeys || impactedKeys.includes(source.key))) {
        const row = source.key.startsWith('session:') ? undefined : this.#one('work_contracts', source.key)
        if (source.key.startsWith('session:') && this.#all('SELECT work_key FROM work_session_links WHERE session_id=?', [source.key.slice(8)]).length) throw new WorkConflict('Conversation was associated with Work during organization.')
        const sequence = source.key.startsWith('session:') ? this.#options.sessionTopicSequence?.(source.key.slice(8)) : Number(row?.sequence)
        if (sequence !== source.sequence) throw new WorkConflict('Topics changed during organization; retry with current notes.')
      }
      this.#write('INSERT INTO project_focus_summary (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        ['current', JSON.stringify(snapshot)])
    })
  }

  /** Legacy evidence is read only to preserve historical organizer root selection. */
  workObservations(): WorkObservation[] {
    return this.#transaction('', () => this.#all('SELECT data FROM work_observations ORDER BY id')
      .map(row => workObservationSchema.parse(JSON.parse(String(row.data)))), undefined, true)
  }

  /** The eligibility check and sequence CAS are in the same SQLite write transaction. */
  claimAutomaticWork(record: WorkRecord, expectedSequence: number): void {
    if (!record.automaticExecution || record.workflow?.assignee !== record.automaticExecution.sessionId) throw new WorkConflict('Invalid automatic assignee.')
    this.saveWork(record, expectedSequence, record.automaticExecution.sessionId, 'automatic_claim', undefined, true)
  }

  saveWork(record: WorkRecord, expectedSequence: number, actor: string, kind: string, eventDetails?: unknown, automaticClaim = false): void {
    const parsed = workRecordSchema.parse(record)
    if (parsed.key !== workKey(parsed.subject) || parsed.sequence !== expectedSequence + 1) throw new WorkConflict('Invalid work contract identity or sequence.')
    this.#transaction(actor, () => {
      const prior = this.#one('work_contracts', parsed.key)
      if ((Number(prior?.sequence) || 0) !== expectedSequence) throw new WorkConflict('Work contract changed; reload before applying.')
      // Creation identity is immutable, including through legacy record replacement paths.
      if (prior) {
        const original = workRecordSchema.parse(JSON.parse(String(prior.data))).creationRequest
        if (parsed.creationRequest && JSON.stringify(parsed.creationRequest) !== JSON.stringify(original)) throw new WorkConflict('Creation request identity is immutable.')
        parsed.creationRequest = original
      }
      if (!prior && this.#all('SELECT id FROM work_contracts').length >= MAX_TABLE_ROWS) throw new WorkConflict('Work contract limit exceeded.')
      const records = this.#all('SELECT data FROM work_contracts')
        .map(row => workRecordSchema.parse(JSON.parse(String(row.data)))).filter(item => item.key !== parsed.key)
      if (automaticClaim) {
        const previous = prior ? workRecordSchema.parse(JSON.parse(String(prior.data))) : undefined
        if (!previous || !automaticWorkEligible(previous, [...records, previous])) throw new WorkConflict('Work is no longer claimable.')
        if (parsed.workflow?.assignmentRevision !== previous.workflow!.assignmentRevision + 1) throw new WorkConflict('Invalid automatic assignment revision.')
        this.#assignmentTarget(parsed.workflow.assignee)
      }
      records.push(parsed)
      this.#validateWorkGraph(records)
      if (prior) this.#write('UPDATE work_contracts SET sequence=?, data=? WHERE id=?', [parsed.sequence, JSON.stringify(parsed), parsed.key])
      else this.#insert('work_contracts', { id: parsed.key, sequence: parsed.sequence, data: JSON.stringify(parsed) })
      for (const sessionId of new Set([parsed.workflow?.manager, parsed.workflow?.assignee].filter((id): id is string => !!id))) {
        this.#write('INSERT OR IGNORE INTO work_session_links (session_id,work_key) VALUES (?,?)', [sessionId, parsed.key])
      }
      const notebookEvent = parsed.notes && ['note', 'created', 'assignment', 'impact_review'].includes(kind)
      const previous = prior ? workRecordSchema.parse(JSON.parse(String(prior.data))) : undefined
      this.#workEvent(parsed.key, actor, kind, notebookEvent ? {
        key: parsed.key, sequence: parsed.sequence, revision: parsed.revision,
        ...(previous?.revision !== parsed.revision ? { definition: parsed.definition, origin: parsed.origin, requestSource: parsed.requestSource } : {}),
        workflow: parsed.workflow,
        ...(kind === 'impact_review' ? { assessment: parsed.notes?.attention?.reviewed } : {}),
        ...(eventDetails === undefined ? {} : { eventDetails }),
      } : eventDetails === undefined ? parsed : { ...parsed, eventDetails })
    })
  }


  #assignmentTarget(sessionId: unknown): void {
    if (sessionId === null) return
    if (typeof sessionId !== 'string' || !sessionId.trim() || Buffer.byteLength(sessionId) > 256 || /[\x00-\x1f]/.test(sessionId)) throw new Error('Invalid actor/session ID')
    if (this.#options.isSessionKnown && !this.#options.isSessionKnown(sessionId)) {
      throw new Error('Owner/assignee target session is not known in this Project')
    }
  }

  #validateWorkGraph(records: WorkRecord[]): void {
    const byKey = new Map(records.map(record => [record.key, record]))
    const children = new Map<string, string[]>()
    for (const record of records) {
      const parent = record.workflow?.parentKey
      if (parent) children.set(parent, [...(children.get(parent) ?? []), record.key])
    }
    for (const kind of ['parent', 'completion'] as const) {
      const complete = new Set<string>(), visiting = new Set<string>()
      const visit = (key: string) => {
        if (complete.has(key)) return
        if (visiting.has(key)) throw new WorkConflict(`Work ${kind} cycle is not allowed.`)
        const record = byKey.get(key)
        if (!record) throw new WorkConflict('Referenced work does not exist in this Project.')
        visiting.add(key)
        const links = kind === 'parent' ? record.workflow?.parentKey ? [record.workflow.parentKey] : []
          : [...(record.workflow?.dependencies ?? []), ...(children.get(key) ?? [])]
        for (const link of links) visit(link)
        visiting.delete(key); complete.add(key)
      }
      for (const record of records) visit(record.key)
    }
  }

  initiativeView(id: string) {
    const records = this.workRecords()
    const root = records.find(record => record.key === id)
    if (!root) throw new WorkConflict('Work root not found in this Project.')
    const keys = new Set([root.key])
    for (let size = -1; size !== keys.size;) {
      size = keys.size
      for (const record of records) if (record.workflow?.parentKey && keys.has(record.workflow.parentKey)) keys.add(record.key)
    }
    const items = records.filter(record => keys.has(record.key))
    return { root: root.key, items, progress: {
      total: items.length, done: items.filter(record => record.workflow?.status === 'done').length,
      cancelled: items.filter(record => record.workflow?.status === 'cancelled').length,
    } }
  }

  /** One explicit kickoff per assignment. A reserved but unconfirmed send is never replayed blindly. */
  assignmentDelivery(key: string, revision: number): { inputId: string; fingerprint: string; manager: string; assignee: string; status: 'unconfirmed' | 'accepted' } | undefined {
    return this.#transaction('', () => this.#assignmentDelivery(key, revision), undefined, true)
  }

  #assignmentDelivery(key: string, revision: number): { inputId: string; fingerprint: string; manager: string; assignee: string; status: 'unconfirmed' | 'accepted' } | undefined {
    const events = this.#all("SELECT data FROM work_contract_events WHERE work_key=? AND kind='assignment_delivery'", [key])
      .map(row => JSON.parse(String(row.data))).filter(row => row.assignmentRevision === revision)
    return events.find(row => row.status === 'accepted') ?? events[0]
  }

  reserveAssignmentDelivery(key: string, revision: number, manager: string, assignee: string, inputId: string, fingerprint: string) {
    return this.#transaction(manager, () => {
      const row = this.#one('work_contracts', key)
      const work = row && workRecordSchema.parse(JSON.parse(String(row.data))).workflow
      if (!work || work.manager !== manager || work.assignee !== assignee || work.assignmentRevision !== revision) throw new WorkConflict('Assignment delivery requires the current manager, assignee and assignmentRevision.')
      const prior = this.#assignmentDelivery(key, revision)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new WorkConflict('Assignment already has a different kickoff. Send subsequent context without a Work delivery reference.')
        return { ...prior, fresh: false }
      }
      const delivery = { inputId, fingerprint, status: 'unconfirmed' as const }
      this.#workEvent(key, manager, 'assignment_delivery', { ...delivery, assignmentRevision: revision, manager, assignee })
      return { ...delivery, fresh: true }
    })
  }

  confirmAssignmentDelivery(key: string, revision: number, manager: string, assignee: string, inputId: string): void {
    this.#transaction(manager, () => {
      const prior = this.#assignmentDelivery(key, revision)
      if (!prior || prior.inputId !== inputId || prior.manager !== manager || prior.assignee !== assignee) throw new WorkConflict('Unknown assignment delivery receipt.')
      if (prior.status === 'accepted') return
      // Receipt belongs to the reserved revision, even if responsibility changed in flight.
      this.#workEvent(key, manager, 'assignment_delivery', { ...prior, status: 'accepted', assignmentRevision: revision, manager, assignee })
    })
  }

  workEvent(key: string, actor: string, kind: string, data: unknown): void {
    this.#transaction(actor, () => this.#workEvent(key, actor, kind, data))
  }

  #workEvent(key: string, actor: string, kind: string, data: unknown): void {
    const serialized = JSON.stringify(data)
    if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new WorkConflict('Work event is too large.')
    this.#insert('work_contract_events', { id: randomUUID(), work_key: key, actor, kind,
      created_at: new Date().toISOString(), data: serialized })
  }

  workHistory(key: string): { kind: string; actor: string; at: string; data: unknown }[] {
    return this.#transaction('', () => this.#all(
      'SELECT kind, actor, created_at, data FROM work_contract_events WHERE work_key=? ORDER BY created_at DESC, id DESC LIMIT 100', [key],
    ).map(row => ({ kind: String(row.kind), actor: String(row.actor), at: String(row.created_at), data: JSON.parse(String(row.data)) })), undefined, true)
  }

  workEffects(): { id: string; sessionId: string; tool: string; status: string; stamps: import('./work-contract.ts').WorkStamp[] }[] {
    return this.#transaction('', () => this.#all('SELECT * FROM work_effects').map(row => ({
      id: String(row.id), sessionId: String(row.session_id), tool: String(row.tool),
      status: String(row.status), stamps: JSON.parse(String(row.stamps)),
    })), undefined, true)
  }

  startWorkEffect(id: string, sessionId: string, tool: string, stamps: import('./work-contract.ts').WorkStamp[]): void {
    this.#transaction(sessionId, () => this.#insert('work_effects', {
      id, session_id: sessionId, tool, status: 'running', stamps: JSON.stringify(stamps),
    }))
  }

  finishWorkEffect(id: string, failed: boolean): void {
    this.#transaction('', () => {
      if (failed) this.#write("UPDATE work_effects SET status='unknown' WHERE id=?", [id])
      else this.#write('DELETE FROM work_effects WHERE id=?', [id])
    })
  }

  recoverWorkEffects(): void {
    this.#transaction('', () => { this.#write("UPDATE work_effects SET status='unknown'", []) })
  }

  /** Historical association is separate from current execution focus and grants no authority. */
  workSessionKeys(sessionId: string, records: readonly WorkRecord[] = this.workRecords()): string[] {
    const explicit = this.#transaction('', () => this.#all('SELECT work_key FROM work_session_links WHERE session_id=?', [sessionId]).map(row => String(row.work_key)), undefined, true)
    return [...new Set([...explicit, ...records.filter(record => record.workflow?.assignee === sessionId || record.workflow?.manager === sessionId || record.observation?.sessionId === sessionId).map(record => record.key)])]
  }

  linkWorkSession(sessionId: string, key: string): void {
    this.#transaction(sessionId, () => {
      if (!this.#one('work_contracts', key)) throw new WorkConflict('Work not found.')
      this.#write('INSERT OR IGNORE INTO work_session_links (session_id,work_key) VALUES (?,?)', [sessionId, key])
    })
  }

  workFocus(sessionId: string): string | undefined {
    return this.#transaction('', () => {
      const value = this.#all('SELECT work_key FROM work_focus WHERE session_id=?', [sessionId])[0]?.work_key
      return typeof value === 'string' ? value : undefined
    }, undefined, true)
  }

  setWorkFocus(sessionId: string, key?: string): void {
    this.#transaction(sessionId, () => {
      this.#write('INSERT INTO work_focus (session_id,work_key) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET work_key=excluded.work_key', [sessionId, key ?? null])
      if (key) this.#workEvent(key, sessionId, 'selected', { key })
    })
  }

  /** Context only; never grants ownership or changes Work facts. */
  assertWorkReference(rootKey: string, itemKey?: string): void {
    const view = this.initiativeView(rootKey)
    if (itemKey && !view.items.some(item => item.key === itemKey)) throw new WorkConflict('Work item does not belong to this Work tree.')
  }

  getSummary(rootKey: string, _sessionId?: string): string | null {
    if (!this.workRecords().some(record => record.key === rootKey)) return null
    const view = this.initiativeView(rootKey)
    return JSON.stringify({ root: view.root, progress: view.progress, items: view.items.slice(0, 20).map(record => ({
      key: record.key, title: record.workflow?.title, parentKey: record.workflow?.parentKey,
      status: record.workflow?.status, manager: record.workflow?.manager, assignee: record.workflow?.assignee, revision: record.revision,
    })), ...(view.items.length > 20 ? { notice: 'Partial Work index. Page work tree for remaining items; read context with a key for exact definitions.' } : {}) })
  }

  getSessionSummary(_sessionId: string): null { return null }

  #installAuthorizer(): void {
    // Added in Node 24.10, before our 24.15 minimum; some @types/node releases
    // omit it. Keep both the engine allowlist and closed parser boundaries.
    const db = this.#db as DatabaseSync & { setAuthorizer?: (callback: (action: number, arg1: string | null, arg2: string | null, database: string | null) => number) => void }
    if (!db.setAuthorizer) throw new Error('InitiativeStore requires node:sqlite setAuthorizer (use Node 24.15+)')
    const codes = constants as unknown as Record<string, number>
    const workTables = ['work_contracts', 'work_contract_events', 'work_effects', 'work_focus', 'work_session_links', 'work_observations', 'project_focus_summary']
    const readable = new Set(workTables)
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (database && database !== 'main') return codes.SQLITE_DENY!
      if (action === codes.SQLITE_SELECT || action === codes.SQLITE_TRANSACTION) return codes.SQLITE_OK!
      if (action === codes.SQLITE_READ && arg1 && readable.has(arg1)) return codes.SQLITE_OK!
      if (action === codes.SQLITE_FUNCTION && ['count', 'sum', 'length', 'coalesce', 'trim'].includes(arg2 ?? '')) return codes.SQLITE_OK!
      if (this.#writeAccess && [codes.SQLITE_INSERT, codes.SQLITE_UPDATE, codes.SQLITE_DELETE].includes(action) && arg1 && workTables.includes(arg1)) return codes.SQLITE_OK!
      return codes.SQLITE_DENY!
    })
  }

  #transaction<T>(_actor: string, operation: () => T, signal?: AbortSignal, readOnly = false): T {
    if (this.#closed) throw new Error('InitiativeStore is closed')
    if (this.#busy) throw new Error('Reentrant InitiativeStore access is not supported')
    signal?.throwIfAborted()
    this.#busy = true
    try {
      this.#db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.#db.exec('COMMIT')
        return result
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    } finally {
      this.#busy = false
    }
  }

  #all(sql: string, values: (string | number | null)[] = []): InitiativeRow[] {
    return this.#db.prepare(sql).all(...values).map((row) => ({ ...row })) as InitiativeRow[]
  }

  #write(sql: string, values: (string | number | null)[]): number {
    this.#writeAccess = true
    try { return Number(this.#db.prepare(sql).run(...values).changes) }
    finally { this.#writeAccess = false }
  }

  #insert(table: string, row: InitiativeRow): void {
    const columns = Object.keys(row)
    this.#write(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row))
  }

  #one(table: string, id: string): InitiativeRow | undefined {
    return this.#all(`SELECT * FROM ${table} WHERE id=?`, [id])[0]
  }

}

/** Shared dependency/ancestor preflight; blocked assignees are never a re-entry pool. */
export function automaticWorkEligible(record: WorkRecord, records: readonly WorkRecord[]): boolean {
  const flow = record.workflow
  if (!flow || flow.assignee !== null || ['done', 'cancelled'].includes(flow.status) || record.paused || record.transition?.status === 'pending') return false
  const byKey = new Map(records.map(item => [item.key, item]))
  const seen = new Set<string>()
  let current: WorkRecord | undefined = record
  while (current) {
    if (seen.has(current.key) || current.paused || current.transition?.status === 'pending'
      || current.workflow && ['done', 'cancelled'].includes(current.workflow.status)
      || !workDependenciesSatisfied(current, records)) return false
    seen.add(current.key)
    const parent: string | undefined = current.workflow?.parentKey
    if (parent && !byKey.has(parent)) return false
    current = parent ? byKey.get(parent) : undefined
  }
  return true
}

/** The same dependency outcome rule is used for automatic admission and Work completion. */
export function workDependenciesSatisfied(record: WorkRecord, records: readonly WorkRecord[]): boolean {
  const byKey = new Map(records.map(item => [item.key, item]))
  return !record.workflow?.dependencies.some(key => byKey.get(key)?.workflow?.status !== 'done')
}
