import { join } from 'node:path'
import { appendFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type {
  SessionState,
  SessionStore,
  StoredMessage,
} from './session-store.ts'
import { streamJsonlObjects } from '../utils/jsonl.ts'
import { readFileIfExists, safeSessionId } from '../utils/paths.ts'
import { parseAutomationSessionRef } from '../cron/contracts.ts'
import { validateOwnership, OwnershipValidationError } from '../projects/ownership.ts'
import { normalizeInitiativeMetadata, InitiativeMetadataError } from './initiative-metadata.ts'
import { parseTopicSessionFields, TopicMetadataError } from './topic-contract.ts'

/**
 * JSONL-file-backed session store.
 *
 * Layout under `sessionsDir`:
 * - `<safeKey>.json`  — active state pointer (JSON)
 * - `<sessionId>.jsonl` — append-only session log (one JSON object per line)
 */
export class JsonlSessionStore implements SessionStore {
  private readonly stateWrites = new Map<string, Promise<void>>()

  constructor(private sessionsDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  // ── State management ────────────────────────────────────────────────────

  async getState(sessionKey: string): Promise<SessionState | null> {
    const raw = await readFileIfExists(this.statePath(sessionKey))
    if (!raw) return null

    try {
      const state = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
      if (!state.sessionId) return null
      if (state.automation !== undefined) state.automation = parseAutomationSessionRef(state.automation)
      Object.assign(state, parseTopicSessionFields(state))
      return state
    } catch (error) {
      if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError) throw error
      return null
    }
  }

  async saveState(sessionKey: string, state: SessionState): Promise<void> {
    state = normalizeInitiativeMetadata(validateOwnership({ ...state, ownershipVersion: state.ownershipVersion ?? 2 })) as unknown as SessionState
    parseAutomationSessionRef(state.automation)
    state = { ...state, ...parseTopicSessionFields(state) }
    const contents = JSON.stringify(state, null, 2)
    await this.queueStateWrite(sessionKey, async () => {
      await mkdir(this.sessionsDir, { recursive: true })
      const staging = `${this.statePath(sessionKey)}.${crypto.randomUUID()}.pending`
      try {
        await writeFile(staging, contents)
        await rename(staging, this.statePath(sessionKey))
      } finally {
        await rm(staging, { force: true })
      }
    })
  }

  async listSessions(): Promise<
    Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
        sessionKind?: SessionState['sessionKind']
        topic?: SessionState['topic']
        createdBySessionId?: string
      }
    >
  > {
    const results: Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
        sessionKind?: SessionState['sessionKind']
        topic?: SessionState['topic']
        createdBySessionId?: string
      }
    > = []
    try {
      for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const raw = await readFileIfExists(join(this.sessionsDir, entry.name))
        if (!raw) continue
        try {
          const parsed = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
          if (!parsed.sessionId) continue
          Object.assign(parsed, parseTopicSessionFields(parsed))
          results.push({
            sessionId: parsed.sessionId,
            segmentIndex: parsed.segmentIndex ?? 0,
            lastActivityAt: parsed.lastActivityAt,
            folderId: typeof parsed.folderId === 'string' ? parsed.folderId : undefined,
            ...parseTopicSessionFields(parsed),
          })
        } catch (error) { if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError) throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return results
  }

  async listAllStates(): Promise<Record<string, SessionState>> {
    const result: Record<string, SessionState> = {}
    try {
      for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const raw = await readFileIfExists(join(this.sessionsDir, entry.name))
        if (!raw) continue
        try {
          const state = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
          if (!state.sessionId) continue
          if (state.automation !== undefined) state.automation = parseAutomationSessionRef(state.automation)
          Object.assign(state, parseTopicSessionFields(state))
          result[state.sessionId] = state
        } catch (error) { if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError) throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return result
  }

  async deleteState(sessionKey: string): Promise<void> {
    await this.queueStateWrite(sessionKey, async () => {
      try {
        await rm(this.statePath(sessionKey))
      } catch { /* ignore */ }
    })
  }

  // ── Session log operations ──────────────────────────────────────────────

  async *readSessionLog(
    sessionId: string,
  ): AsyncIterable<Record<string, unknown>> {
    const filePath = this.logPath(sessionId)
    for await (
      const obj of streamJsonlObjects<Record<string, unknown>>(filePath)
    ) {
      yield obj
    }
  }

  async appendMessages(
    sessionId: string,
    messages: StoredMessage[],
  ): Promise<void> {
    if (messages.length === 0) return
    await mkdir(this.sessionsDir, { recursive: true })
    const filePath = this.logPath(sessionId)
    const lines = messages.map((m) => JSON.stringify(m)).join('\n')
    await appendFile(filePath, `${lines}\n`)
  }

  async createSessionLog(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
    const filePath = this.logPath(sessionId)
    const lines = events.map((e) => JSON.stringify(e)).join('\n')
    await writeFile(filePath, `${lines}\n`)
  }

  async appendRawEvents(
    sessionId: string,
    events: Record<string, unknown>[],
  ): Promise<void> {
    if (events.length === 0) return
    await mkdir(this.sessionsDir, { recursive: true })
    const filePath = this.logPath(sessionId)
    const lines = events.map((e) => JSON.stringify(e)).join('\n')
    await appendFile(filePath, `${lines}\n`)
  }

  async deleteSessionLog(sessionId: string): Promise<void> {
    try {
      await rm(this.logPath(sessionId))
    } catch { /* ignore */ }
  }

  async countSessionLog(sessionId: string): Promise<number> {
    let count = 0
    for await (const _ of streamJsonlObjects<Record<string, unknown>>(this.logPath(sessionId))) {
      count++
    }
    return count
  }

  async readFirstRecord(sessionId: string): Promise<Record<string, unknown> | null> {
    for await (const obj of streamJsonlObjects<Record<string, unknown>>(this.logPath(sessionId))) {
      return obj
    }
    return null
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async queueStateWrite(sessionKey: string, operation: () => Promise<void>): Promise<void> {
    const path = this.statePath(sessionKey)
    const previous = this.stateWrites.get(path) ?? Promise.resolve()
    // Windows cannot atomically replace the same destination in parallel.
    const pending = previous.catch(() => {}).then(operation)
    this.stateWrites.set(path, pending)
    try { await pending }
    finally { if (this.stateWrites.get(path) === pending) this.stateWrites.delete(path) }
  }

  private statePath(sessionKey: string): string {
    return join(this.sessionsDir, `${safeSessionId(sessionKey)}.json`)
  }

  private logPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`)
  }

}
