import type { SessionStore } from '../sessions/session-store.ts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { OrganizationCatalog } from './catalog.ts'
import type { WorkdirRefV1 } from '../sessions/locality.ts'

/** Idempotent across both stores; history and physical segment IDs remain unchanged. */
export async function migrateSessionOrganizations(store: SessionStore, organizationId: string): Promise<void> {
  const states = await store.listAllStates()
  for (const state of Object.values(states)) {
    if (state.organizationId && state.organizationId !== organizationId) {
      throw new Error(`Session ${state.sessionId} belongs to another organization`)
    }

  }
  for (const state of Object.values(states)) {
    if (!state.organizationId) await store.saveState(state.sessionId, { ...state, organizationId })
  }
}

export async function migrateHomeSessionOrganizations(home: string, organizationId: string): Promise<void> {
  const directory = join(home, '.sessions')
  try { await stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  await migrateSessionOrganizations(new JsonlSessionStore(directory), organizationId)
  try { await stat(join(directory, 'sessions.db')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const sqlite = new SqliteSessionStore(directory)
  try { await migrateSessionOrganizations(sqlite, organizationId) } finally { sqlite.close() }
}

/** Reserve both persistence formats, including remote sessions migrated before this feature. */
export async function reserveLegacyRemoteSessionWorkdirs(home: string, catalog: OrganizationCatalog, organizationId: string): Promise<void> {
  const directory = join(home, '.sessions')
  try { await stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const refs: WorkdirRefV1[] = []
  const collect = async (store: SessionStore) => {
    for (const state of Object.values(await store.listAllStates())) {
      if (state.workdir && state.workdir.nodeId !== 'local') refs.push(state.workdir)
    }
  }
  await collect(new JsonlSessionStore(directory))
  try { await stat(join(directory, 'sessions.db')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await catalog.reserveLegacyRemoteWorkdirs(organizationId, refs)
    return
  }
  const sqlite = new SqliteSessionStore(directory)
  try { await collect(sqlite) } finally { sqlite.close() }
  await catalog.reserveLegacyRemoteWorkdirs(organizationId, refs)
}
