import type { WorkdirRefV1 } from '../sessions/locality.ts'
import type { WorkdirIdentityV1 } from '../execution/workdir-identity.ts'

interface FolderBase {
  projectId?: string
  id: string
  name: string
  path: string
  createdAt: string
}

export interface LocalFolderRecord extends FolderBase {
  kind?: 'local'
}

export interface RemoteFolderRecord extends FolderBase {
  kind: 'remote'
  /** Display metadata only. Never resolve this path on Main. */
  path: string
  workdir: WorkdirRefV1
  identity: WorkdirIdentityV1
}

export type FolderRecord = LocalFolderRecord | RemoteFolderRecord

export interface CloneOperation {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  destination: string
  folder?: FolderRecord
  error?: string
}
