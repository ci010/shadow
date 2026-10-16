import { projectFocusSnapshotSchema, type ProjectFocusSnapshot } from '../projects/focus-contract.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { HANDOFF_VIEW, ITEM_ACTIVITY_VIEW, SCHEMA, TABLE_COLUMNS } from './schema.ts'
import { parseSql, type Statement, type Value } from './sql.ts'
import { WORK_SCHEMA, WorkConflict, workKey, workRecordSchema, workSubjectSchema, workObservationSchema,
  type WorkSubject, type WorkAuthority, type WorkRecord, type WorkObservation } from './work-contract.ts'

export type InitiativeRow = Record<string, string | number | null>
export interface InitiativeQueryResult {
  results: { rows: InitiativeRow[]; changes: number }[]
  changes: number
}
export interface InitiativeStoreOptions {
  sessionTopicSequence?: (sessionId: string) => number | undefined
  trackWork?: boolean
  /** Informative only, never releases work. True is live, false inactive, undefined unknown. */
  isSessionActive?: (sessionId: string) => boolean | undefined
  /** If supplied, new owner/assignee targets must belong to this Project runtime. */
  isSessionKnown?: (sessionId: string) => boolean
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const BASE_TABLES = ['initiatives', 'initiative_items', 'initiative_item_deps', 'initiative_entries']
const MAX_TABLE_ROWS = 5000
const MAX_RESULT_BYTES = 262_144
const MAX_TEXT_BYTES = 65_536
const MAX_DATABASE_TEXT_BYTES = 16_777_216
const WRITABLE: Record<string, string[]> = {
  initiatives: ['id', 'title', 'goal', 'context', 'status', 'owner_session_id'],
  initiative_items: ['id', 'initiative_id', 'title', 'status', 'assignee_session_id', 'blocked_reason'],
  initiative_item_deps: ['item_id', 'depends_on_item_id'],
  initiative_entries: ['initiative_id', 'item_id', 'kind', 'content'],
}

export class InitiativeStore {
  readonly home: string
  #db: DatabaseSync
  #actor = ''
  #closed = false
  #busy = false
  #writeAccess = false
  #unifiedWork = false
  #options: InitiativeStoreOptions

