import type { WorkdirRefV1 } from '../sessions/locality.ts'
import type { WorkdirIdentityV1 } from '../execution/workdir-identity.ts'

interface ProjectBase {
  organizationId?: string
  id: string
  name: string
  path: string
  createdAt: string
}

export interface LocalProjectRecord extends ProjectBase {
  kind?: 'local'
}

export interface RemoteProjectRecord extends ProjectBase {
  kind: 'remote'
  /** Display metadata only. Never resolve this path on Main. */
  path: string
  workdir: WorkdirRefV1
  identity: WorkdirIdentityV1
}

export type ProjectRecord = LocalProjectRecord | RemoteProjectRecord

export interface CloneOperation {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  destination: string
  project?: ProjectRecord
  error?: string
}
