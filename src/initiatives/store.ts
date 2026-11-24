import { workKickoffSchema, type WorkKickoff, type WorkKickoffReceipt } from './work-kickoff.ts'
import { workKeySchema } from './work-key.ts'
import { workNotifications, currentWorkNotification, isWorkNoteNotification, type WorkNotification, type WorkNoteNotification } from './work-notifications.ts'
import { WORK_NOTE_SCHEMA, workNoteIdSchema, workNoteInputSchema, workNoteSchema, type WorkNote, type WorkNoteReceipt } from './work-note.ts'
import { projectFocusSnapshotSchema, type ProjectFocusSnapshot } from '../projects/focus-contract.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { WORK_SCHEMA, WORK_COMPLETION_SCHEMA, WORK_CREATION_SCHEMA, workCreationRequestSchema, type WorkCreationRequest, workCompletionReadSchema, type WorkCompletion, WorkConflict, workRecordSchema, parseStoredWorkRecord, omitRetiredStoredWorkFields, parseStoredWorkStamps, workStampsSchema, workObservationSchema,
  type WorkAuthority, type WorkRecord, type WorkObservation } from './work-contract.ts'

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
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_execution_bindings (session_id TEXT PRIMARY KEY, work_key TEXT NOT NULL) STRICT;')
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_notifications (id TEXT PRIMARY KEY, target TEXT NOT NULL, pending INTEGER NOT NULL, data TEXT NOT NULL) STRICT;')
      this.#db.exec(`CREATE TABLE IF NOT EXISTS work_kickoffs (id TEXT PRIMARY KEY, target TEXT NOT NULL, work_key TEXT NOT NULL,
        revision INTEGER NOT NULL, data TEXT NOT NULL, physical_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','recorded','invalid')),
        UNIQUE(work_key, revision)) STRICT; CREATE INDEX IF NOT EXISTS work_kickoffs_target ON work_kickoffs(state,target);`)
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        if (!this.#db.prepare('PRAGMA table_info(work_kickoffs)').all().some(column => column.name === 'inspect_reason')) {
          this.#db.exec('ALTER TABLE work_kickoffs ADD COLUMN inspect_reason TEXT')
        }
        this.#db.exec('COMMIT')
      } catch (error) { this.#db.exec('ROLLBACK'); throw error }
      const integrity = this.#db.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Corrupt initiative database')
      }
      this.#initializeCompletions()
      this.#db.exec(WORK_CREATION_SCHEMA)
      this.#db.exec(WORK_NOTE_SCHEMA)
      // Do not replay old attention or return messages on upgrade. Leave history intact.
      this.#db.exec("UPDATE work_notifications SET pending=0 WHERE pending=1 AND json_extract(data, '$.kind') IN ('attention','return_to_assignee')")
      this.#installAuthorizer()
      this.#validateWorkGraph(this.workRecords())
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  /** Additive v6 migration, serialized with writers; no Work record/event is rewritten. */
  #initializeCompletions(): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.exec(WORK_COMPLETION_SCHEMA)
      const existing = new Set(this.#all('SELECT work_key FROM work_completions').map(row => row.work_key))
      for (const row of this.#all('SELECT data FROM work_contracts')) {
        const record = parseStoredWorkRecord(JSON.parse(String(row.data)))
        if (record.status !== 'done' || existing.has(record.key)) continue
        const events = this.#all('SELECT created_at, data FROM work_contract_events WHERE work_key=?', [record.key])
        const snapshots = events.flatMap(event => {
          const parsed = JSON.parse(String(event.data))
          return Number.isSafeInteger(parsed?.sequence) && parsed.sequence <= record.sequence && parsed?.status
            ? [{ sequence: parsed.sequence as number, status: parsed.status as string, at: String(event.created_at) }] : []
        }).sort((a, b) => a.sequence - b.sequence)
        // Only a recorded non-done -> done transition (or creation at sequence 1)
        // supplies a time. changedAt is a definition timestamp, not completion.
        let completedAt: string | null = null, previous: typeof snapshots[number] | undefined
        for (const snapshot of snapshots) {
          if (snapshot.status !== 'done' || previous && snapshot.sequence !== previous.sequence + 1) completedAt = null
          else if (previous?.status !== 'done' && (previous || snapshot.sequence === 1)) {
            completedAt = /^\d{4}-\d{2}-\d{2}T/.test(snapshot.at) && Number.isFinite(Date.parse(snapshot.at)) ? snapshot.at : null
          }
          previous = snapshot
        }
        if (previous?.status !== 'done' || previous.sequence !== record.sequence) completedAt = null
        this.#db.prepare('INSERT INTO work_completions (id,work_key,sequence,completed_at) VALUES (?,?,?,?)')
          .run(`legacy:${record.key}`, record.key, record.sequence, completedAt)
      }
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  #completionItems(principal: string): WorkCompletion[] {
    const latest = new Map<string, InitiativeRow>()
    for (const row of this.#all('SELECT * FROM work_completions ORDER BY sequence')) latest.set(String(row.work_key), row)
    const read = new Set(this.#all('SELECT completion_id FROM work_completion_reads WHERE principal=?', [principal]).map(row => row.completion_id))
    return this.#all('SELECT data FROM work_contracts').flatMap(row => {
      const record = parseStoredWorkRecord(JSON.parse(String(row.data))), completion = latest.get(record.key)
      return record.status === 'done' && completion ? [{ key: record.key, completionId: String(completion.id),
        sequence: Number(completion.sequence), completedAt: completion.completed_at === null ? null : String(completion.completed_at), unread: !read.has(completion.id) }] : []
    })
  }

  workCompletions(principal: string): WorkCompletion[] {
    assertReadPrincipal(principal)
    return this.#transaction(principal, () => this.#completionItems(principal), undefined, true)
  }

  /** Stale/unknown references are ignored atomically; they cannot consume a new occurrence. */
  markWorkCompletionsRead(principal: string, input: unknown): WorkCompletion[] {
    assertReadPrincipal(principal)
    const { items } = workCompletionReadSchema.parse(input)
    return this.#transaction(principal, () => {
      const current = new Map(this.#completionItems(principal).map(item => [item.key, item.completionId]))
      const now = new Date().toISOString()
      for (const item of items) if (current.get(item.key) === item.completionId) {
        this.#write('INSERT OR IGNORE INTO work_completion_reads (principal,completion_id,read_at) VALUES (?,?,?)', [principal, item.completionId, now])
      }
      return this.#completionItems(principal)
    })
  }

  close(): void {
    if (this.#busy) throw new Error('Cannot close InitiativeStore during an operation')
    if (!this.#closed) { this.#db.close(); this.#closed = true }
  }

  workAuthority(key: string): WorkAuthority {
    workKeySchema.parse(key)
    const record = this.#transaction('', () => {
      const row = this.#one('work_contracts', key)
      return row ? parseStoredWorkRecord(JSON.parse(String(row.data))) : undefined
    }, undefined, true)
    if (record) {
      const { manager, assignee, status } = record
      return { manager, executor: assignee, active: !['done', 'cancelled'].includes(status) }
    }
    return { manager: null, executor: null, active: false }
  }

  workRecords(): WorkRecord[] {
    return this.#transaction('', () => this.#all('SELECT data FROM work_contracts ORDER BY id')
      .map(row => parseStoredWorkRecord(JSON.parse(String(row.data)))), undefined, true)
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

  /** The exact inbox input, eligibility check, and Work CAS commit together. */
  claimAutomaticWork(record: WorkRecord, expectedSequence: number, draft: WorkKickoff): boolean {
    const parsed = workRecordSchema.parse(record), kickoff = workKickoffSchema.parse(draft)
    const execution = parsed.automaticExecution
    if (!execution || execution.stage !== 'claimed' || parsed.assignee !== kickoff.target || execution.sessionId !== kickoff.target
      || parsed.key !== kickoff.key || parsed.assignmentRevision !== kickoff.revision || execution.assignmentRevision !== kickoff.revision
      || execution.inputId !== kickoff.input.id || parsed.sequence !== expectedSequence + 1) throw new WorkConflict('Invalid automatic assignee or kickoff.')
    const encoded = JSON.stringify(kickoff)
    return this.#transaction(kickoff.target, () => {
      const existing = this.#all('SELECT data,state FROM work_kickoffs WHERE work_key=? AND revision=?', [kickoff.key, kickoff.revision])[0]
      if (existing) {
        if (existing.state !== 'invalid' && existing.data === encoded) return false
        throw new WorkConflict('Work assignment changed or kickoff payload conflicts.')
      }
      this.#saveWork(parsed, expectedSequence, kickoff.target, 'automatic_claim', undefined, true)
      this.#write("INSERT INTO work_kickoffs (id,target,work_key,revision,data,state) VALUES (?,?,?,?,?,'pending')",
        [kickoff.input.id, kickoff.target, kickoff.key, kickoff.revision, encoded])
      return true
    })
  }

  #kickoff(row: InitiativeRow): WorkKickoffReceipt {
    return { ...workKickoffSchema.parse(JSON.parse(String(row.data))),
      state: row.state === 'pending' && typeof row.inspect_reason === 'string' ? 'inspect' : row.state as WorkKickoffReceipt['state'],
      inspectReason: typeof row.inspect_reason === 'string' ? row.inspect_reason : undefined, physicalId: typeof row.physical_id === 'string' ? row.physical_id : undefined }
  }

  workKickoff(id: string): WorkKickoffReceipt | undefined {
    return this.#transaction('', () => {
      const row = this.#all('SELECT data,physical_id,state,inspect_reason FROM work_kickoffs WHERE id=?', [id])[0]
      return row && this.#kickoff(row)
    }, undefined, true)
  }

  pendingWorkKickoffs(): WorkKickoffReceipt[] {
    return this.#transaction('', () => this.#all("SELECT data,physical_id,state,inspect_reason FROM work_kickoffs WHERE state='pending' AND inspect_reason IS NULL ORDER BY rowid")
      .map(row => this.#kickoff(row)), undefined, true)
  }

  /** A stamped segment can be replaced only after the drain verifies absence there. */
  stampWorkKickoff(id: string, physicalId: string, previousPhysicalId?: string): void {
    this.#transaction('', () => {
      if (!this.#all("SELECT id FROM work_kickoffs WHERE id=? AND state='pending' AND inspect_reason IS NULL AND physical_id IS ?", [id, previousPhysicalId ?? null]).length) {
        throw new WorkConflict('Kickoff is no longer pending at the checked segment.')
      }
      this.#write('UPDATE work_kickoffs SET physical_id=? WHERE id=?', [physicalId, id])
    })
  }

  recordWorkKickoff(id: string, physicalId: string): void {
    this.#transaction('', () => {
      this.#write("UPDATE work_kickoffs SET state='recorded',physical_id=? WHERE id=? AND state='pending' AND inspect_reason IS NULL", [physicalId, id])
    })
  }

  /** Quarantine is durable and never edits the accepted input envelope. */
  inspectWorkKickoff(id: string, reason: string): void {
    this.#transaction('', () => {
      this.#write("UPDATE work_kickoffs SET inspect_reason=? WHERE id=? AND state='pending' AND inspect_reason IS NULL", [reason.slice(0, 900), id])
    })
  }

  /** Lifecycle projection only: the inbox was already recorded before this boundary. */
  beginWorkKickoff(kickoff: WorkKickoff): void {
    this.#transaction(kickoff.target, () => {
      const row = this.#one('work_contracts', kickoff.key)
      const work = row && parseStoredWorkRecord(JSON.parse(String(row.data)))
      const execution = work?.automaticExecution
      if (!work || !execution || work.assignee !== kickoff.target || work.assignmentRevision !== kickoff.revision
        || execution.inputId !== kickoff.input.id || ['done', 'cancelled'].includes(work.status)
        || !this.#all("SELECT id FROM work_kickoffs WHERE id=? AND state='recorded'", [kickoff.input.id]).length) {
        throw new WorkConflict('Kickoff is no longer the current recorded assignment.')
      }
      if (execution.stage === 'running') return
      const records = this.#all('SELECT data FROM work_contracts').map(row => parseStoredWorkRecord(JSON.parse(String(row.data))))
      if (execution.stage !== 'claimed' || !automaticWorkEligible({ ...work, assignee: null }, records)) {
        throw new WorkConflict('Kickoff no longer has a first inference grant.')
      }
      this.#saveWork({ ...work, sequence: work.sequence + 1, changedAt: new Date().toISOString(),
        automaticExecution: { ...execution, stage: 'running' } }, work.sequence, kickoff.target, 'automatic_started')
    })
  }

  #creationReplay(request: WorkCreationRequest): WorkRecord | undefined {
    const receipt = this.#all('SELECT work_key,fingerprint FROM work_creation_receipts WHERE creator=? AND idempotency_key=?',
      [request.creator, request.idempotencyKey])[0]
    if (!receipt) return undefined
    if (receipt.fingerprint !== request.fingerprint) throw new WorkConflict('Creation idempotency key conflicts with a different request.')
    const row = this.#one('work_contracts', workKeySchema.parse(receipt.work_key))
    if (!row) throw new WorkConflict('Creation receipt has no Work record.')
    return parseStoredWorkRecord(JSON.parse(String(row.data)))
  }

  replayWorkCreation(request: WorkCreationRequest): WorkRecord | undefined {
    const parsed = workCreationRequestSchema.parse(request)
    return this.#transaction('', () => this.#creationReplay(parsed), undefined, true)
  }

  createWork(record: WorkRecord, actor: string, request?: WorkCreationRequest): { record: WorkRecord; created: boolean } {
    const parsed = workRecordSchema.parse(record)
    if (parsed.sequence !== 1) throw new WorkConflict('Invalid initial Work sequence.')
    const creation = request === undefined ? undefined : workCreationRequestSchema.parse(request)
    return this.#transaction(actor, () => {
      const existing = creation && this.#creationReplay(creation)
      if (existing) return { record: existing, created: false }
      this.#saveWork(parsed, 0, actor, 'created')
      if (creation) this.#write('INSERT INTO work_creation_receipts (creator,idempotency_key,work_key,fingerprint) VALUES (?,?,?,?)',
        [creation.creator, creation.idempotencyKey, parsed.key, creation.fingerprint])
      return { record: parsed, created: true }
    })
  }

  saveWork(record: WorkRecord, expectedSequence: number, actor: string, kind: string, eventDetails?: unknown): void {
    const parsed = workRecordSchema.parse(record)
    if (parsed.sequence !== expectedSequence + 1) throw new WorkConflict('Invalid work contract identity or sequence.')
    this.#transaction(actor, () => this.#saveWork(parsed, expectedSequence, actor, kind, eventDetails))
  }

  #saveWork(parsed: WorkRecord, expectedSequence: number, actor: string, kind: string, eventDetails?: unknown, automaticClaim = false): void {
    const prior = this.#one('work_contracts', parsed.key)
    if ((Number(prior?.sequence) || 0) !== expectedSequence) throw new WorkConflict('Work contract changed; reload before applying.')
    if (!prior && this.#all('SELECT id FROM work_contracts').length >= MAX_TABLE_ROWS) throw new WorkConflict('Work contract limit exceeded.')
    const records = this.#all('SELECT data FROM work_contracts')
      .map(row => parseStoredWorkRecord(JSON.parse(String(row.data)))).filter(item => item.key !== parsed.key)
    if (automaticClaim) {
      const previous = prior ? parseStoredWorkRecord(JSON.parse(String(prior.data))) : undefined
      if (!previous || !automaticWorkEligible(previous, [...records, previous])) throw new WorkConflict('Work is no longer claimable.')
      if (parsed.assignmentRevision !== previous.assignmentRevision + 1) throw new WorkConflict('Invalid automatic assignment revision.')
      this.#assignmentTarget(parsed.assignee)
    }
    // Serialize all admission paths (including automatic claims) under BEGIN IMMEDIATE.
    // Legacy duplicate assignments remain readable/editable, but cannot grow.
    const previousAssignment = prior ? parseStoredWorkRecord(JSON.parse(String(prior.data))) : undefined
    const activeAssignee = (item: WorkRecord | undefined) => item && !['done', 'cancelled'].includes(item.status) ? item.assignee : null
    // Completion cannot hide a running or uncertain external operation. Check in
    // the same write transaction as the note CAS, including legacy callers.
    if (parsed.status === 'done' && previousAssignment?.status !== 'done') {
      const unresolved = this.#all('SELECT stamps FROM work_effects').some(row =>
        parseStoredWorkStamps(JSON.parse(String(row.stamps))).some(stamp => stamp.key === parsed.key))
      if (unresolved) throw new WorkConflict('Work has unresolved external effects; reconcile the operation before completion.')
    }
    const target = activeAssignee(parsed)
    if (target && activeAssignee(previousAssignment) !== target) {
      const conflicts = records.filter(item => activeAssignee(item) === target)
      if (conflicts.length) throw new WorkConflict(`Session ${target} already has unfinished Work: ${conflicts.map(item => item.key).join(', ')}. Complete or release it before assigning another Work.`)
    }
    records.push(parsed)
    this.#validateWorkGraph(records)
    if (prior) this.#write('UPDATE work_contracts SET sequence=?, data=? WHERE id=?', [parsed.sequence, JSON.stringify(parsed), parsed.key])
    else this.#insert('work_contracts', { id: parsed.key, sequence: parsed.sequence, data: JSON.stringify(parsed) })
    for (const sessionId of new Set([parsed.manager, parsed.assignee].filter((id): id is string => !!id))) {
      this.#write('INSERT OR IGNORE INTO work_session_links (session_id,work_key) VALUES (?,?)', [sessionId, parsed.key])
    }
    this.#write("UPDATE work_kickoffs SET state='invalid' WHERE work_key=? AND state<>'invalid' AND (revision<>? OR target IS NOT ? OR id IS NOT ? OR ? IN ('done','cancelled'))",
      [parsed.key, parsed.assignmentRevision, parsed.assignee, parsed.automaticExecution?.inputId ?? null, parsed.status])
    const notebookEvent = ['note', 'created', 'assignment', 'context_review'].includes(kind)
    const previous = prior ? parseStoredWorkRecord(JSON.parse(String(prior.data))) : undefined
    if (parsed.status === 'done' && previous?.status !== 'done') {
      this.#write('INSERT INTO work_completions (id,work_key,sequence,completed_at) VALUES (?,?,?,?)',
        [randomUUID(), parsed.key, parsed.sequence, new Date().toISOString()])
    }
    // Persist routing facts atomically with the mutation, before runtime admission.
    // Expire old episodes even if a status is reopened and completed again before consumption.
    for (const row of this.#all('SELECT id,data FROM work_notifications WHERE pending=1')) {
      const notice = JSON.parse(String(row.data)) as WorkNotification
      if (!currentWorkNotification(notice, records)
        || notice.key === parsed.key && notice.kind === 'done' && previous?.status !== parsed.status) {
        this.#write('UPDATE work_notifications SET pending=0 WHERE id=?', [String(row.id)])
      }
    }
    for (const notice of workNotifications(parsed, previous, records, kind)) {
      this.#write('INSERT OR IGNORE INTO work_notifications (id,target,pending,data) VALUES (?,?,1,?)', [notice.id, notice.target, JSON.stringify(notice)])
    }
    this.#workEvent(parsed.key, actor, kind, notebookEvent ? {
      key: parsed.key, title: parsed.title, sequence: parsed.sequence, revision: parsed.revision,
      ...(previous?.revision !== parsed.revision ? { definition: parsed.definition, origin: parsed.origin } : {}),
      status: parsed.status, parentKey: parsed.parentKey, dependencies: parsed.dependencies,
      manager: parsed.manager, assignee: parsed.assignee, assignmentRevision: parsed.assignmentRevision,
      assignmentStarted: parsed.assignmentStarted, blockedReason: parsed.blockedReason,
      ...(kind === 'context_review' ? { assessment: parsed.contextAssessment } : {}),
      ...(eventDetails === undefined ? {} : { eventDetails }),
    } : eventDetails === undefined ? parsed : { ...parsed, eventDetails })
  }


  createWorkNote(author: string, raw: unknown, isDurableSession: (id: string) => boolean, signal?: AbortSignal): WorkNoteReceipt {
    const input = workNoteInputSchema.parse(raw)
    return this.#transaction(author, () => {
      if (!isDurableSession(author)) throw new WorkConflict('A current durable Project session is required to post a Work comment.')
      const record = this.#requireWorkForNote(input.workKey)
      let target: string | null = null
      if (input.replyTo) {
        if (record.manager !== author) throw new WorkConflict('Only the current Work manager may reply.')
        const parent = this.#readWorkNote(record.key, input.replyTo)
        if (!parent || parent.replyTo) throw new WorkConflict('Reply to an original comment on this Work.')
        target = parent.author
      } else {
        if (record.assignee !== author) throw new WorkConflict('Only the current Work assignee may post an original comment.')
        if (input.notifyManager) target = record.manager
      }
      const note = workNoteSchema.parse({ id: randomUUID(), workKey: record.key, author,
        createdAt: new Date().toISOString(), body: input.body, ...(input.replyTo ? { replyTo: input.replyTo } : {}) })
      this.#insert('work_notes', { id: note.id, work_key: note.workKey, author, created_at: note.createdAt,
        body: note.body, reply_to: note.replyTo ?? null })
      if (!target || target === author || !isDurableSession(target)) return { note, notification: 'not_queued' }
      const notice: WorkNoteNotification = { id: `note:${note.id}`, key: record.key, target, noteId: note.id,
        kind: note.replyTo ? 'note_reply' : 'note_to_manager' }
      this.#insert('work_notifications', { id: notice.id, target, pending: 1, data: JSON.stringify(notice) })
      return { note, notification: 'queued' }
    }, signal)
  }

  #requireWorkForNote(key: string): WorkRecord {
    const row = this.#one('work_contracts', key)
    if (!row) throw new WorkConflict('Work contract not found.')
    return parseStoredWorkRecord(JSON.parse(String(row.data)))
  }

  #parseWorkNote(row: InitiativeRow): WorkNote {
    return workNoteSchema.parse({ id: row.id, workKey: row.work_key, author: row.author,
      createdAt: row.created_at, body: row.body, ...(row.reply_to ? { replyTo: row.reply_to } : {}) })
  }

  #readWorkNote(key: string, id: string): WorkNote | undefined {
    const row = this.#all('SELECT * FROM work_notes WHERE work_key=? AND id=?', [key, id])[0]
    return row && this.#parseWorkNote(row)
  }

  workNote(key: string, id: string): WorkNote {
    workKeySchema.parse(key)
    workNoteIdSchema.parse(id)
    return this.#transaction('', () => {
      const note = this.#readWorkNote(key, id)
      if (!note) throw new WorkConflict('Work comment not found.')
      return note
    }, undefined, true)
  }

  workNotes(key: string, before?: string): { items: WorkNote[]; next: string | null } {
    workKeySchema.parse(key)
    if (before !== undefined) workNoteIdSchema.parse(before)
    return this.#transaction('', () => {
      this.#requireWorkForNote(key)
      const anchor = before === undefined ? undefined : this.#all('SELECT append_order FROM work_notes WHERE work_key=? AND id=?', [key, before])[0]
      if (before !== undefined && !anchor) throw new WorkConflict('Work comment cursor not found.')
      const limit = 10
      const rows = anchor
        ? this.#all('SELECT * FROM work_notes WHERE work_key=? AND append_order<? ORDER BY append_order DESC LIMIT ?', [key, anchor.append_order!, limit + 1])
        : this.#all('SELECT * FROM work_notes WHERE work_key=? ORDER BY append_order DESC LIMIT ?', [key, limit + 1])
      const items = rows.slice(0, limit).map(row => this.#parseWorkNote(row))
      return { items, next: rows.length > limit ? items.at(-1)!.id : null }
    }, undefined, true)
  }

  /** Revalidate after history scanning, and stamp the current physical log immediately before append. */
  prepareWorkNotificationDelivery(target: string, ids: string[], recorded: ReadonlySet<string>, physicalId?: string) {
    return this.#transaction('', () => {
      const records = this.#all('SELECT data FROM work_contracts').map(row => parseStoredWorkRecord(JSON.parse(String(row.data))))
      const notices: WorkNotification[] = []
      for (const id of ids) {
        const row = this.#all('SELECT data FROM work_notifications WHERE id=? AND target=? AND pending=1', [id, target])[0]
        if (!row) continue
        const notice = JSON.parse(String(row.data)) as WorkNotification
        if (notice.id !== id || notice.target !== target || recorded.has(id)
          || !currentWorkNotification(notice, records) || !this.#validNoteNotice(notice)) {
          this.#write('UPDATE work_notifications SET pending=0 WHERE id=?', [id])
          continue
        }
        if (physicalId && !notice.deliveryPhysicalIds?.includes(physicalId)) {
          notice.deliveryPhysicalIds = [...(notice.deliveryPhysicalIds ?? []), physicalId]
          this.#write('UPDATE work_notifications SET data=? WHERE id=?', [JSON.stringify(notice), id])
        }
        notices.push(notice)
      }
      return { notices, records }
    })
  }

  #validNoteNotice(notice: WorkNotification): boolean {
    if (!isWorkNoteNotification(notice)) return true
    const note = this.#readWorkNote(notice.key, notice.noteId)
    if (!note || notice.id !== `note:${note.id}` || note.author === notice.target) return false
    if (notice.kind === 'note_to_manager') return !note.replyTo
    const original = note.replyTo ? this.#readWorkNote(notice.key, note.replyTo) : undefined
    return !!original && !original.replyTo && original.author === notice.target
  }

  /** Read-only pending delivery projection; no ack/read creates another Work event. */
  pendingWorkNotifications(target?: string): WorkNotification[] {
    return this.#transaction('', () => this.#all(target === undefined
      ? 'SELECT data FROM work_notifications WHERE pending=1 ORDER BY rowid'
      : 'SELECT data FROM work_notifications WHERE pending=1 AND target=? ORDER BY rowid', target === undefined ? [] : [target])
      .map(row => JSON.parse(String(row.data)) as WorkNotification), undefined, true)
  }

  settleWorkNotifications(ids: string[]): void {
    this.#transaction('', () => {
      for (const id of ids) this.#write('UPDATE work_notifications SET pending=0 WHERE id=?', [id])
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
      const parent = record.parentKey
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
        const links = kind === 'parent' ? record.parentKey ? [record.parentKey] : []
          : [...(record.dependencies ?? []), ...(children.get(key) ?? [])]
        for (const link of links) visit(link)
        visiting.delete(key); complete.add(key)
      }
      for (const record of records) visit(record.key)
    }
  }

  initiativeView(id: string) {
    workKeySchema.parse(id)
    const records = this.workRecords()
    const root = records.find(record => record.key === id)
    if (!root) throw new WorkConflict('Work root not found in this Project.')
    const keys = new Set([root.key])
    for (let size = -1; size !== keys.size;) {
      size = keys.size
      for (const record of records) if (record.parentKey && keys.has(record.parentKey)) keys.add(record.key)
    }
    const items = records.filter(record => keys.has(record.key))
    return { root: root.key, items, progress: {
      total: items.length, done: items.filter(record => record.status === 'done').length,
      cancelled: items.filter(record => record.status === 'cancelled').length,
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
      const work = row && parseStoredWorkRecord(JSON.parse(String(row.data)))
      if (!work || work.manager !== manager || work.assignee !== assignee || work.assignmentRevision !== revision) throw new WorkConflict('Assignment delivery requires the current manager, assignee and assignmentRevision.')
      if (this.#all('SELECT id FROM work_kickoffs WHERE work_key=? AND revision=?', [key, revision]).length) {
        throw new WorkConflict('Automatic kickoff already accepted. Send subsequent context without a Work delivery reference.')
      }
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
    ).map(row => ({ kind: String(row.kind), actor: String(row.actor), at: String(row.created_at), data: omitRetiredStoredWorkFields(JSON.parse(String(row.data))) })), undefined, true)
  }

  workEffects(): { id: string; sessionId: string; tool: string; status: string; stamps: import('./work-contract.ts').WorkStamp[] }[] {
    return this.#transaction('', () => this.#all('SELECT * FROM work_effects').map(row => ({
      id: String(row.id), sessionId: String(row.session_id), tool: String(row.tool),
      status: String(row.status), stamps: parseStoredWorkStamps(JSON.parse(String(row.stamps))),
    })), undefined, true)
  }

  startWorkEffect(id: string, sessionId: string, tool: string, stamps: import('./work-contract.ts').WorkStamp[]): void {
    this.#transaction(sessionId, () => this.#insert('work_effects', {
      id, session_id: sessionId, tool, status: 'running', stamps: JSON.stringify(workStampsSchema.parse(stamps)),
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
    return [...new Set([...explicit, ...records.filter(record => record.assignee === sessionId || record.manager === sessionId || record.observation?.sessionId === sessionId).map(record => record.key)])]
  }

  linkWorkSession(sessionId: string, key: string): void {
    workKeySchema.parse(key)
    this.#transaction(sessionId, () => {
      if (!this.#one('work_contracts', key)) throw new WorkConflict('Work not found.')
      this.#write('INSERT OR IGNORE INTO work_session_links (session_id,work_key) VALUES (?,?)', [sessionId, key])
    })
  }

  /** Current durable scope is derived, never selected. Ambiguous legacy assignments have no default. */
  workFocus(sessionId: string): string | undefined {
    const active = this.workRecords().filter(record => record.assignee === sessionId && !['done', 'cancelled'].includes(record.status))
    return active.length === 1 ? active[0].key : undefined
  }

  executionBinding(sessionId: string): string | undefined {
    return this.#transaction('', () => {
      // Called only for temporary execution lineage, never durable current scope.
      const value = this.#all('SELECT work_key FROM work_execution_bindings WHERE session_id=?', [sessionId])[0]?.work_key
        ?? this.#all('SELECT work_key FROM work_focus WHERE session_id=?', [sessionId])[0]?.work_key
      return value === undefined ? undefined : workKeySchema.parse(value)
    }, undefined, true)
  }

  bindExecution(sessionId: string, key: string): void {
    workKeySchema.parse(key)
    this.#transaction(sessionId, () => {
      if (!this.#one('work_contracts', key)) throw new WorkConflict('Work not found.')
      this.#write('INSERT INTO work_execution_bindings (session_id,work_key) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET work_key=excluded.work_key', [sessionId, key])
    })
  }

  /** Context only; never grants ownership or changes Work facts. */
  assertWorkReference(rootKey: string, itemKey?: string): void {
    const view = this.initiativeView(rootKey)
    if (itemKey !== undefined) workKeySchema.parse(itemKey)
    if (itemKey && !view.items.some(item => item.key === itemKey)) throw new WorkConflict('Work item does not belong to this Work tree.')
  }

  getSummary(rootKey: string, _sessionId?: string): string | null {
    if (!this.workRecords().some(record => record.key === rootKey)) return null
    const view = this.initiativeView(rootKey)
    return JSON.stringify({ root: view.root, progress: view.progress, items: view.items.slice(0, 20).map(record => ({
      key: record.key, title: record.title, parentKey: record.parentKey,
      status: record.status, manager: record.manager, assignee: record.assignee, revision: record.revision,
    })), ...(view.items.length > 20 ? { notice: 'Partial Work index. Read v:works/index and follow next for remaining items; use its encoded key paths for exact definitions.' } : {}) })
  }

  getSessionSummary(_sessionId: string): null { return null }

  #installAuthorizer(): void {
    // Added in Node 24.10, before our 24.15 minimum; some @types/node releases
    // omit it. Keep both the engine allowlist and closed parser boundaries.
    const db = this.#db as DatabaseSync & { setAuthorizer?: (callback: (action: number, arg1: string | null, arg2: string | null, database: string | null) => number) => void }
    if (!db.setAuthorizer) throw new Error('InitiativeStore requires node:sqlite setAuthorizer (use Node 24.15+)')
    const codes = constants as unknown as Record<string, number>
    const workTables = ['work_notes', 'work_kickoffs', 'work_notifications', 'work_creation_receipts', 'work_completions', 'work_completion_reads', 'work_contracts', 'work_contract_events', 'work_effects', 'work_focus', 'work_execution_bindings', 'work_session_links', 'work_observations', 'project_focus_summary']
    const readable = new Set(workTables)
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (database && database !== 'main') return codes.SQLITE_DENY!
      if (action === codes.SQLITE_SELECT || action === codes.SQLITE_TRANSACTION) return codes.SQLITE_OK!
      if (action === codes.SQLITE_READ && arg1 && readable.has(arg1)) return codes.SQLITE_OK!
      if (action === codes.SQLITE_FUNCTION && ['count', 'sum', 'length', 'coalesce', 'trim'].includes(arg2 ?? '')) return codes.SQLITE_OK!
      if (this.#writeAccess && [codes.SQLITE_INSERT, codes.SQLITE_UPDATE, codes.SQLITE_DELETE].includes(action) && arg1 && workTables.includes(arg1)) {
        return arg1 === 'work_notes' && action !== codes.SQLITE_INSERT ? codes.SQLITE_DENY! : codes.SQLITE_OK!
      }
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
  if (record.assignee !== null || ['done', 'cancelled'].includes(record.status)) return false
  const byKey = new Map(records.map(item => [item.key, item]))
  const seen = new Set<string>()
  let current: WorkRecord | undefined = record
  while (current) {
    if (seen.has(current.key)
      || ['done', 'cancelled'].includes(current.status)
      || !workDependenciesSatisfied(current, records)) return false
    seen.add(current.key)
    const parent: string | undefined = current.parentKey
    if (parent && !byKey.has(parent)) return false
    current = parent ? byKey.get(parent) : undefined
  }
  return true
}

/** The same dependency outcome rule is used for automatic admission and Work completion. */
export function workDependenciesSatisfied(record: WorkRecord, records: readonly WorkRecord[]): boolean {
  const byKey = new Map(records.map(item => [item.key, item]))
  return !record.dependencies.some(key => byKey.get(key)?.status !== 'done')
}

function assertReadPrincipal(principal: string): void {
  if (typeof principal !== 'string' || !principal.trim() || principal.length > 512 || /[\x00-\x1f]/.test(principal)) throw new TypeError('Invalid completion read principal.')
}
