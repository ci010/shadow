import { join } from 'node:path'
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import type {
  SessionState,
  SessionStore,
  StoredMessage,
} from './session-store.ts'
import { streamJsonlObjects } from '../utils/jsonl.ts'
import { readFileIfExists, safeSessionId } from '../utils/paths.ts'

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
      const state = JSON.parse(raw) as SessionState
      if (!state.sessionId) return null
      return state
    } catch {
      return null
    }
  }

  async saveState(sessionKey: string, state: SessionState): Promise<void> {
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
      }
    >
  > {
    const results: Array<
      {
        sessionId: string
        segmentIndex: number
        lastActivityAt?: string
      }
    > = []
    try {
      for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const raw = await readFileIfExists(join(this.sessionsDir, entry.name))
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw) as SessionState
          if (!parsed.sessionId) continue
          results.push({
            sessionId: parsed.sessionId,
            segmentIndex: parsed.segmentIndex ?? 0,
            lastActivityAt: parsed.lastActivityAt,
          })
        } catch { /* skip malformed */ }
      }
    } catch { /* dir may not exist yet */ }
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
          const state = JSON.parse(raw) as SessionState
          if (!state.sessionId) continue
          result[state.sessionId] = state
        } catch { /* skip malformed */ }
      }
    } catch { /* dir may not exist yet */ }
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
