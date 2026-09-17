import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { constants, DatabaseSync } from 'node:sqlite'
import { ITEM_ACTIVITY_VIEW, SCHEMA, TABLE_COLUMNS } from './schema.ts'
import { parseSql, type Statement, type Value } from './sql.ts'

export type InitiativeRow = Record<string, string | number | null>
export interface InitiativeQueryResult {
  results: { rows: InitiativeRow[]; changes: number }[]
  changes: number
}
export interface InitiativeStoreOptions {
  /** Return true for a live session, false for a known inactive session. Unknown must return undefined. */
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
  #options: InitiativeStoreOptions

  constructor(home: string, options: InitiativeStoreOptions = {}) {
    this.home = resolve(home)
    this.#options = options
    mkdirSync(this.home, { recursive: true })
    const filename = join(this.home, 'initiatives.sqlite')
    if (existsSync(filename)) {
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Initiative database must be a regular file, not a symbolic link')
      if (stat.size > 134_217_728) throw new Error('Initiative database file size limit exceeded')
    }
    this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false })
    try {
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;')
      const version = this.#db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (![0, 1, 2].includes(version.user_version)) throw new Error('Unsupported initiative database version')
      if (version.user_version === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (tables.length) throw new Error('Unrecognized initiative database schema')
        this.#db.exec(`BEGIN IMMEDIATE; ${SCHEMA} ${ITEM_ACTIVITY_VIEW} PRAGMA user_version=2; COMMIT;`)
      } else if (version.user_version === 1) {
        this.#db.exec(`BEGIN IMMEDIATE; ${ITEM_ACTIVITY_VIEW} PRAGMA user_version=2; COMMIT;`)
      }
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

  query(sql: string, actorSessionId: string, signal?: AbortSignal): InitiativeQueryResult {
    this.#sessionId(actorSessionId)
    const statements = parseSql(sql)
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

  getSummary(initiativeId: string, sessionId?: string): string | null {
    this.#slug(initiativeId)
    if (sessionId !== undefined) this.#sessionId(sessionId)
    return this.#transaction(sessionId ?? '', () => this.#summary(initiativeId, sessionId))
  }

  getSessionSummary(actorSessionId: string): string | null {
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
        const handoffItems = this.#all('SELECT * FROM initiative_item_activity WHERE initiative_id=? AND needs_handoff=1 ORDER BY id LIMIT 11', [initiative.id!])
        const handoff = initiative.owner_session_id === null || this.#inactive(String(initiative.owner_session_id))
        return this.#truncate([
          `# Initiative: ${this.#truncate(String(initiative.title), 300)} (${initiative.id})`,
          `Status: active${handoff ? ' — needs-handoff' : ''}; owner: ${initiative.owner_session_id ?? '(unowned)'}`,
          `Goal: ${this.#truncate(String(initiative.goal), 1000)}`,
          ...(handoffItems.length ? [
            '## Items needing handoff',
            ...handoffItems.slice(0, 10).map((item) => `- ${item.id}: [${item.status}] assignee ${item.assignee_session_id} — inactive; needs-handoff`),
            ...(handoffItems.length > 10 ? ['[More stopped assignments omitted; query initiative_item_activity.]'] : []),
          ] : []),
          '## Your assigned work',
          ...assigned.slice(0, 10).map((item) => `- ${item.id}: [${item.status}] ${this.#truncate(String(item.title), 300)} (activity: ${item.assignee_activity}${item.needs_handoff ? '; needs-handoff' : ''})${item.blocked_reason ? ` — ${this.#truncate(String(item.blocked_reason), 300)}` : ''}`),
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
    const handoff = initiative.status === 'active' && (initiative.owner_session_id === null || this.#inactive(String(initiative.owner_session_id)))
    const lines = [
      `# Initiative: ${initiative.title} (${initiative.id})`,
      `Status: ${initiative.status}${handoff ? ' — needs-handoff' : ''}`,
      `Owner session: ${initiative.owner_session_id ?? '(unowned)'}`,
      `Goal: ${initiative.goal}`, '', '## Context', String(initiative.context), '', '## Work items',
      ...items.slice(0, 100).map((item) => `- ${item.id}: [${item.status}] ${item.title} (assignee: ${item.assignee_session_id ?? 'none'}; activity: ${item.assignee_activity}${item.needs_handoff ? '; needs-handoff' : ''}${item.assignee_session_id === sessionId ? '; you' : ''})${item.blocked_reason ? ` — ${item.blocked_reason}` : ''}`),
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
    return this.migrateLegacy(join(this.home, 'projects'))
  }

  /** root is this Home's projects directory. Originals remain immutable legacy archives. */
  migrateLegacy(legacyRoot: string): { imported: number; skipped: number } {
    if (this.#closed) throw new Error('InitiativeStore is closed')
    if (this.#busy) throw new Error('Reentrant InitiativeStore access is not supported')
    const root = resolve(legacyRoot)
    if (root !== join(this.home, 'projects')) throw new Error('Legacy imports must use this Project Home/projects directory')
    if (!existsSync(root)) return { imported: 0, skipped: 0 }
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== join(realpathSync(this.home), 'projects')) throw new Error('Legacy root must not redirect outside Home')
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
    const readable = new Set([...Object.keys(TABLE_COLUMNS), 'initiative_legacy_imports'])
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (database && database !== 'main') return codes.SQLITE_DENY!
      if (action === codes.SQLITE_SELECT || action === codes.SQLITE_TRANSACTION) return codes.SQLITE_OK!
      if (action === codes.SQLITE_READ && arg1 && readable.has(arg1)) return codes.SQLITE_OK!
      if (action === codes.SQLITE_FUNCTION && ['actor_session_id', 'session_is_inactive', 'session_activity', 'count', 'sum', 'length', 'coalesce', 'trim'].includes(arg2 ?? '')) return codes.SQLITE_OK!
      if (this.#writeAccess && [codes.SQLITE_INSERT, codes.SQLITE_UPDATE, codes.SQLITE_DELETE].includes(action) && arg1 && [...BASE_TABLES, 'initiative_legacy_imports'].includes(arg1)) return codes.SQLITE_OK!
      return codes.SQLITE_DENY!
    })
  }

  #transaction<T>(actor: string, operation: () => T, signal?: AbortSignal): T {
    if (this.#closed) throw new Error('InitiativeStore is closed')
    if (this.#busy) throw new Error('Reentrant InitiativeStore access is not supported')
    signal?.throwIfAborted()
    this.#busy = true
    this.#actor = actor
    try {
      this.#db.exec('BEGIN IMMEDIATE')
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
      (before.owner_session_id === null || this.#inactive(String(before.owner_session_id))) &&
      Object.keys(fields).every((key) => key === 'owner_session_id')) return
    throw new Error('Only the owner may edit this initiative; inactive ownership requires an explicit guarded claim')
  }

  #authorizeItem(parent: InitiativeRow, before: InitiativeRow, after: InitiativeRow, fields: InitiativeRow, statement: Statement): void {
    const changingAssignee = before.assignee_session_id !== after.assignee_session_id
    if (changingAssignee) {
      this.#assignmentTarget(after.assignee_session_id)
      this.#claimGuard(statement, 'assignee_session_id')
      if (before.assignee_session_id !== null && before.assignee_session_id !== this.#actor && !this.#inactive(String(before.assignee_session_id))) {
        throw new Error('Cannot take over an active or unknown assignment')
      }
      if (parent.owner_session_id !== this.#actor && after.assignee_session_id !== this.#actor && !(before.assignee_session_id === this.#actor && after.assignee_session_id === null)) {
        throw new Error('Only the initiative owner may delegate assignments')
      }
    }
    if (parent.owner_session_id === this.#actor) {
      if (before.assignee_session_id !== null && before.assignee_session_id !== this.#actor &&
        !this.#inactive(String(before.assignee_session_id)) && Object.keys(fields).some((key) => ['status', 'blocked_reason'].includes(key))) {
        throw new Error('Only the active assignee may change item execution status')
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
