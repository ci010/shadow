import { FreshAutomationStateStore } from './fresh-automation-state.ts'
import { DatabaseSync as Database } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { transaction } from '../utils/sqlite.ts'
import type {
  SessionConfig,
  SessionParent,
  SessionState,
  SessionStore,
  StoredMessage,
} from './session-store.ts'
import { parseWorkdirRefV1 } from './locality.ts'
import { isExecutionMode } from './execution-mode.ts'
import { parseSessionRecovery, parseContextResetAt, ContextResetMetadataError, parseDecisionOwner, DecisionOwnerMetadataError } from './session-store.ts'
import { parseAutomationSessionRef } from '../cron/contracts.ts'
import { normalizeInitiativeMetadata, parseInitiativeId, InitiativeMetadataError } from './initiative-metadata.ts'
import { validateOwnership, OwnershipValidationError } from '../projects/ownership.ts'
import { parseTopicSessionFields, TopicMetadataError } from './topic-contract.ts'
import { parsePhysicalIdVersion } from './session-identity.ts'
import { parseSessionName, SessionNameError } from './session-name.ts'
import { parseWorkPolicy, WorkPolicyError } from './work-policy.ts'
import { parseChannelBoundary, ChannelBoundaryMetadataError } from '../channels/integration-contract.ts'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 50
const PROTOTYPE_VERSION = 1

type SessionMetadata = Omit<
  SessionState,
  'sessionId' | 'segmentIndex' | 'lastActivityAt' | 'lastKnownTokens'
>

interface SessionPrototypeV1 {
  version: 1
  metadata: SessionMetadata & Record<string, unknown>
}

