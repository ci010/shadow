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

/** Reserve current-format workdirs from both stores before admitting new remote folders. */
export async function reserveRemoteSessionWorkdirs(home: string, catalog: ProjectCatalog, projectId: string, snapshot?: StartupOwnershipStates): Promise<void> {
  const directory = projectStoragePath(home, '.sessions')
  const detail = { projectOrdinal: startupProjectOrdinal(projectId) }
  const reserve = () => measureStartupProfile('ownership-reserve', () => catalog.reserveRemoteWorkdirs(projectId, refs), detail)
  const refs: WorkdirRefV2[] = []
  // Cron-only saved targets reserve ownership too, including disabled jobs. Do not
  // return early merely because this Project has never materialized a session.
  let cron: string | undefined
  try { cron = await readFile(projectStoragePath(home, '.cron/jobs.json'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (cron !== undefined) for (const job of parseStoredCronJobs(JSON.parse(cron), projectId).jobs) {
    if (job.workdir && job.workdir.nodeId !== 'local' && !isManagedWorkdir(job.workdir.workdirId)) refs.push(job.workdir)
  }
  try { await stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await reserve()
    return
  }
  const collect = async (createStore: () => Pick<SessionStore, 'listAllStates' | 'listArchiveReferences' | 'close'>, phase: 'ownership-jsonl' | 'ownership-sqlite') => {
    profileStartupPhase(phase, 'started', detail)
    try {
      // Include store construction/open and close, not just listAllStates.
      const store = createStore()
      let count = 0
      try {
        const states = await store.listAllStates()
        assertStatesOwnership(states, projectId)
        if (snapshot) snapshot[phase === 'ownership-jsonl' ? 'jsonl' : 'sqlite'] = structuredClone(states)
        for (const state of Object.values(states)) {
          count++
          if (state.workdir && state.workdir.nodeId !== 'local' && !isManagedWorkdir(state.workdir.workdirId)) refs.push(state.workdir)
        }
        for (const ref of await store.listArchiveReferences?.() ?? []) {
          if (ref.projectId !== projectId) throw new Error('Archived session does not belong to project ' + projectId)
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
