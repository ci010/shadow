import { measureStartupProfile, profileStartupPhase, startupProjectOrdinal } from '../runtime/startup-profile.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import type { SessionState, SessionStore } from '../sessions/session-store.ts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { ProjectCatalog } from './catalog.ts'
import type { WorkdirRefV1 } from '../sessions/locality.ts'
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
  try { await stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const detail = { projectOrdinal: startupProjectOrdinal(projectId) }
  const reserve = () => measureStartupProfile('ownership-reserve', () => catalog.reserveRemoteWorkdirs(projectId, refs), detail)
  const refs: WorkdirRefV1[] = []
  const collect = async (createStore: () => SessionStore, phase: 'ownership-jsonl' | 'ownership-sqlite') => {
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
          if (state.workdir && state.workdir.nodeId !== 'local' && !isManagedWorkdir(state.workdir.capabilityId)) refs.push(state.workdir)
        }
        for (const ref of await store.listArchiveReferences?.() ?? []) {
          if (ref.projectId !== projectId) throw new Error('Archived session does not belong to project ' + projectId)
          if (ref.workdir && ref.workdir.nodeId !== 'local' && !isManagedWorkdir(ref.workdir.capabilityId)) refs.push(ref.workdir)
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
    await reserve()
    return
  }
  await collect(() => new SqliteSessionStore(directory), 'ownership-sqlite')
  await reserve()
}
