import { storageValidationFrames } from './storage-validation-diagnostics.ts'
import { measureStartupProfile, profileStartupPhase, startupProjectOrdinal } from '../runtime/startup-profile.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import { stat, readFile } from 'node:fs/promises'
import { parseStoredCronJobs } from '../cron/service.ts'
import { join } from 'node:path'
import { FreshAutomationStateStore } from '../sessions/fresh-automation-state.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { ProjectCatalog } from './catalog.ts'
import type { WorkdirRefV2 } from '../sessions/locality.ts'
import { isManagedWorkdir } from '../execution/managed-workdir.ts'

/** Loading a Project never adopts an unowned or foreign session. */
export async function assertSessionProjectOwnership(store: SessionStore, projectId: string): Promise<void> {
  assertStatesOwnership(await store.listAllStates(), projectId)
  for (const ref of await store.listArchiveReferences?.() ?? []) {
    if (ref.projectId !== projectId) throw new Error('Archived session does not belong to project ' + projectId)
  }
}

function assertStatesOwnership(states: Record<string, SessionState>, projectId: string): void {
  for (const state of Object.values(states)) {
    if (state.projectId !== projectId) {
      throw new Error(`Session ${state.sessionId} does not belong to project ${projectId}`)
    }
  }
}

export interface StartupOwnershipStates {
  jsonl?: Record<string, SessionState>
  sqlite?: Record<string, SessionState>
}

// Only fixed classifications may cross the diagnostic boundary. In particular,
// JSON parser messages, stacks, arbitrary codes and thrown values are private.
function ownershipErrorClass(error: unknown): string {
  try {
    const { code, name } = error as { code?: unknown; name?: unknown }
    if (typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EISDIR', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'ERR_SQLITE_ERROR'].includes(code)) return code
    if (typeof name === 'string' && ['SyntaxError', 'TypeError', 'RangeError', 'Error', 'OwnershipValidationError', 'SessionIdentityError'].includes(name)) return name
  } catch { /* Null, primitives and hostile accessors are unknown errors. */ }
  return 'unknown'
}

/** Reserve current-format workdirs from both stores before admitting new remote folders. */
export async function reserveRemoteSessionWorkdirs(home: string, catalog: ProjectCatalog, projectId: string, snapshot?: StartupOwnershipStates): Promise<void> {
  const directory = projectStoragePath(home, '.sessions')
  const detail = { projectOrdinal: startupProjectOrdinal(projectId) }
  let stage: 'cron' | 'sessions' | 'jsonl' | 'sqlite' | 'ownership' | 'reserve' = 'cron'
  let source: 'cron' | 'sessions' | 'jsonl' | 'sqlite' | 'catalog' = 'cron'
  const reserve = () => {
    stage = 'reserve'
    source = 'catalog'
    return measureStartupProfile('ownership-reserve', () => catalog.reserveRemoteWorkdirs(projectId, refs), detail)
  }
  const refs: WorkdirRefV2[] = []
  const scan = async () => {
    // Cron-only saved targets reserve ownership too, including disabled jobs. Do not
    // return early merely because this Project has never materialized a session.
    let cron: string | undefined
    try { cron = await readFile(projectStoragePath(home, '.cron/jobs.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (cron !== undefined) for (const job of parseStoredCronJobs(JSON.parse(cron), projectId).jobs) {
      if (job.workdir && job.workdir.nodeId !== 'local' && !isManagedWorkdir(job.workdir.workdirId)) refs.push(job.workdir)
    }
    stage = 'sessions'
    source = 'sessions'
    try { await stat(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await reserve()
      return
    }
    const collect = async (createStore: () => Pick<SessionStore, 'listAllStates' | 'listArchiveReferences' | 'close'>, phase: 'ownership-jsonl' | 'ownership-sqlite') => {
      source = phase === 'ownership-jsonl' ? 'jsonl' : 'sqlite'
      stage = source
      profileStartupPhase(phase, 'started', detail)
      try {
        // Include store construction/open and close, not just listAllStates.
        const store = createStore()
        let count = 0
        try {
          const states = await store.listAllStates()
          stage = 'ownership'
          assertStatesOwnership(states, projectId)
          stage = source
          if (snapshot) snapshot[phase === 'ownership-jsonl' ? 'jsonl' : 'sqlite'] = structuredClone(states)
          for (const state of Object.values(states)) {
            count++
            if (state.workdir && state.workdir.nodeId !== 'local' && !isManagedWorkdir(state.workdir.workdirId)) refs.push(state.workdir)
          }
          for (const ref of await store.listArchiveReferences?.() ?? []) {
            stage = 'ownership'
            if (ref.projectId !== projectId) throw new Error('Archived session does not belong to project ' + projectId)
            stage = source
            if (ref.workdir && ref.workdir.nodeId !== 'local' && !isManagedWorkdir(ref.workdir.workdirId)) refs.push(ref.workdir)
          }
        } finally { store.close?.() }
        profileStartupPhase(phase, 'completed', { ...detail, count })
      } catch (error) {
        profileStartupPhase(phase, 'failed', detail)
        throw error
      }
    }
    await collect(() => new JsonlSessionStore(directory), 'ownership-jsonl')
    stage = 'sqlite'
    source = 'sqlite'
    try { await stat(join(directory, 'sessions.db')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await collect(() => {
        const fresh = new FreshAutomationStateStore(directory, 'sqlite', true)
        return { listAllStates: () => fresh.listActive(), listArchiveReferences: () => fresh.references(), close: () => fresh.close() }
      }, 'ownership-sqlite')
      await reserve()
      return
    }
    await collect(() => new SqliteSessionStore(directory), 'ownership-sqlite')
    await reserve()
  }
  try { await scan() } catch (error) {
    // Logging cannot change fail-closed behavior or replace the original error.
    try {
      const frames = storageValidationFrames(error)
      console.error(`[projects] session_storage_validation_failed stage=${stage} source=${source} error=${ownershipErrorClass(error)}${frames.length ? ` frames=${frames.join(',')}` : ''}`)
    } catch { /* Diagnostic sink unavailable. */ }
    throw error
  }
}
