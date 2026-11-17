import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionState, SessionStore } from '../../sessions/session-store.ts'
import { hasTruncatedLegacyHistory, physicalSessionId } from '../../sessions/session-identity.ts'
import { canonical, checksum, type HistoryInventory, type MaintenanceHistory } from './maintenance-contracts.ts'
import { safeSessionId } from '../../utils/paths.ts'

export interface MaintenanceHistoryOptions {
  projectId: string
  /** Trusted host configuration, never a request-supplied path. */
  sessionsDirectory: string
  format: 'jsonl' | 'sqlite'
}

/** Complete persisted raw-record adapter. Does not use SessionManager's live state,
 * model history, presentation sanitizers or pagination. No writes or recovery.
 *
 * The ordinary store readers deliberately tolerate missing/malformed logs. That
 * is unsuitable for a cutoff: live sources are read strictly from the configured
 * backend; conversation archives use the store's exact immutable range API.
 * SQLite has no physical-segment table: a zero-row live segment cannot be
 * distinguished from a deleted segment and is rejected, never attested empty.
 * JSONL empty files and archived zero-record segments are representable.
 */
export class SessionStoreMaintenanceHistory implements MaintenanceHistory {
  constructor(private readonly store: SessionStore, private readonly options: MaintenanceHistoryOptions) {
    if (!options.projectId.trim() || !['jsonl', 'sqlite'].includes(options.format)) throw new Error('Invalid maintenance history configuration')
    if (!store.queryArchivedStates || !store.queryConversationArchives || !store.readArchivedState || !store.readArchivedLogRange) {
      throw new Error('Complete persisted archive enumeration/read support required')
    }
  }

  private async directory(): Promise<string> {
    const path = this.options.sessionsDirectory
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Unsafe or missing sessions directory')
    return path
  }