  constructor(home: string, options: InitiativeStoreOptions = {}) {
    this.home = resolve(home)
    this.#options = options
    const filename = projectStoragePath(this.home, 'initiatives.sqlite')
    mkdirSync(dirname(filename), { recursive: true })
    if (existsSync(filename)) {
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Initiative database must be a regular file, not a symbolic link')
      if (stat.size > 134_217_728) throw new Error('Initiative database file size limit exceeded')
    }
    this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false })
    try {
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;')
      const version = this.#db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (![0, 1, 2, 3, 4, 5, 6].includes(version.user_version)) throw new Error('Unsupported initiative database version')
      this.#unifiedWork = version.user_version === 6
      if (version.user_version === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (tables.length) throw new Error('Unrecognized initiative database schema')
        this.#db.exec(`BEGIN IMMEDIATE; ${SCHEMA} ${ITEM_ACTIVITY_VIEW} PRAGMA user_version=3; COMMIT;`)
      } else if (version.user_version < 3) {
        this.#db.exec(`BEGIN IMMEDIATE; DROP VIEW IF EXISTS initiative_item_activity;
          DROP VIEW IF EXISTS initiative_handoffs; ${HANDOFF_VIEW} ${ITEM_ACTIVITY_VIEW}
          PRAGMA user_version=3; COMMIT;`)
      }
      if (version.user_version < 5) {
        this.#db.exec(`BEGIN IMMEDIATE; ${WORK_SCHEMA} PRAGMA user_version=5; COMMIT;`)
      }
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_observations (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS project_focus_summary (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;')
      this.#db.exec('CREATE TABLE IF NOT EXISTS work_session_links (session_id TEXT NOT NULL, work_key TEXT NOT NULL, PRIMARY KEY(session_id,work_key)) STRICT; INSERT OR IGNORE INTO work_session_links SELECT session_id,work_key FROM work_focus WHERE work_key IS NOT NULL;')
      const integrity = this.#db.prepare('PRAGMA quick_check').all()
      if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok' || this.#db.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('Corrupt initiative database')
      }
      this.#db.function('actor_session_id', () => this.#actor)
      this.#db.function('session_is_inactive', (sessionId) => this.#inactive(String(sessionId)) ? 1 : 0)
      this.#db.function('session_activity', (sessionId) => this.#activity(sessionId === null ? null : String(sessionId)))
      this.#installAuthorizer()
      this.#validateDatabase()
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
    const itemSubject = subject
    return this.#transaction('', () => {
      const parent = this.#one('initiatives', itemSubject.initiativeId)
      const item = this.#one('initiative_items', itemSubject.itemId)
      if (!parent || !item || item.initiative_id !== parent.id) throw new WorkConflict('Work item is not available in this Initiative.')
      return { manager: parent.owner_session_id as string | null, executor: item.assignee_session_id as string | null,
        active: parent.status === 'active' && !['done', 'cancelled'].includes(String(item.status)) }
    }, undefined, true)
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

  saveWork(record: WorkRecord, expectedSequence: number, actor: string, kind: string, eventDetails?: unknown): void {
    const parsed = workRecordSchema.parse(record)
    if (parsed.key !== workKey(parsed.subject) || parsed.sequence !== expectedSequence + 1) throw new WorkConflict('Invalid work contract identity or sequence.')
    this.#transaction(actor, () => {
      const prior = this.#one('work_contracts', parsed.key)
      if ((Number(prior?.sequence) || 0) !== expectedSequence) throw new WorkConflict('Work contract changed; reload before applying.')
      if (!prior && this.#all('SELECT id FROM work_contracts').length >= MAX_TABLE_ROWS) throw new WorkConflict('Work contract limit exceeded.')
      const records = this.#all('SELECT data FROM work_contracts')
        .map(row => workRecordSchema.parse(JSON.parse(String(row.data)))).filter(item => item.key !== parsed.key)
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

  get unifiedWork(): boolean { return this.#unifiedWork }

  /** Keep old keys, journals and SQL tables as archives; all live work facts move together. */
  migrateWorkItems(): void {
    this.#transaction('work-migration', () => {
      const saved = this.#all('SELECT data FROM work_contracts').map(row => workRecordSchema.parse(JSON.parse(String(row.data))))
      const records = new Map(saved.map(record => [record.key, structuredClone(record)]))
      const now = new Date().toISOString()
      const missing = (subject: WorkSubject, objective: string): WorkRecord => ({
        key: workKey(subject), subject, revision: 1, sequence: 0,
        definition: { objective: objective.slice(0, 4000) || 'Review imported work',
          acceptance: ['Acceptance was not recorded. Establish observable criteria before executing this imported work.'],
          boundaries: [], evidence: [] },
        origin: 'agent_interpretation', changedBy: 'work-migration', changedAt: now,
        change: 'understanding', reason: 'Imported historical work; missing acceptance is unknown, not permission.', paused: true,
      })
      const parents = this.#all('SELECT * FROM initiatives')
      for (const row of parents) {
        const subject = { kind: 'initiative' as const, initiativeId: String(row.id) }
        const record = records.get(workKey(subject)) ?? missing(subject, String(row.goal || row.title))
        if (record.workflow) continue
        record.workflow = {
          title: String(row.title).slice(0, 160), manager: row.owner_session_id as string | null,
          assignee: row.owner_session_id as string | null, assignmentRevision: 1,
          status: row.status === 'completed' ? 'done' : row.status === 'cancelled' ? 'cancelled' : 'pending', dependencies: [],
        }
        records.set(record.key, record)
        this.#workEvent(record.key, 'work-migration', 'legacy_initiative', row)
      }
      for (const row of this.#all('SELECT * FROM initiative_items')) {
        const parent = parents.find(parent => parent.id === row.initiative_id)!
        const subject = { kind: 'item' as const, initiativeId: String(row.initiative_id), itemId: String(row.id) }
        const record = records.get(workKey(subject)) ?? missing(subject, String(row.title))
        if (record.workflow) continue
        record.workflow = {
          title: String(row.title).slice(0, 160), parentKey: `initiative:${row.initiative_id}`,
          manager: parent.owner_session_id as string | null, assignee: row.assignee_session_id as string | null,
          assignmentRevision: 1, status: row.status as NonNullable<WorkRecord['workflow']>['status'],
          ...(row.blocked_reason ? { blockedReason: String(row.blocked_reason).slice(0, 2000) } : {}),
          dependencies: this.#all('SELECT depends_on_item_id FROM initiative_item_deps WHERE item_id=?', [row.id!])
            .map(edge => `item:${edge.depends_on_item_id}`),
        }
        records.set(record.key, record)
        this.#workEvent(record.key, 'work-migration', 'legacy_item', row)
      }
      for (const record of records.values()) {
        if (!record.workflow && record.subject.kind === 'topic') record.workflow = {
          title: record.definition.objective.slice(0, 160), manager: record.subject.sessionId,
          assignee: record.subject.sessionId, assignmentRevision: 1, status: 'pending', dependencies: [],
        }
      }
      this.#validateWorkGraph([...records.values()])
      for (const record of records.values()) {
        if (saved.find(old => old.key === record.key)?.workflow) continue
        if (record.workflow) record.workflow.assignmentStarted = !!record.adoption
        const next = workRecordSchema.parse({ ...record, sequence: record.sequence + 1 })
        const existing = this.#one('work_contracts', record.key)
        if (existing) this.#write('UPDATE work_contracts SET sequence=?,data=? WHERE id=?', [next.sequence, JSON.stringify(next), next.key])
        else this.#insert('work_contracts', { id: next.key, sequence: next.sequence, data: JSON.stringify(next) })
        this.#workEvent(next.key, 'work-migration', 'work_unified', next)
      }
      this.#db.exec('PRAGMA user_version=6')
    })
    this.#unifiedWork = true
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
    const root = records.find(record => record.key === id || record.key === `initiative:${id}`)
    if (!root) throw new WorkConflict('Initiative work root not found in this Project.')
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

  query(sql: string, actorSessionId: string, signal?: AbortSignal): InitiativeQueryResult {
    this.#sessionId(actorSessionId)
    const statements = parseSql(sql)
    if (this.#unifiedWork && statements.some(statement => statement.operation !== 'SELECT')) {
      throw new WorkConflict('Initiative SQL is a historical archive. Use work for current definitions, assignments and progress.')
    }
    return this.#transaction(actorSessionId, () => {
      const result: InitiativeQueryResult = { results: [], changes: 0 }
      let rowCount = 0
      for (const statement of statements) {
        signal?.throwIfAborted()
        this.#checkStatement(statement)
        if (statement.operation === 'SELECT') {
          const rows = this.#select(statement)
          rowCount += rows.length
          result.results.push({ rows, changes: 0 })
        } else {
          const changes = this.#mutate(statement)
          result.changes += changes
          result.results.push({ rows: [], changes })
        }
        if (rowCount > 200 || result.changes > 200) throw new Error('Query row/change limit exceeded (200)')
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new Error('Query result byte limit exceeded')
      }
      this.#validateDatabase()
      signal?.throwIfAborted()
      return result
    }, signal)
  }

  /** Validates coordination metadata without granting ownership or changing work facts. */
  assertWorkReference(initiativeId: string, itemId?: string): void {
    if (this.#unifiedWork) {
      const view = this.initiativeView(initiativeId)
      if (itemId && !view.items.some(item => item.key === itemId || item.key === `item:${itemId}`)) {
        throw new WorkConflict('Work item does not belong to this Initiative view.')
      }
      return
    }
    this.#slug(initiativeId)
    if (itemId !== undefined) this.#slug(itemId)
    this.#transaction('', () => {
      if (!this.#one('initiatives', initiativeId)) throw new Error(`Unknown initiative in this Project: ${initiativeId}`)
      if (itemId === undefined) return
      const item = this.#one('initiative_items', itemId)
      if (!item) throw new Error(`Unknown initiative item in this Project: ${itemId}`)
      if (item.initiative_id !== initiativeId) throw new Error(`Initiative item "${itemId}" does not belong to initiative "${initiativeId}"`)
    }, undefined, true)
  }

  getSummary(initiativeId: string, sessionId?: string): string | null {
    if (this.#unifiedWork) {
      if (!this.workRecords().some(record => record.key === initiativeId || record.key === `initiative:${initiativeId}`)) return null
      const view = this.initiativeView(initiativeId)
      return JSON.stringify({ root: view.root, progress: view.progress, items: view.items.slice(0, 20).map(record => ({
        key: record.key, title: record.workflow?.title, parentKey: record.workflow?.parentKey,
        status: record.workflow?.status, manager: record.workflow?.manager, assignee: record.workflow?.assignee, revision: record.revision,
      })), ...(view.items.length > 20 ? { notice: 'Partial Initiative index. Page work tree for remaining items; read context with a key for exact definitions.' } : {}) })
    }
    this.#slug(initiativeId)
    if (sessionId !== undefined) this.#sessionId(sessionId)
    return this.#transaction(sessionId ?? '', () => this.#summary(initiativeId, sessionId))
  }

  getSessionSummary(actorSessionId: string): string | null {
    if (this.#unifiedWork) return null // Current work is injected per inference, without a second goal snapshot.
    this.#sessionId(actorSessionId)
    return this.#transaction(actorSessionId, () => {
      const initiatives = this.#all(`
        SELECT p.* FROM initiatives p
        WHERE p.status='active' AND (
          p.owner_session_id=? OR p.created_by_session_id=? OR EXISTS (
            SELECT 1 FROM initiative_items i WHERE i.initiative_id=p.id AND i.assignee_session_id=?
          )
        ) ORDER BY p.updated_at DESC, p.id ASC LIMIT 6
      `, [actorSessionId, actorSessionId, actorSessionId])
      if (!initiatives.length) return null
      const sections = initiatives.slice(0, 5).map((initiative) => {
        const assigned = this.#all(`
          SELECT * FROM initiative_item_activity WHERE initiative_id=? AND assignee_session_id=?
          AND status IN ('pending','in_progress','blocked') ORDER BY id LIMIT 11
        `, [initiative.id!, actorSessionId])
        const attentionItems = this.#all('SELECT * FROM initiative_item_activity WHERE initiative_id=? AND needs_attention=1 ORDER BY id LIMIT 11', [initiative.id!])
        const ownerActivity = this.#activity(initiative.owner_session_id as string | null)
        const needsAttention = initiative.owner_session_id === null || ownerActivity === 'inactive'
        return this.#truncate([
          `# Initiative: ${this.#truncate(String(initiative.title), 300)} (${initiative.id})`,
          `Status: active${needsAttention ? ' — needs_attention' : ''}; owner: ${initiative.owner_session_id ?? '(unowned)'}; activity: ${ownerActivity}`,
          'Recorded ownership and assignments persist regardless of activity; only explicit release/handoff changes them.',
          `Goal: ${this.#truncate(String(initiative.goal), 1000)}`,
          ...(attentionItems.length ? [
            '## Items needing attention (assignments retained)',
            ...attentionItems.slice(0, 10).map((item) => `- ${item.id}: [${item.status}] assignee ${item.assignee_session_id} — inactive; needs_attention (not claimable)`),
            ...(attentionItems.length > 10 ? ['[More inactive assignments omitted; query initiative_item_activity.]'] : []),
          ] : []),
          '## Your assigned work',
          ...assigned.slice(0, 10).map((item) => `- ${item.id}: [${item.status}] ${this.#truncate(String(item.title), 300)} (activity: ${item.assignee_activity}${item.needs_attention ? '; needs_attention; assignment retained' : ''})${item.blocked_reason ? ` — ${this.#truncate(String(item.blocked_reason), 300)}` : ''}`),
          ...(assigned.length === 0 ? ['(No open items assigned to you.)'] : []),
          ...(assigned.length > 10 ? ['[More assigned items omitted; query initiative_session_todos.]'] : []),
          '## Context',
          this.#truncate(String(initiative.context), 1000),
        ].join('\n'), 6000)
      })
      return this.#truncate([
        '# Your active initiatives',
        ...sections,
        ...(initiatives.length > 5 ? ['[More related initiatives omitted; query initiatives or initiative_session_todos.]'] : []),
      ].join('\n\n'), 32_768)
    })
  }

  #summary(initiativeId: string, sessionId?: string): string | null {
    const initiative = this.#one('initiatives', initiativeId)
    if (!initiative) return null
    const items = this.#all('SELECT * FROM initiative_item_activity WHERE initiative_id=? ORDER BY id LIMIT 101', [initiativeId])
    const entries = this.#all('SELECT * FROM initiative_entries WHERE initiative_id=? ORDER BY created_at DESC, id DESC LIMIT 11', [initiativeId])
    const ownerActivity = this.#activity(initiative.owner_session_id as string | null)
    const needsAttention = initiative.status === 'active' && (initiative.owner_session_id === null || ownerActivity === 'inactive')
    const lines = [
      `# Initiative: ${initiative.title} (${initiative.id})`,
      `Status: ${initiative.status}${needsAttention ? ' — needs_attention' : ''}`,
      `Owner session: ${initiative.owner_session_id ?? '(unowned)'}; activity: ${ownerActivity}`,
      'Recorded ownership and assignments persist regardless of activity; only explicit release/handoff changes them.',
      `Goal: ${initiative.goal}`, '', '## Context', String(initiative.context), '', '## Work items',
      ...items.slice(0, 100).map((item) => `- ${item.id}: [${item.status}] ${item.title} (assignee: ${item.assignee_session_id ?? 'none'}; activity: ${item.assignee_activity}${item.needs_attention ? '; needs_attention; assignment retained' : ''}${item.assignee_session_id === sessionId ? '; you' : ''})${item.blocked_reason ? ` — ${item.blocked_reason}` : ''}`),
      ...(items.length > 100 ? ['[More items omitted; query initiative_items.]'] : []),
      '', '## Recent entries',
      ...entries.slice(0, 10).reverse().map((entry) => `[${entry.created_at}] ${entry.kind} (${entry.author_session_id}): ${entry.content}`),
      ...(entries.length > 10 ? ['[Older entries omitted; query initiative_entries.]'] : []),
    ]
    return this.#truncate(lines.join('\n'), MAX_RESULT_BYTES)
  }

  #truncate(text: string, bytes: number): string {
    return Buffer.byteLength(text) <= bytes
      ? text
      : `${Buffer.from(text).subarray(0, bytes - 100).toString('utf8')}\n[Summary truncated; query individual fields.]`
  }

  migrateLegacyMarkdown(): { imported: number; skipped: number } {
    return this.migrateLegacy(projectStoragePath(this.home, 'projects'))
  }

  /** root is this Home's state/legacy-initiatives directory. Originals remain immutable legacy archives. */
  migrateLegacy(legacyRoot: string): { imported: number; skipped: number } {
    if (this.#closed) throw new Error('InitiativeStore is closed')
    if (this.#busy) throw new Error('Reentrant InitiativeStore access is not supported')
    const root = resolve(legacyRoot)
    if (root !== projectStoragePath(this.home, 'projects')) throw new Error('Legacy imports must use this Project state/legacy-initiatives directory')
    if (!existsSync(root)) return { imported: 0, skipped: 0 }
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== projectStoragePath(realpathSync(this.home), 'projects')) throw new Error('Legacy root must not redirect outside Home')
    return this.#transaction('legacy-import', () => {
      let imported = 0
      let skipped = 0
      const children = readdirSync(root, { withFileTypes: true })
      if (children.length > MAX_TABLE_ROWS) throw new Error('Legacy directory limit exceeded')
      for (const child of children) {
        if (child.isSymbolicLink()) throw new Error(`Legacy source is a symbolic link: ${child.name}`)
        if (!child.isDirectory()) continue
        this.#slug(child.name)
        const file = join(root, child.name, 'project.md')
        if (!existsSync(file)) continue
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) throw new Error(`Invalid legacy source: ${child.name}`)
        const bytes = readFileSync(file)
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const hash = createHash('sha256').update(bytes).digest('hex')
        const prior = this.#all('SELECT source_hash FROM initiative_legacy_imports WHERE slug=?', [child.name])[0]
        if (prior) {
          if (prior.source_hash !== hash) throw new Error(`Legacy archive changed after import: ${child.name}`)
          skipped++
          continue
        }
        if (this.#one('initiatives', child.name)) throw new Error(`Legacy initiative conflicts with existing ID: ${child.name}`)
        const legacy = this.#parseLegacy(child.name, content)
        const now = new Date().toISOString()
        this.#insert('initiatives', {
          id: child.name, title: child.name, goal: legacy.goal, context: legacy.context,
          status: legacy.status, created_by_session_id: 'legacy-import', owner_session_id: null,
          created_at: legacy.createdAt, updated_at: now, revision: 1,
        })
        this.#entry(child.name, null, 'legacy', content)
        if (legacy.progress && legacy.progress !== '(No progress yet)') this.#entry(child.name, null, 'progress', legacy.progress)
        if (legacy.notes && legacy.notes !== '(No notes yet)') this.#entry(child.name, null, 'note', legacy.notes)
        this.#entry(child.name, null, 'audit', JSON.stringify({ operation: 'legacy-import', source: `projects/${child.name}/project.md`, source_hash: hash }))
        this.#insert('initiative_legacy_imports', { slug: child.name, source_hash: hash })
        imported++
        this.#checkStorageBounds()
      }
      this.#validateDatabase()
      return { imported, skipped }
    })
  }

  #installAuthorizer(): void {
    // Added in Node 24.10, before our 24.15 minimum; some @types/node releases
    // omit it. Keep both the engine allowlist and closed parser boundaries.
    const db = this.#db as DatabaseSync & { setAuthorizer?: (callback: (action: number, arg1: string | null, arg2: string | null, database: string | null) => number) => void }
    if (!db.setAuthorizer) throw new Error('InitiativeStore requires node:sqlite setAuthorizer (use Node 24.15+)')
    const codes = constants as unknown as Record<string, number>
    const workTables = ['work_contracts', 'work_contract_events', 'work_effects', 'work_focus', 'work_session_links', 'work_observations', 'project_focus_summary']
    const readable = new Set([...Object.keys(TABLE_COLUMNS), 'initiative_legacy_imports', ...workTables])
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (database && database !== 'main') return codes.SQLITE_DENY!
      if (action === codes.SQLITE_SELECT || action === codes.SQLITE_TRANSACTION) return codes.SQLITE_OK!
      if (action === codes.SQLITE_PRAGMA && arg1 === 'user_version' && arg2 === '6' && this.#actor === 'work-migration') return codes.SQLITE_OK!
      if (action === codes.SQLITE_READ && arg1 && readable.has(arg1)) return codes.SQLITE_OK!
      if (action === codes.SQLITE_FUNCTION && ['actor_session_id', 'session_is_inactive', 'session_activity', 'count', 'sum', 'length', 'coalesce', 'trim'].includes(arg2 ?? '')) return codes.SQLITE_OK!
      if (this.#writeAccess && [codes.SQLITE_INSERT, codes.SQLITE_UPDATE, codes.SQLITE_DELETE].includes(action) && arg1 && [...BASE_TABLES, 'initiative_legacy_imports', ...workTables].includes(arg1)) return codes.SQLITE_OK!
      return codes.SQLITE_DENY!
    })
  }

  #transaction<T>(actor: string, operation: () => T, signal?: AbortSignal, readOnly = false): T {
    if (this.#closed) throw new Error('InitiativeStore is closed')
    if (this.#busy) throw new Error('Reentrant InitiativeStore access is not supported')
    signal?.throwIfAborted()
    this.#busy = true
    this.#actor = actor
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
      this.#actor = ''
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

  #value(value: Value): string | number | null {
    return typeof value === 'object' && value !== null ? this.#actor : value
  }

  #checkStatement(statement: Statement): void {
    const columns = TABLE_COLUMNS[statement.table]
    if (!Object.hasOwn(TABLE_COLUMNS, statement.table) || !columns) throw new Error('Unknown initiative table/view')
    const selected = statement.columns ?? Object.keys(statement.assignments ?? {})
    for (const column of [...selected, ...statement.where.map((condition) => condition.column), ...(statement.order ? [statement.order.column] : [])]) {
      if (column === '*' && statement.operation === 'SELECT') continue
      if (!columns.includes(column)) throw new Error(`Unknown column: ${column}`)
    }
    if (statement.operation !== 'SELECT') {
      if (!BASE_TABLES.includes(statement.table)) throw new Error('Views are read-only')
      if (statement.operation === 'DELETE' && statement.table !== 'initiative_item_deps') throw new Error('Only dependency edges may be deleted; cancel initiatives/items instead')
      if (statement.operation === 'UPDATE' && ['initiative_item_deps', 'initiative_entries'].includes(statement.table)) throw new Error('Entries and dependency edges are immutable')
      const writable = WRITABLE[statement.table]!
      for (const column of selected) {
        if (!writable.includes(column)) throw new Error(`System-managed column cannot be written: ${column}`)
        if (statement.operation === 'UPDATE' && ['id', 'initiative_id'].includes(column)) throw new Error('IDs and parent references are immutable')
        if (statement.operation === 'INSERT' && statement.table === 'initiatives' && column === 'owner_session_id') throw new Error('Initial owner is the calling session')
      }
    }
  }

  #where(statement: Statement): { sql: string; values: (string | number | null)[] } {
    return {
      sql: statement.where.length ? ` WHERE ${statement.where.map((condition) => `${condition.column} ${condition.operator} ?`).join(' AND ')}` : '',
      values: statement.where.map((condition) => this.#value(condition.value)),
    }
  }

  #select(statement: Statement): InitiativeRow[] {
    const where = this.#where(statement)
    return this.#all(`SELECT ${statement.columns!.join(',')} FROM ${statement.table}${where.sql}${statement.order ? ` ORDER BY ${statement.order.column} ${statement.order.direction}` : ''} LIMIT ?`, [...where.values, statement.limit ?? 200])
  }

  #mutate(statement: Statement): number {
    const table = statement.table
    if (statement.operation === 'INSERT') {
      const fields = Object.fromEntries(statement.columns!.map((column, index) => [column, this.#value(statement.values![index]!)]))
      const now = new Date().toISOString()
      let row: InitiativeRow
      if (table === 'initiatives') {
        row = { title: fields.id ?? '', goal: '', context: '', status: 'active', ...fields, created_by_session_id: this.#actor, owner_session_id: this.#actor, created_at: now, updated_at: now, revision: 1 }
        this.#assignmentTarget(row.owner_session_id)
      } else if (table === 'initiative_items') {
        const parent = this.#requireParent(fields.initiative_id)
        this.#requireOwner(parent)
        row = { status: 'pending', assignee_session_id: null, blocked_reason: null, ...fields, updated_at: now, revision: 1 }
        this.#assignmentTarget(row.assignee_session_id)
      } else if (table === 'initiative_entries') {
        this.#requireParent(fields.initiative_id, false)
        if (!['note', 'progress', 'decision', 'handoff'].includes(String(fields.kind))) throw new Error('Invalid user entry kind')
        row = { item_id: null, ...fields, id: randomUUID(), author_session_id: this.#actor, created_at: now }
      } else {
        this.#requireOwner(this.#parentOfItem(fields.item_id))
        row = fields
      }
      this.#validateRow(table, row)
      this.#insert(table, row)
      if (table === 'initiative_items' && this.#options.trackWork) {
        const parent = this.#one('initiatives', String(row.initiative_id))!
        const subject = { kind: 'item' as const, initiativeId: String(parent.id), itemId: String(row.id) }
        const record: WorkRecord = {
          key: workKey(subject), subject, revision: 1, sequence: 1,
          definition: { objective: String(parent.goal || row.title),
            acceptance: [String(row.title)], boundaries: [], evidence: [] },
          origin: 'agent_interpretation', changedBy: this.#actor, changedAt: now,
          change: 'understanding', reason: 'Initial assigned work; clarify acceptance and existing boundaries before execution.', paused: false,
        }
        workRecordSchema.parse(record)
        this.#insert('work_contracts', { id: record.key, sequence: 1, data: JSON.stringify(record) })
        this.#workEvent(record.key, this.#actor, 'created', record)
      }
      const parentId = table === 'initiatives' ? row.id : table === 'initiative_item_deps' ? this.#one('initiative_items', String(row.item_id))!.initiative_id : row.initiative_id
      this.#entry(String(parentId), table === 'initiative_items' ? String(row.id) : typeof row.item_id === 'string' ? row.item_id : null, 'audit', JSON.stringify({ operation: 'insert', table, after: row }))
      return 1
    }
    const where = this.#where(statement)
    const rows = this.#all(`SELECT * FROM ${table}${where.sql} LIMIT 201`, where.values)
    if (rows.length > 200) throw new Error('Mutation row limit exceeded (200)')
    let changes = 0
    for (const before of rows) {
      if (statement.operation === 'DELETE') {
        const parent = this.#parentOfItem(before.item_id)
        this.#requireOwner(parent)
        changes += this.#write('DELETE FROM initiative_item_deps WHERE item_id=? AND depends_on_item_id=?', [before.item_id!, before.depends_on_item_id!])
        this.#entry(String(parent.id), String(before.item_id), 'audit', JSON.stringify({ operation: 'delete', table, before }))
        continue
      }
      const fields = Object.fromEntries(Object.entries(statement.assignments!).map(([key, value]) => [key, this.#value(value)]))
      if ((table === 'initiatives' && ('goal' in fields || 'context' in fields)) || (table === 'initiative_items' && 'title' in fields)) {
        const contracts = this.#all('SELECT data FROM work_contracts').map(row => workRecordSchema.parse(JSON.parse(String(row.data))))
        if (contracts.some(record => record.subject.kind === 'item' &&
          (table === 'initiatives' ? record.subject.initiativeId === before.id : record.subject.itemId === before.id))) {
          throw new WorkConflict('This work has versioned agreements. Revise goals/acceptance through work; SQL cannot silently replace their basis.')
        }
      }
      const after = { ...before, ...fields, updated_at: new Date().toISOString(), revision: Number(before.revision) + 1 }
      const parent = table === 'initiatives' ? before : this.#requireParent(before.initiative_id)
      if (table === 'initiatives') this.#authorizeInitiative(before, after, fields, statement)
      else this.#authorizeItem(parent, before, after, fields, statement)
      this.#validateRow(table, after)
      const updated = { ...fields, updated_at: after.updated_at, revision: after.revision }
      changes += this.#write(`UPDATE ${table} SET ${Object.keys(updated).map((key) => `${key}=?`).join(',')} WHERE id=? AND revision=?`, [...Object.values(updated), before.id!, before.revision!])
      this.#entry(String(parent.id), table === 'initiative_items' ? String(before.id) : null, 'audit', JSON.stringify({ operation: 'update', table, before, after }))
    }
    return changes
  }

  #authorizeInitiative(before: InitiativeRow, after: InitiativeRow, fields: InitiativeRow, statement: Statement): void {
    const changingOwner = before.owner_session_id !== after.owner_session_id
    if (changingOwner) {
      this.#assignmentTarget(after.owner_session_id)
      this.#claimGuard(statement, 'owner_session_id')
    }
    if (before.owner_session_id === this.#actor) return
    if (changingOwner && after.owner_session_id === this.#actor &&
      before.owner_session_id === null &&
      Object.keys(fields).every((key) => key === 'owner_session_id')) return
    throw new Error('Only the owner may edit or release this initiative; recorded ownership persists regardless of activity')
  }

  #authorizeItem(parent: InitiativeRow, before: InitiativeRow, after: InitiativeRow, fields: InitiativeRow, statement: Statement): void {
    const changingAssignee = before.assignee_session_id !== after.assignee_session_id
    if (changingAssignee) {
      this.#assignmentTarget(after.assignee_session_id)
      this.#claimGuard(statement, 'assignee_session_id')
      if (before.assignee_session_id !== null && before.assignee_session_id !== this.#actor) {
        throw new Error('Cannot take over a recorded assignment; only the current assignee may release it')
      }
      if (parent.owner_session_id !== this.#actor && after.assignee_session_id !== this.#actor && !(before.assignee_session_id === this.#actor && after.assignee_session_id === null)) {
        throw new Error('Only the initiative owner may delegate assignments')
      }
    }
    if (parent.owner_session_id === this.#actor) {
      if (before.assignee_session_id !== null && before.assignee_session_id !== this.#actor &&
        Object.keys(fields).some((key) => ['status', 'blocked_reason'].includes(key))) {
        throw new Error('Only the current assignee may change item execution status')
      }
      return
    }
    if (before.assignee_session_id === this.#actor) return
    if (changingAssignee && after.assignee_session_id === this.#actor && Object.keys(fields).every((key) => ['assignee_session_id', 'status', 'blocked_reason'].includes(key))) return
    throw new Error('Only the owner or assignee may edit this item')
  }

  #claimGuard(statement: Statement, column: string): void {
    if (!statement.where.some((condition) => (condition.column === column || condition.column === 'revision') &&
      (condition.operator === '=' || (condition.column === column && condition.operator === 'IS' && condition.value === null)))) {
      throw new Error(`Ownership/assignment changes require an equality WHERE guard on ${column} or revision`)
    }
  }

  #requireParent(id: unknown, active = true): InitiativeRow {
    this.#slug(id)
    const row = this.#one('initiatives', String(id))
    if (!row) throw new Error(`Unknown initiative: ${id}`)
    if (active && row.status !== 'active') throw new Error('Initiative is not active')
    return row
  }

  #parentOfItem(id: unknown): InitiativeRow {
    this.#slug(id)
    const item = this.#one('initiative_items', String(id))
    if (!item) throw new Error(`Unknown initiative item: ${id}`)
    return this.#requireParent(item.initiative_id)
  }

  #requireOwner(parent: InitiativeRow): void {
    if (parent.owner_session_id !== this.#actor) throw new Error('Only the initiative owner may change its structure')
  }

  #assignmentTarget(sessionId: unknown): void {
    if (sessionId === null) return
    this.#sessionId(sessionId)
    if (this.#options.isSessionKnown && !this.#options.isSessionKnown(sessionId)) {
      throw new Error('Owner/assignee target session is not known in this Project')
    }
  }

  #inactive(sessionId: string): boolean {
    return this.#activity(sessionId) === 'inactive'
  }

  #activity(sessionId: string | null): 'active' | 'inactive' | 'unknown' | 'unassigned' {
    if (sessionId === null) return 'unassigned'
    const active = this.#options.isSessionActive?.(sessionId)
    return active === true ? 'active' : active === false ? 'inactive' : 'unknown'
  }

  #entry(initiativeId: string, itemId: string | null, kind: string, content: string): void {
    this.#insert('initiative_entries', { id: randomUUID(), initiative_id: initiativeId, item_id: itemId, author_session_id: this.#actor, kind, content, created_at: new Date().toISOString() })
  }

  #slug(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !SLUG.test(value)) throw new Error('ID must be a lowercase alphanumeric/hyphen slug (1..64 characters)')
  }

  #sessionId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid actor/session ID')
  }

  #validateRow(table: string, row: InitiativeRow): void {
    for (const value of Object.values(row)) {
      if (typeof value === 'string' && (Buffer.byteLength(value) > (table === 'initiative_entries' && row.kind === 'audit' ? 6 * MAX_TEXT_BYTES : MAX_TEXT_BYTES) || value.includes('\0'))) {
        throw new Error('Initiative text field exceeds limit or contains NUL')
      }
    }
    if (table === 'initiatives') {
      this.#slug(row.id)
      this.#nonempty(row.title, 'title')
      for (const column of ['goal', 'context', 'created_at', 'updated_at']) if (typeof row[column] !== 'string') throw new Error(`Invalid ${column}`)
      if (!['active', 'completed', 'cancelled'].includes(String(row.status))) throw new Error('Invalid initiative status')
      this.#sessionId(row.created_by_session_id)
      if (row.owner_session_id !== null) this.#sessionId(row.owner_session_id)
    } else if (table === 'initiative_items') {
      this.#slug(row.id); this.#slug(row.initiative_id); this.#nonempty(row.title, 'title')
      if (!['pending', 'in_progress', 'blocked', 'done', 'cancelled'].includes(String(row.status))) throw new Error('Invalid item status')
      if (row.assignee_session_id !== null) this.#sessionId(row.assignee_session_id)
      if (row.status === 'blocked') this.#nonempty(row.blocked_reason, 'blocked_reason')
      else if (row.blocked_reason !== null) throw new Error('blocked_reason must be NULL unless blocked')
    } else if (table === 'initiative_item_deps') {
      this.#slug(row.item_id); this.#slug(row.depends_on_item_id)
      const item = this.#one('initiative_items', String(row.item_id))
      const dep = this.#one('initiative_items', String(row.depends_on_item_id))
      if (!item || !dep || item.initiative_id !== dep.initiative_id) throw new Error('Dependency items must exist in the same initiative')
      if (row.item_id === row.depends_on_item_id) throw new Error('Self dependencies are not allowed')
    } else if (table === 'initiative_entries') {
      this.#slug(row.initiative_id); this.#sessionId(row.author_session_id); this.#nonempty(row.content, 'content')
      if (!['note', 'progress', 'decision', 'handoff', 'audit', 'legacy'].includes(String(row.kind))) throw new Error('Invalid entry kind')
      if (row.kind === 'audit') {
        let record: unknown
        try { record = JSON.parse(String(row.content)) }
        catch { throw new Error('Corrupt initiative audit record') }
        if (typeof record !== 'object' || record === null || !('operation' in record) ||
          !['insert', 'update', 'delete', 'legacy-import'].includes(String(record.operation))) throw new Error('Corrupt initiative audit record')
      }
      if (row.item_id !== null) {
        this.#slug(row.item_id)
        const item = this.#one('initiative_items', String(row.item_id))
        if (!item || item.initiative_id !== row.initiative_id) throw new Error('Entry item must belong to its initiative')
      }
    }
    if (table === 'initiatives' || table === 'initiative_items') {
      if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid initiative revision/timestamp')
    }
    if (table === 'initiatives' || table === 'initiative_entries') {
      if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw new Error('Invalid initiative creation timestamp')
    }
    if (table === 'initiative_entries' && (typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id))) throw new Error('Invalid initiative entry ID')
  }

  #nonempty(value: unknown, name: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`)
  }

  #validateDatabase(): void {
    this.#checkStorageBounds()
    let bytes = 0
    for (const table of BASE_TABLES) {
      const rows = this.#all(`SELECT * FROM ${table}`)
      for (const row of rows) {
        this.#validateRow(table, row)
        bytes += Buffer.byteLength(JSON.stringify(row))
        if (bytes > MAX_DATABASE_TEXT_BYTES) throw new Error('Initiative database text size limit exceeded')
      }
    }
    const edges = this.#all('SELECT * FROM initiative_item_deps')
    const successors = new Map<string, string[]>()
    const indegree = new Map<string, number>()
    for (const edge of edges) {
      const from = String(edge.item_id), to = String(edge.depends_on_item_id)
      successors.set(from, [...(successors.get(from) ?? []), to])
      indegree.set(from, indegree.get(from) ?? 0)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
    let visited = 0
    for (let index = 0; index < queue.length; index++) {
      visited++
      for (const to of successors.get(queue[index]!) ?? []) {
        const degree = indegree.get(to)! - 1
        indegree.set(to, degree)
        if (degree === 0) queue.push(to)
      }
    }
    if (visited !== indegree.size) throw new Error('Dependency cycle is not allowed')
    const unfinished = this.#all(`
      SELECT i.id FROM initiative_items i JOIN initiatives p ON p.id=i.initiative_id
      WHERE p.status='completed' AND i.status NOT IN ('done','cancelled') LIMIT 1
    `)
    if (unfinished.length) throw new Error('Cannot complete initiative with nonterminal items')
    const unsatisfied = this.#all(`
      SELECT i.id FROM initiative_items i
      JOIN initiatives p ON p.id=i.initiative_id
      JOIN initiative_item_deps d ON d.item_id=i.id
      JOIN initiative_items dependency ON dependency.id=d.depends_on_item_id
      WHERE p.status='completed' AND i.status='done' AND dependency.status!='done' LIMIT 1
    `)
    if (unsatisfied.length) throw new Error('Cannot complete initiative with unsatisfied dependencies of done items')
  }

  #checkStorageBounds(): void {
    let characters = 0
    for (const table of BASE_TABLES) {
      const size = TABLE_COLUMNS[table]!.map((column) => `coalesce(length(${column}),0)`).join('+')
      const row = this.#all(`SELECT count(*) AS n, coalesce(sum(${size}),0) AS size FROM ${table}`)[0]!
      if (Number(row.n) > MAX_TABLE_ROWS) throw new Error(`Initiative table row limit exceeded: ${table}`)
      characters += Number(row.size)
      if (characters > MAX_DATABASE_TEXT_BYTES) throw new Error('Initiative database text size limit exceeded')
    }
  }

  #parseLegacy(slug: string, content: string): { goal: string; context: string; progress: string; notes: string; status: string; createdAt: string } {
    const normalized = content.replace(/\r\n/g, '\n')
    const match = normalized.match(/^# Project: ([^\n]+)\n\n\*\*Status\*\*: (active|completed)\n(?:\*\*Completed\*\*: ([^\n]+)\n)?\*\*Created\*\*: ([^\n]+)\n\*\*Goal\*\*: ([^\n]+)\n\n## Context\n([\s\S]*?)\n## Progress\n([\s\S]*?)\n## Notes\n([\s\S]*)$/)
    if (!match || match[1] !== slug || !Number.isFinite(Date.parse(match[4]!)) || (match[3] && !Number.isFinite(Date.parse(match[3])))) {
      throw new Error(`Malformed legacy project: ${slug}; original file was not changed`)
    }
    return { goal: match[5]!, context: match[6]!.trim(), progress: match[7]!.trim(), notes: match[8]!.trim(), status: match[2]!, createdAt: match[4]! }
  }
}
