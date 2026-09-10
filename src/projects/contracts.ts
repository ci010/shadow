export interface ProjectRecord {
  id: string
  name: string
  path: string
  createdAt: string
}

export interface CloneOperation {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  destination: string
  project?: ProjectRecord
  error?: string
}