  private async states(): Promise<SessionState[]> {
    await this.directory()
    const states = new Map<string, SessionState>()
    const add = (raw: SessionState) => {
      // Store hydration may include undefined optional fields (not persisted JSON).
      const state = JSON.parse(JSON.stringify(raw)) as SessionState
      if (typeof state.sessionId !== 'string' || !state.sessionId || typeof state.projectId !== 'string' || !state.projectId.trim()) {
        throw new Error('History state lacks explicit Project ownership')
      }
      if (!Number.isSafeInteger(state.segmentIndex) || state.segmentIndex < 0 || state.segmentIndex > 100000) throw new Error('Invalid history segment count')
      const previous = states.get(state.sessionId)
      if (previous && canonical(previous) !== canonical(state)) throw new Error('Conflicting persisted history states')
      states.set(state.sessionId, state)
    }
    // JSONL listAllStates normalizes into a map and can overwrite duplicate
    // logical identities before callers see them. Validate physical state files
    // independently first; neither stray aliases nor malformed/symlink files may
    // disappear into a successful complete inventory.
    if (this.options.format === 'jsonl') {
      const directory = await this.directory()
      const identities = new Set<string>()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.name.endsWith('.json')) continue
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe persisted history state file')
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(directory, entry.name))))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.sessionId !== 'string'
          || entry.name !== `${safeSessionId(raw.sessionId)}.json` || identities.has(raw.sessionId)) {
          throw new Error('Conflicting or aliased persisted history state file')
        }
        identities.add(raw.sessionId)
      }
    }
    for (const [key, state] of Object.entries(await this.store.listAllStates())) {
      if (key !== state.sessionId) throw new Error('Persisted history state key mismatch')
      add(state)
    }
    // Fresh automation archives are not in listAllStates. Do not filter by
    // Project before validating ownership or checking physical-ID collisions.
    if (this.store.queryArchivedStates) for (let offset = 0; ; offset += 1000) {
      const page = await this.store.queryArchivedStates({ offset, limit: 1000 })
      for (const state of page) add(state)
      if (page.length < 1000) break
    }
    // Ordinary retired conversation archives use a distinct inventory.
    if (this.store.queryConversationArchives) {
      if (!this.store.readArchivedState) throw new Error('Archive state reader unavailable')
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        const page = await this.store.queryConversationArchives({ limit: 200, ...(cursor ? { cursor } : {}) })
        for (const item of page.items) {
          const state = await this.store.readArchivedState(item.sessionId)
          if (!state || state.sessionId !== item.sessionId) throw new Error('Missing archived history state')
          add(state)
        }
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Repeated history archive cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
    }
    const owners = new Map<string, string>()
    for (const state of states.values()) {
      if (state.projectId === this.options.projectId && hasTruncatedLegacyHistory(state)) throw new Error('Ambiguous truncated legacy physical history')
      for (let index = 0; index <= state.segmentIndex; index++) {
        const physical = physicalSessionId(state, index)
        if (!/^[a-zA-Z0-9_-]+$/.test(physical)) throw new Error('Unsafe physical history ID')
        const owner = owners.get(physical)
        if (owner && owner !== state.sessionId) throw new Error('Physical history ownership collision')
        owners.set(physical, state.sessionId)
      }
    }
    return [...states.values()].filter(state => state.projectId === this.options.projectId).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted history record')
    canonical(value)
    return value as Record<string, unknown>
  }

  private async records(physicalId: string): Promise<Record<string, unknown>[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(physicalId)) throw new Error('Unsafe physical history ID')
    const archived = await this.store.readArchivedLogRange?.(physicalId, 0, 1000)
    if (archived) {
      const records = archived.records.map(record => this.record(record))
      const total = archived.total
      if (!Number.isSafeInteger(total) || total < 0 || records.length > total) throw new Error('Invalid archived history boundary')
      while (records.length < total) {
        const page = await this.store.readArchivedLogRange!(physicalId, records.length, 1000)
        if (!page || page.total !== total || !page.records.length || records.length + page.records.length > total) throw new Error('Archived history changed or missing')
        records.push(...page.records.map(record => this.record(record)))
      }
      return records
    }
    const directory = await this.directory()
    if (this.options.format === 'jsonl') {
      const file = join(directory, `${physicalId}.jsonl`)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe physical history file')
      const bytes = await readFile(file)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      // A torn final physical line is not a committed record boundary.
      if (text && !text.endsWith('\n')) throw new Error('Incomplete physical history line')
      return text.split('\n').filter(line => line.trim()).map(line => this.record(JSON.parse(line)))
    }
    const file = join(directory, 'sessions.db')
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe history database')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rows = db.prepare('SELECT data FROM session_logs WHERE session_id = ? ORDER BY seq ASC').all(physicalId) as { data: string }[]
      if (!rows.length) throw new Error('Missing or unprovable empty SQLite physical segment')
      return rows.map(row => this.record(JSON.parse(row.data)))
    } finally { db.close() }
  }

  async inventory(): Promise<HistoryInventory> {
    const states = await this.states()
    const evidence: unknown[] = []
    const sessions: HistoryInventory['sessions'] = []
    for (const state of states) {
      const segments = []
      for (let segmentIndex = 0; segmentIndex <= state.segmentIndex; segmentIndex++) {
        const physicalId = physicalSessionId(state, segmentIndex)
        const records = await this.records(physicalId)
        segments.push({ physicalId, segmentIndex })
        evidence.push({ physicalId, count: records.length, revision: checksum(canonical(records)) })
      }
      // Required wire metadata only. Epoch means unknown activity, not an
      // inferred creation/update time; selection is exclusively physical.
      const updatedAt = state.lastActivityAt ?? '1970-01-01T00:00:00.000Z'
      if (!Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) throw new Error('Invalid persisted history activity time')
      sessions.push({ sessionId: state.sessionId, updatedAt, segments })
    }
    const after = await this.states()
    if (canonical(states) !== canonical(after)) throw new Error('Persisted history inventory changed during read')
    return { projectId: this.options.projectId, complete: true, revision: checksum(canonical({ states, evidence })), sessions }
  }

  async messages(sessionId: string, physicalId: string): Promise<readonly unknown[]> {
    const state = (await this.states()).find(state => state.sessionId === sessionId)
    if (!state || !Array.from({ length: state.segmentIndex + 1 }, (_, index) => physicalSessionId(state, index)).includes(physicalId)) {
      throw new Error('Physical history does not belong to this Project session')
    }
    return this.records(physicalId)
  }
}
