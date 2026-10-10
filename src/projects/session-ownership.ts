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
}

function assertStatesOwnership(states: Record<string, SessionState>, projectId: string): void {
  for (const state of Object.values(states)) {
    if (state.projectId !== projectId) {
      throw new Error(`Session ${state.sessionId} does not belong to project ${projectId}`)
    }
  }
}

/** Reserve current-format workdirs from both stores before admitting new remote folders. */
export async function reserveRemoteSessionWorkdirs(home: string, catalog: ProjectCatalog, projectId: string): Promise<void> {
  const directory = join(home, '.sessions')
  try { await stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const refs: WorkdirRefV1[] = []
  const collect = async (store: SessionStore) => {
    const states = await store.listAllStates()
    assertStatesOwnership(states, projectId)
    for (const state of Object.values(states)) {
      if (state.workdir && state.workdir.nodeId !== 'local' && !isManagedWorkdir(state.workdir.capabilityId)) refs.push(state.workdir)
    }
  }
  await collect(new JsonlSessionStore(directory))
  try { await stat(join(directory, 'sessions.db')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await catalog.reserveRemoteWorkdirs(projectId, refs)
    return
  }
  const sqlite = new SqliteSessionStore(directory)
  try { await collect(sqlite) } finally { sqlite.close() }
  await catalog.reserveRemoteWorkdirs(projectId, refs)
}