const SESSION_METADATA_KEYS = new Set<keyof SessionMetadata>([
  'channelBoundary',
  'workPolicy',
  'name',
  'generatedTitle',
  'chatName',
  'physicalIdVersion',
  'sessionKind',
  'topic',
  'createdBySessionId',
  'topicRequestHash',
  'decisionOwnerSessionId',
  'ownershipVersion',
  'automation',
  'automationVersion',
  'projectId',
  'config',
  'parent',
  'workspaceRoot',
  'workdir',
  'agentType',
  'initiativeId',
  'folderId',
  'reportTo',
  'originUser',
  'description',
  'children',
  'preloadTools',
  'mode',
  'executionStatus',
  'recovery',
  'contextResetAt',
  'executionId',
  'parentSessionId',
  'executionKey',
  'parentToolCallId',
  'completionReported',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionParent(value: unknown): value is SessionParent {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.physicalId === undefined || typeof value.physicalId === 'string') &&
    (value.index === undefined || typeof value.index === 'number')
}

function isPreloadTools(
  value: unknown,
): value is Record<string, string[]> {
  return isRecord(value) &&
    Object.values(value).every((args) =>
      Array.isArray(args) && args.every((arg) => typeof arg === 'string')
    )
}

function parseMetadata(value: unknown): SessionMetadata | null {
  if (!isRecord(value)) return null
  value = normalizeInitiativeMetadata(validateOwnership(value))
  if (!isRecord(value)) return null

  const metadata: SessionMetadata = { ownershipVersion: 2, ...parseTopicSessionFields(value) }
  if (value.channelBoundary !== undefined) metadata.channelBoundary = parseChannelBoundary(value.channelBoundary)
  if (value.workPolicy !== undefined) metadata.workPolicy = parseWorkPolicy(value.workPolicy)
  if (value.name !== undefined) metadata.name = parseSessionName(value.name)
  if (value.generatedTitle !== undefined) metadata.generatedTitle = parseSessionName(value.generatedTitle)
  if (value.chatName !== undefined) metadata.chatName = parseSessionName(value.chatName)
  if (value.decisionOwnerSessionId !== undefined) metadata.decisionOwnerSessionId = parseDecisionOwner(value.decisionOwnerSessionId)
  if (value.physicalIdVersion !== undefined) metadata.physicalIdVersion = parsePhysicalIdVersion(value.physicalIdVersion)
  if (value.automation !== undefined) metadata.automation = parseAutomationSessionRef(value.automation)
  if (value.automationVersion === 1) metadata.automationVersion = 1
  if (value.recovery !== undefined) metadata.recovery = parseSessionRecovery(value.recovery)
  if (value.contextResetAt !== undefined) metadata.contextResetAt = parseContextResetAt(value.contextResetAt)
  if (typeof value.completionReported === 'boolean') metadata.completionReported = value.completionReported
  if (isExecutionMode(value.mode)) metadata.mode = value.mode
  if (['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(value.executionStatus))) {
    metadata.executionStatus = value.executionStatus as SessionState['executionStatus']
  }
  if (isRecord(value.config)) metadata.config = value.config as SessionConfig
  if (isSessionParent(value.parent)) metadata.parent = value.parent
  const workdir = parseWorkdirRefV1(value.workdir)
  if (workdir) metadata.workdir = workdir

  for (
    const key of [
      'projectId',
      'workspaceRoot',
      'agentType',
      'initiativeId',
      'folderId',
      'reportTo',
      'originUser',
      'description',
      'executionId',
      'parentSessionId',
      'executionKey',
      'parentToolCallId',
    ] as const
  ) {
    if (typeof value[key] === 'string') metadata[key] = value[key]
  }
  if (value.parentSessionId === null) metadata.parentSessionId = null

  if (
    Array.isArray(value.children) &&
    value.children.every((child) => typeof child === 'string')
  ) {
    metadata.children = value.children
  }
  if (isPreloadTools(value.preloadTools)) {
    metadata.preloadTools = value.preloadTools
  }

  return metadata
}

/**
 * Retry a synchronous SQLite operation with exponential backoff.
 * Targets transient errors like SQLITE_BUSY (WAL contention).
 * Yields the event loop between retries via `setTimeout`.
 */
async function withRetry<T>(label: string, fn: () => T): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return fn()
    } catch (err) {
      const isBusy = err instanceof Error &&
        (err.message.includes('SQLITE_BUSY') ||
          err.message.includes('database is locked'))
      if (!isBusy || attempt === MAX_RETRIES) {
        console.error(
          `[sqlite-store] ${label} failed after ${attempt + 1} attempt(s):`,
          err,
        )
        throw err
      }
      const delay = BASE_DELAY_MS * 2 ** attempt
      console.warn(
        `[sqlite-store] ${label} SQLITE_BUSY, retry ${
          attempt + 1
        }/${MAX_RETRIES} in ${delay}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('unreachable')
}

/**
 * SQLite-backed session store.
 *
 * Stores all session state and log data in a single SQLite database file
 * (`sessions.db`) under the sessions directory.
 *
 * Tables:
 * - `session_states` — one row per logical session key
 * - `session_logs`   — ordered records per physical session id
 *
 * Write operations use `withRetry` to handle transient SQLITE_BUSY errors
 * with exponential backoff, keeping retry logic inside the store layer.
 */
export class SqliteSessionStore implements SessionStore {
  private db: Database
  private prototypeMetadataExtras = new Map<string, Record<string, unknown>>()
  private stmtGetState: ReturnType<Database['prepare']>
  private stmtGetAllStates: ReturnType<Database['prepare']>
  private stmtUpsertState: ReturnType<Database['prepare']>
  private stmtListSessions: ReturnType<Database['prepare']>
  private stmtDeleteState: ReturnType<Database['prepare']>
  private stmtReadLog: ReturnType<Database['prepare']>
  private stmtAppendLog: ReturnType<Database['prepare']>
  private stmtDeleteLog: ReturnType<Database['prepare']>
  private stmtCountLog: ReturnType<Database['prepare']>
  private stmtReadFirstLog: ReturnType<Database['prepare']>

  private readonly fresh: FreshAutomationStateStore
  readArchivedState = (id: string) => this.fresh.archived(id)
  queryArchivedStates = (query?: import('./session-store.ts').ArchivedStateQuery) => this.fresh.query(query)
  countArchivedStates = (query?: import('./session-store.ts').ArchivedStateQuery) => this.fresh.count(query)
  archiveFeatureStates = (projectId?: string) => this.fresh.features(projectId)
  archiveState = (state: SessionState) => this.fresh.archive(state)
  listArchiveReferences = () => this.fresh.references()

  constructor(sessionsDir: string, options: { readOnly?: boolean } = {}) {
    this.fresh = new FreshAutomationStateStore(sessionsDir, 'sqlite', options.readOnly)
    const dbPath = join(sessionsDir, 'sessions.db')
    const dir = dirname(dbPath)
    if (!options.readOnly && dir && dir !== '.') mkdirSync(dir, { recursive: true })

    this.db = new Database(dbPath, { readOnly: options.readOnly ?? false })
    if (!options.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.initSchema()
    }

    // ── Prepared statements ──
    this.stmtGetState = this.db.prepare(
      'SELECT key, segment_count, last_activity_at, last_known_tokens, prototype FROM session_states WHERE key = ?',
    )
    this.stmtGetAllStates = this.db.prepare(
      'SELECT key, segment_count, last_activity_at, last_known_tokens, prototype FROM session_states',
    )
    this.stmtUpsertState = this.db.prepare(`
      INSERT INTO session_states (key, segment_count, last_activity_at, last_known_tokens, prototype)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        segment_count = excluded.segment_count,
        last_activity_at = excluded.last_activity_at,
        last_known_tokens = excluded.last_known_tokens,
        prototype = excluded.prototype
    `)
    this.stmtListSessions = this.db.prepare(
      'SELECT key, segment_count, last_activity_at, last_known_tokens, prototype FROM session_states',
    )
    this.stmtDeleteState = this.db.prepare(
      'DELETE FROM session_states WHERE key = ?',
    )
    this.stmtReadLog = this.db.prepare(
      'SELECT data FROM session_logs WHERE session_id = ? ORDER BY seq ASC',
    )
    this.stmtAppendLog = this.db.prepare(
      'INSERT INTO session_logs (session_id, data) VALUES (?, ?)',
    )
    this.stmtDeleteLog = this.db.prepare('DELETE FROM session_logs WHERE session_id = ?')
    this.stmtCountLog = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM session_logs WHERE session_id = ?',
    )
    this.stmtReadFirstLog = this.db.prepare(
      'SELECT data FROM session_logs WHERE session_id = ? ORDER BY seq ASC LIMIT 1',
    )
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_states (
        key               TEXT PRIMARY KEY,
        segment_count     INTEGER NOT NULL DEFAULT 0,
        last_activity_at  TEXT,
        last_known_tokens INTEGER,
        prototype         TEXT
      );

      CREATE TABLE IF NOT EXISTS session_logs (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_session ON session_logs(session_id);
    `)

    // Additive migration: add prototype column if upgrading from older schema.
    try {
      this.db.exec('ALTER TABLE session_states ADD COLUMN prototype TEXT')
    } catch { /* column already exists */ }

    // Migration: add segment_count (stores 0-based index) and derive from history length for existing rows.
    try {
      this.db.exec('ALTER TABLE session_states ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0')
      // Backfill from legacy history JSON array
      const rows = this.db.prepare('SELECT key, history FROM session_states WHERE history IS NOT NULL').all() as Array<{ key: string; history: string }>
      const update = this.db.prepare('UPDATE session_states SET segment_count = ? WHERE key = ?')
      for (const row of rows) {
        try {
          const history = JSON.parse(row.history) as string[]
          if (history.length > 0) {
            update.run(history.length - 1, row.key)
          }
        } catch { /* skip */ }
      }
    } catch { /* column already exists */ }
  }

  async init(): Promise<void> {
    // Schema already created in constructor; nothing async needed.
  }

  // ── State management ────────────────────────────────────────────────────

  private parseRow(row: {
    key: string
    segment_count: number
    last_activity_at: string | null
    last_known_tokens: number | null
    prototype: string | null
  }): SessionState {
    let metadata: SessionMetadata = {}
    if (!row.prototype) throw new OwnershipValidationError('Missing session prototype metadata')
    if (row.prototype) {
      try {
        const parsed: unknown = JSON.parse(row.prototype)
        if (
          isRecord(parsed) && parsed.version === PROTOTYPE_VERSION &&
          isRecord(parsed.metadata)
        ) {
          metadata = parseMetadata(parsed.metadata) ?? {}
          this.prototypeMetadataExtras.set(
            row.key,
            Object.fromEntries(
              Object.entries(parsed.metadata).filter(([key]) =>
                key !== 'projectName' && key !== 'initiativeName' &&
                !SESSION_METADATA_KEYS.has(key as keyof SessionMetadata)
              ),
            ),
          )
        } else {
          throw new OwnershipValidationError('Unsupported session prototype version or metadata')
        }
      } catch (error) {
        if (error instanceof ChannelBoundaryMetadataError || error instanceof WorkPolicyError || error instanceof SessionNameError || error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError || error instanceof ContextResetMetadataError || error instanceof DecisionOwnerMetadataError) throw error
        throw new OwnershipValidationError('Invalid session prototype metadata')
      }
    }
    return {
      sessionId: row.key,
      segmentIndex: row.segment_count ?? 0,
      lastActivityAt: row.last_activity_at ?? undefined,
      lastKnownTokens: row.last_known_tokens ?? undefined,
      ...metadata,
    }
  }

  async getState(sessionKey: string): Promise<SessionState | null> {
    const active = await this.fresh.getActive(sessionKey)
    if (active) return active
    const row = this.stmtGetState.get(sessionKey) as
      | {
        key: string
        segment_count: number
        last_activity_at: string | null
        last_known_tokens: number | null
        prototype: string | null
      }
      | undefined
    if (!row) return null
    return this.parseRow(row)
  }

  async saveState(sessionKey: string, state: SessionState): Promise<void> {
    if (state.statePersistence) {
      if (sessionKey !== state.sessionId) throw new Error('Fresh automation key mismatch')
      if (this.stmtGetState.get(sessionKey)) throw new Error('Existing legacy state cannot opt into fresh automation persistence')
      return this.fresh.save(state)
    }
    if (await this.fresh.has(sessionKey)) throw new Error('Fresh automation policy cannot be removed')
    validateOwnership({ ...state, ownershipVersion: state.ownershipVersion ?? 2 })
    const prototype: SessionPrototypeV1 = {
      version: PROTOTYPE_VERSION,
      metadata: {
        ...this.prototypeMetadataExtras.get(sessionKey),
        workPolicy: parseWorkPolicy(state.workPolicy),
        name: state.name === undefined ? undefined : parseSessionName(state.name),
        generatedTitle: state.generatedTitle === undefined ? undefined : parseSessionName(state.generatedTitle),
        chatName: state.chatName === undefined ? undefined : parseSessionName(state.chatName),
        decisionOwnerSessionId: parseDecisionOwner(state.decisionOwnerSessionId),
        ...parseTopicSessionFields(state),
        ownershipVersion: 2,
        physicalIdVersion: parsePhysicalIdVersion(state.physicalIdVersion),
        projectId: state.projectId,
        config: state.config,
        parent: state.parent,
        workspaceRoot: state.workspaceRoot,
        workdir: state.workdir,
        agentType: state.agentType,
        initiativeId: parseInitiativeId({ ...state }),
        folderId: state.folderId,
        automation: parseAutomationSessionRef(state.automation),
        automationVersion: state.automationVersion,
        reportTo: state.reportTo,
        originUser: state.originUser,
        description: state.description,
        children: state.children,
        preloadTools: state.preloadTools,
        mode: state.mode,
        executionStatus: state.executionStatus,
        recovery: state.recovery,
        contextResetAt: parseContextResetAt(state.contextResetAt),
        channelBoundary: parseChannelBoundary(state.channelBoundary),
        executionId: state.executionId,
        parentSessionId: state.parentSessionId,
        executionKey: state.executionKey,
        parentToolCallId: state.parentToolCallId,
        completionReported: state.completionReported,
      },
    }
    await withRetry('saveState', () =>
      this.stmtUpsertState.run(
        sessionKey,
        state.segmentIndex,
        state.lastActivityAt ?? null,
        state.lastKnownTokens ?? null,
        JSON.stringify(prototype),
      ))
  }

  async listSessions(): Promise<
    Array<
      {
        sessionId: string
        name?: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
        sessionKind?: SessionState['sessionKind']
        topic?: SessionState['topic']
        createdBySessionId?: string
      }
    >
  > {
    const rows = this.stmtListSessions.all() as Array<{
      key: string
      segment_count: number
      last_activity_at: string | null
      last_known_tokens: number | null
      prototype: string | null
    }>
    const result = rows.map(r => {
      const state = this.parseRow(r)
      return {
        sessionId: r.key,
        ...(state.name !== undefined ? { name: state.name } : {}),
        segmentIndex: r.segment_count ?? 0,
        lastActivityAt: r.last_activity_at ?? undefined,
        folderId: state.folderId,
        ...parseTopicSessionFields(state),
      }
    })
    return [...result, ...await this.fresh.summaries()]
  }

  async listAllStates(): Promise<Record<string, SessionState>> {
    const rows = this.stmtGetAllStates.all() as Array<{
      key: string
      segment_count: number
      last_activity_at: string | null
      last_known_tokens: number | null
      prototype: string | null
    }>
    const result: Record<string, SessionState> = {}
    for (const row of rows) {
      result[row.key] = this.parseRow(row)
    }
    Object.assign(result, await this.fresh.listActive())
    return result
  }

  async deleteState(sessionKey: string): Promise<void> {
    if (await this.fresh.has(sessionKey)) throw new Error('Fresh automation history deletion is not supported')
    await withRetry('deleteState', () => this.stmtDeleteState.run(sessionKey))
    this.prototypeMetadataExtras.delete(sessionKey)
  }

  // ── Session log operations ──────────────────────────────────────────────

  async *readSessionLog(
    sessionId: string,
  ): AsyncIterable<Record<string, unknown>> {
    const rows = this.stmtReadLog.all(sessionId) as Array<{ data: string }>
    for (const row of rows) {
      try {
        yield JSON.parse(row.data) as Record<string, unknown>
      } catch { /* skip malformed */ }
    }
  }

  async appendMessages(
    sessionId: string,
    messages: StoredMessage[],
  ): Promise<void> {
    if (messages.length === 0) return
    await withRetry('appendMessages', () => {
      transaction(this.db, () => {
        for (const msg of messages) {
          this.stmtAppendLog.run(sessionId, JSON.stringify(msg))
        }
      })
    })
  }

  async createSessionLog(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void> {
    await withRetry('createSessionLog', () => {
      transaction(this.db, () => {
        for (const event of events) {
          this.stmtAppendLog.run(sessionId, JSON.stringify(event))
        }
      })
    })
  }

  async appendRawEvents(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void> {
    if (events.length === 0) return
    await withRetry('appendRawEvents', () => {
      transaction(this.db, () => {
        for (const event of events) {
          this.stmtAppendLog.run(sessionId, JSON.stringify(event))
        }
      })
    })
  }

  async deleteSessionLog(sessionId: string): Promise<void> {
    await withRetry('deleteSessionLog', () => this.stmtDeleteLog.run(sessionId))
  }

  async countSessionLog(sessionId: string): Promise<number> {
    const row = this.stmtCountLog.get(sessionId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  async readFirstRecord(sessionId: string): Promise<Record<string, unknown> | null> {
    const row = this.stmtReadFirstLog.get(sessionId) as { data: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.data) as Record<string, unknown>
    } catch {
      return null
    }
  }

  close(): void {
    this.fresh.close()
    this.db.close()
  }
}
