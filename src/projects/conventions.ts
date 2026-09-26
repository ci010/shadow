import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parseSql, type Statement, type Value } from '../initiatives/sql.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { parseDecisionEvidence, type DecisionEvidence } from '../sessions/decision-brief.ts'
import { parseYieldReference, type YieldReference } from '../sessions/yield-contract.ts'

export type ConventionSource = DecisionEvidence | ({ kind: 'decision' } & YieldReference)
export interface ConventionAuthority {
  source: ConventionSource
  quote: string
}

export function parseConventionSource(value: unknown): ConventionSource {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'decision') {
    const { kind: _, ...reference } = value
    return { kind: 'decision', ...parseYieldReference(reference) }
  }
  const source = parseDecisionEvidence(value)
  if (source.kind !== 'user') throw new TypeError('Project conventions require a recorded human instruction, not a tool observation.')
  return source
}

const conventionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  text: z.string().trim().min(1).max(1000),
})
type Row = Record<string, string | number | null>
const columns: Record<string, readonly string[]> = {
  project_conventions: ['id', 'text', 'revision', 'created_at', 'updated_at', 'created_by_session_id', 'updated_by_session_id'],
  convention_history: ['id', 'convention_id', 'operation', 'revision', 'actor_session_id', 'created_at', 'source', 'before_record', 'after_record'],
  work_items: ['key', 'title', 'parent_key', 'manager', 'assignee', 'revision', 'sequence', 'assignment_revision', 'status', 'paused', 'objective', 'acceptance', 'boundaries', 'result'],
  work_dependencies: ['work_key', 'depends_on_key'],
}

export const PROJECT_SQL_HELP = {
  tables: columns,
  grammar: "SELECT * or columns FROM table [WHERE column op literal AND ...] [ORDER BY column ASC|DESC] [LIMIT 1..200]; INSERT INTO project_conventions (id,text) VALUES ('slug','exact human instruction'); UPDATE project_conventions SET text='...' WHERE id='slug' AND revision=1; DELETE FROM project_conventions WHERE id='slug' AND revision=1;",
  literals: "SQL strings (escape ' as ''), integers, NULL, actor_session_id(). Operators: = != <> < <= > >= IS NULL IS NOT NULL. No joins, expressions, DDL, PRAGMA, subqueries or arbitrary database access.",
  bounds: 'Up to 20 statements, 65536 SQL bytes, 200 result rows/262144 bytes per atomic batch. SELECT defaults to 20 rows. Page by an ordered key/id. At most 50 current conventions and 16000 text characters.',
  authority: 'Project and actor come from the runtime. Reads are Project-wide; only a direct Project-admin human turn in a durable session may mutate. Supply source from ask context or a settled decision reference. Work tables and history are read-only. SQL never grants permissions or changes Work.',
  source: {
    user: { kind: 'user', sessionId: 'current session', physicalId: 'current segment', id: 'current human input ID', quote: 'exact instruction' },
    decision: { kind: 'decision', sessionId: 'current session', physicalId: 'decision segment', requestId: 'human answer receipt' },
  },
  decisions: 'For a new convention, ask with option: Add Project convention <id>: <text>. For update: Update Project convention <id> at revision <n>: <text>. For deletion: Remove Project convention <id> at revision <n>: <old text>. Only that exact human-selected option permits the mutation; timeout, parent, custom, closed or invalidated answers do not. Do not ask again for an already explicit human instruction.',
  instructions: 'For a direct instruction, INSERT/UPDATE text must equal the cited quote, not a model paraphrase. DELETE requires a current human instruction explicitly removing the rule; its meaning remains an agent responsibility, not something substring validation proves. Record project practices only. Personal preferences belong in user profiles; temporary presentation instructions stay in conversation; goals, acceptance and task limits belong in Work. Observations are candidates, not approved conventions.',
  archives: 'Old agent/session/initiative *.conventions.md and projects/*/conventions.md remain historical memory files. They are not promoted or injected as current rules. Read and revalidate relevant sources, never silently recreate them in this table.',
}

