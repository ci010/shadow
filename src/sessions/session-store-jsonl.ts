import { FreshAutomationStateStore } from './fresh-automation-state.ts'
import { join } from 'node:path'
import { readStatePool } from './state-read-pool.ts'
import { appendFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { parseSessionName, SessionNameError } from './session-name.ts'
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
import { parsePhysicalIdVersion, SessionIdentityError } from './session-identity.ts'
import { parseWorkPolicy, WorkPolicyError } from './work-policy.ts'
import { parseContextResetAt, ContextResetMetadataError, parseDecisionOwner, DecisionOwnerMetadataError } from './session-store.ts'
import { parseChannelBoundary, ChannelBoundaryMetadataError } from '../channels/integration-contract.ts'

/**
 * JSONL-file-backed session store.
 *
 * Layout under `sessionsDir`:
 * - `<safeKey>.json`  — active state pointer (JSON)
 * - `<sessionId>.jsonl` — append-only session log (one JSON object per line)
 */
export class JsonlSessionStore implements SessionStore {
  private readonly stateWrites = new Map<string, Promise<void>>()

  private readonly fresh: FreshAutomationStateStore
  constructor(private sessionsDir: string) { this.fresh = new FreshAutomationStateStore(sessionsDir, 'jsonl') }
  readArchivedState = (id: string) => this.fresh.archived(id)
  queryArchivedStates = (query?: import('./session-store.ts').ArchivedStateQuery) => this.fresh.query(query)
  countArchivedStates = (query?: import('./session-store.ts').ArchivedStateQuery) => this.fresh.count(query)
  archiveFeatureStates = (projectId?: string) => this.fresh.features(projectId)
  archiveState = (state: SessionState) => this.fresh.archive(state)
  listArchiveReferences = () => this.fresh.references()
  close(): void { this.fresh.close() }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  // ── State management ────────────────────────────────────────────────────

  async getState(sessionKey: string): Promise<SessionState | null> {
    const active = await this.fresh.getActive(sessionKey)
    if (active) return active
    const raw = await readFileIfExists(this.statePath(sessionKey))
    if (!raw) return null

    try {
      const state = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
      if (!state.sessionId) return null
      if (state.generatedTitle !== undefined) state.generatedTitle = parseSessionName(state.generatedTitle)
      if (state.name !== undefined) state.name = parseSessionName(state.name)
      if (state.chatName !== undefined) state.chatName = parseSessionName(state.chatName)
      parsePhysicalIdVersion(state.physicalIdVersion)
      parseContextResetAt(state.contextResetAt)
      parseChannelBoundary(state.channelBoundary)
      parseDecisionOwner(state.decisionOwnerSessionId)
      if (state.workPolicy !== undefined) state.workPolicy = parseWorkPolicy(state.workPolicy)
      if (state.automation !== undefined) state.automation = parseAutomationSessionRef(state.automation)
      Object.assign(state, parseTopicSessionFields(state))
      return state
    } catch (error) {
      if (error instanceof ChannelBoundaryMetadataError || error instanceof WorkPolicyError || error instanceof SessionNameError || error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError || error instanceof SessionIdentityError || error instanceof ContextResetMetadataError || error instanceof DecisionOwnerMetadataError) throw error
      return null
    }
  }

  async saveState(sessionKey: string, state: SessionState): Promise<void> {
    if (state.statePersistence) {
      if (sessionKey !== state.sessionId) throw new Error('Fresh automation key mismatch')
      if (await readFileIfExists(this.statePath(sessionKey))) throw new Error('Existing legacy state cannot opt into fresh automation persistence')
      return this.fresh.save(state)
    }
    if (await this.fresh.has(sessionKey)) throw new Error('Fresh automation policy cannot be removed')
    if (state.generatedTitle !== undefined) state = { ...state, generatedTitle: parseSessionName(state.generatedTitle) }
    if (state.name !== undefined) state = { ...state, name: parseSessionName(state.name) }
    if (state.chatName !== undefined) state = { ...state, chatName: parseSessionName(state.chatName) }
    state = normalizeInitiativeMetadata(validateOwnership({ ...state, ownershipVersion: state.ownershipVersion ?? 2 })) as unknown as SessionState
    parseAutomationSessionRef(state.automation)
    parsePhysicalIdVersion(state.physicalIdVersion)
    parseContextResetAt(state.contextResetAt)
    parseChannelBoundary(state.channelBoundary)
    parseDecisionOwner(state.decisionOwnerSessionId)
    state = { ...state, workPolicy: parseWorkPolicy(state.workPolicy) }
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
    const results: Array<
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
    > = []
    try {
      const entries = (await readdir(this.sessionsDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      const reads = await readStatePool(entries, async entry => {
        try { return { raw: await readFileIfExists(join(this.sessionsDir, entry.name)) } }
        catch (error) { return { error } }
      })
      for (const read of reads) {
        // Apply I/O and validation errors in directory order, as in the serial reader.
        if ('error' in read) throw read.error
        const raw = read.raw
        if (!raw) continue
        try {
          const parsed = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
          if (!parsed.sessionId) continue
          if (parsed.name !== undefined) parsed.name = parseSessionName(parsed.name)
          if (parsed.chatName !== undefined) parsed.chatName = parseSessionName(parsed.chatName)
          parsePhysicalIdVersion(parsed.physicalIdVersion)
          parseContextResetAt(parsed.contextResetAt)
          parseChannelBoundary(parsed.channelBoundary)
          parseWorkPolicy(parsed.workPolicy)
          Object.assign(parsed, parseTopicSessionFields(parsed))
          results.push({
            sessionId: parsed.sessionId,
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            segmentIndex: parsed.segmentIndex ?? 0,
            lastActivityAt: parsed.lastActivityAt,
            folderId: typeof parsed.folderId === 'string' ? parsed.folderId : undefined,
            ...parseTopicSessionFields(parsed),
          })
        } catch (error) { if (error instanceof ChannelBoundaryMetadataError || error instanceof WorkPolicyError || error instanceof SessionNameError || error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError || error instanceof SessionIdentityError || error instanceof ContextResetMetadataError) throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    results.push(...await this.fresh.summaries())
    return results
  }

  async listAllStates(): Promise<Record<string, SessionState>> {
    const result: Record<string, SessionState> = {}
    try {
      const entries = (await readdir(this.sessionsDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      const reads = await readStatePool(entries, async entry => {
        try { return { raw: await readFileIfExists(join(this.sessionsDir, entry.name)) } }
        catch (error) { return { error } }
      })
      for (const read of reads) {
        // Apply I/O and validation errors in directory order, as in the serial reader.
        if ('error' in read) throw read.error
        const raw = read.raw
        if (!raw) continue
        try {
          const state = normalizeInitiativeMetadata(validateOwnership(JSON.parse(raw))) as unknown as SessionState
          if (!state.sessionId) continue
          if (state.generatedTitle !== undefined) state.generatedTitle = parseSessionName(state.generatedTitle)
          if (state.name !== undefined) state.name = parseSessionName(state.name)
          if (state.chatName !== undefined) state.chatName = parseSessionName(state.chatName)
          parsePhysicalIdVersion(state.physicalIdVersion)
          parseContextResetAt(state.contextResetAt)
          parseChannelBoundary(state.channelBoundary)
          if (state.workPolicy !== undefined) state.workPolicy = parseWorkPolicy(state.workPolicy)
          if (state.automation !== undefined) state.automation = parseAutomationSessionRef(state.automation)
          Object.assign(state, parseTopicSessionFields(state))
          result[state.sessionId] = state
        } catch (error) { if (error instanceof ChannelBoundaryMetadataError || error instanceof WorkPolicyError || error instanceof SessionNameError || error instanceof OwnershipValidationError || error instanceof InitiativeMetadataError || error instanceof TopicMetadataError || error instanceof SessionIdentityError || error instanceof ContextResetMetadataError) throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    Object.assign(result, await this.fresh.listActive())
    return result
  }

  async deleteState(sessionKey: string): Promise<void> {
    if (await this.fresh.has(sessionKey)) throw new Error('Fresh automation history deletion is not supported')
    await this.queueStateWrite(sessionKey, async () => {
      await rm(this.statePath(sessionKey), { force: true })
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
    await rm(this.logPath(sessionId), { force: true })
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
