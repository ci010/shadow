import { join } from 'node:path'
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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

/**
 * JSONL-file-backed session store.
 *
 * Layout under `sessionsDir`:
 * - `<safeKey>.json`  — active state pointer (JSON)
 * - `<sessionId>.jsonl` — append-only session log (one JSON object per line)
 */
export class JsonlSessionStore implements SessionStore {
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
      return state
    } catch (error) {
      if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError) throw error
      return null
    }
  }

  async saveState(sessionKey: string, state: SessionState): Promise<void> {
    state = normalizeInitiativeMetadata(validateOwnership({ ...state, ownershipVersion: state.ownershipVersion ?? 2 })) as unknown as SessionState
    parseAutomationSessionRef(state.automation)
    await mkdir(this.sessionsDir, { recursive: true })
    await writeFile(
      this.statePath(sessionKey),
      JSON.stringify(state, null, 2),
    )
  }

  async listSessions(): Promise<
    Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
      }
    >
  > {
    const results: Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
        folderId?: string
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
          results.push({
            sessionId: parsed.sessionId,
            segmentIndex: parsed.segmentIndex ?? 0,
            lastActivityAt: parsed.lastActivityAt,
            folderId: typeof parsed.folderId === 'string' ? parsed.folderId : undefined,
          })
        } catch (error) { if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError) throw error }
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
          result[state.sessionId] = state
        } catch (error) { if (error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError) throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return result
  }

  async deleteState(sessionKey: string): Promise<void> {
    try {
      await rm(this.statePath(sessionKey))
    } catch { /* ignore */ }
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

  private statePath(sessionKey: string): string {
    return join(this.sessionsDir, `${safeSessionId(sessionKey)}.json`)
  }

  private logPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`)
  }

}