/** Project-local policy records. Work query tables are temporary snapshots, never a second Work store. */
export class ProjectConventions {
  private readonly db: DatabaseSync
  private closed = false
  constructor(home: string, private readonly work: () => WorkRecord[]) {
    mkdirSync(home, { recursive: true })
    const filename = join(home, 'conventions.sqlite')
    if (existsSync(filename)) {
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 134_217_728) throw new Error('Invalid Project conventions database file.')
    }
    this.db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false })
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;')
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported Project conventions database version.')
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unrecognized Project conventions database.')
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE convention_records (
            id TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            created_by_session_id TEXT NOT NULL, updated_by_session_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
          ) STRICT;
          CREATE VIEW project_conventions AS SELECT ${columns.project_conventions.join(',')} FROM convention_records WHERE deleted=0;
          CREATE TABLE convention_history (
            id INTEGER PRIMARY KEY, convention_id TEXT NOT NULL REFERENCES convention_records(id),
            operation TEXT NOT NULL, revision INTEGER NOT NULL, actor_session_id TEXT NOT NULL,
            created_at TEXT NOT NULL, source TEXT NOT NULL, before_record TEXT, after_record TEXT
          ) STRICT;
          PRAGMA user_version=1; COMMIT;`)
      }
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok'
        || this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Corrupt Project conventions database.')
      this.db.exec(`CREATE TEMP TABLE work_items (
        key TEXT PRIMARY KEY, title TEXT, parent_key TEXT, manager TEXT, assignee TEXT,
        revision INTEGER, sequence INTEGER, assignment_revision INTEGER, status TEXT, paused INTEGER,
        objective TEXT, acceptance TEXT, boundaries TEXT, result TEXT
      );
      CREATE TEMP TABLE work_dependencies (work_key TEXT, depends_on_key TEXT);`)
    } catch (error) { this.db.close(); throw error }
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }

  prompt(): string | null {
    const rows = this.db.prepare('SELECT id,text,revision FROM project_conventions ORDER BY id').all()
    if (!rows.length) return null
    return '# Current Project conventions\n' +
      'Recorded project practices, not personal preferences, task state or new permissions. Apply within scope; do not use a convention to override a human restriction or current Work. Resolve consequential conflicts explicitly. Changes use sql with attributable human instructions.\n' +
      rows.map(row => JSON.stringify(row)).join('\n')
  }

  query(sql: string, actor: string, authority?: ConventionAuthority, signal?: AbortSignal) {
    if (!actor || actor.length > 512) throw new TypeError('A valid runtime session identity is required.')
    const statements = parseSql(sql)
    for (const statement of statements) this.validate(statement)
    const mutations = statements.some(statement => statement.operation !== 'SELECT')
    if (mutations && !authority) throw new Error('Project convention mutations require a verified human source.')
    if (!mutations && authority) throw new TypeError('A read-only query does not take mutation authority.')
    signal?.throwIfAborted()
    this.db.exec(mutations ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      if (statements.some(statement => statement.table.startsWith('work_'))) this.refreshWork()
      const results: { rows: Row[]; changes: number }[] = []
      let count = 0
      for (const statement of statements) {
        signal?.throwIfAborted()
        const result = statement.operation === 'SELECT'
          ? { rows: this.select(statement, actor), changes: 0 }
          : this.mutate(statement, actor, authority!)
        count += result.rows.length
        results.push(result)
        if (count > 200 || Buffer.byteLength(JSON.stringify(results)) > 262_144) throw new Error('SQL result limit exceeded; narrow the query.')
      }
      const size = this.db.prepare('SELECT count(*) AS count, coalesce(sum(length(text)),0) AS bytes FROM project_conventions').get()!
      if (Number(size.count) > 50 || Number(size.bytes) > 16000) throw new Error('Project conventions exceed the prompt budget; shorten or remove obsolete rules.')
      if (Number(this.db.prepare('SELECT count(*) AS count FROM convention_history').get()!.count) > 5000) throw new Error('Project convention history limit exceeded.')
      signal?.throwIfAborted()
      this.db.exec('COMMIT')
      return { results, changes: results.reduce((sum, result) => sum + result.changes, 0) }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private validate(statement: Statement): void {
    const allowed = columns[statement.table]
    if (!allowed) throw new TypeError('Unknown Project SQL table; omit query to read the schema.')
    const selected = statement.columns ?? Object.keys(statement.assignments ?? {})
    for (const column of [...selected.filter(column => column !== '*'), ...statement.where.map(condition => condition.column), ...(statement.order ? [statement.order.column] : [])]) {
      if (!allowed.includes(column)) throw new TypeError(`Unknown column: ${column}`)
    }
    if (statement.operation === 'SELECT') return
    if (statement.table !== 'project_conventions') throw new Error('Work and audit tables are read-only; use work actions for Work changes.')
    if (statement.operation === 'INSERT') {
      if (selected.length !== 2 || !selected.includes('id') || !selected.includes('text')) throw new TypeError('INSERT takes only id and text.')
    } else {
      if (statement.operation === 'UPDATE' && (selected.length !== 1 || selected[0] !== 'text')) throw new TypeError('UPDATE takes only text.')
      if (statement.where.length !== 2
        || !statement.where.some(item => item.column === 'id' && item.operator === '=' && typeof item.value === 'string')
        || !statement.where.some(item => item.column === 'revision' && item.operator === '=' && typeof item.value === 'number' && item.value > 0)) {
        throw new TypeError('UPDATE/DELETE require exact WHERE id=... AND revision=... guards.')
      }
    }
  }

  private value(value: Value, actor: string): string | number | null {
    return value !== null && typeof value === 'object' ? actor : value
  }

  private select(statement: Statement, actor: string): Row[] {
    const where = statement.where.length ? ` WHERE ${statement.where.map(item => `${item.column} ${item.operator} ?`).join(' AND ')}` : ''
    const order = statement.order ? ` ORDER BY ${statement.order.column} ${statement.order.direction}` : ''
    return this.db.prepare(`SELECT ${statement.columns!.join(',')} FROM ${statement.table}${where}${order} LIMIT ?`)
      .all(...statement.where.map(item => this.value(item.value, actor)), statement.limit ?? 20).map(row => ({ ...row })) as Row[]
  }

  private mutate(statement: Statement, actor: string, authority: ConventionAuthority) {
    const input = statement.operation === 'INSERT'
      ? Object.fromEntries(statement.columns!.map((column, index) => [column, this.value(statement.values![index], actor)]))
      : { id: statement.where.find(item => item.column === 'id')!.value, text: statement.assignments?.text }
    const id = conventionSchema.shape.id.parse(input.id)
    const before = this.db.prepare('SELECT * FROM convention_records WHERE id=?').get(id) as Row | undefined
    if (statement.operation === 'INSERT' ? !!before : !before || before.deleted !== 0
      || before.revision !== statement.where.find(item => item.column === 'revision')!.value) {
      throw new Error('Project convention changed or no longer exists; reload its revision before retrying.')
    }
    const text = statement.operation === 'DELETE' ? String(before!.text) : conventionSchema.shape.text.parse(input.text)
    const oldRevision = Number(before?.revision ?? 0)
    const expected = statement.operation === 'INSERT' ? `Add Project convention ${id}: ${text}`
      : statement.operation === 'UPDATE' ? `Update Project convention ${id} at revision ${oldRevision}: ${text}`
        : `Remove Project convention ${id} at revision ${oldRevision}: ${text}`
    if (authority.source.kind === 'decision' ? authority.quote !== expected
      : statement.operation !== 'DELETE' && authority.quote !== text) {
      throw new Error(`Convention content must quote the current human instruction exactly, or have a human-selected decision option exactly matching: ${expected}`)
    }
    const now = new Date().toISOString()
    const revision = oldRevision + 1
    if (statement.operation === 'INSERT') {
      this.db.prepare('INSERT INTO convention_records VALUES (?,?,?,?,?,?,?,0)').run(id, text, revision, now, now, actor, actor)
    } else {
      this.db.prepare('UPDATE convention_records SET text=?,revision=?,updated_at=?,updated_by_session_id=?,deleted=? WHERE id=?')
        .run(text, revision, now, actor, statement.operation === 'DELETE' ? 1 : 0, id)
    }
    const after = this.db.prepare('SELECT * FROM convention_records WHERE id=?').get(id)
    this.db.prepare('INSERT INTO convention_history (convention_id,operation,revision,actor_session_id,created_at,source,before_record,after_record) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, statement.operation, revision, actor, now, JSON.stringify(authority), before ? JSON.stringify(before) : null, JSON.stringify(after))
    return { rows: [{ id, revision }], changes: 1 }
  }

  private refreshWork(): void {
    this.db.exec('DELETE FROM temp.work_items; DELETE FROM temp.work_dependencies;')
    const insert = this.db.prepare('INSERT INTO temp.work_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const dependency = this.db.prepare('INSERT INTO temp.work_dependencies VALUES (?,?)')
    for (const record of this.work()) {
      const flow = record.workflow
      insert.run(record.key, flow?.title ?? null, flow?.parentKey ?? null, flow?.manager ?? null, flow?.assignee ?? null,
        record.revision, record.sequence, flow?.assignmentRevision ?? null, flow?.status ?? null, record.paused ? 1 : 0,
        record.definition.objective, JSON.stringify(record.definition.acceptance), JSON.stringify(record.definition.boundaries),
        flow?.result ? JSON.stringify(flow.result) : null)
      for (const key of flow?.dependencies ?? []) dependency.run(record.key, key)
    }
  }
}
