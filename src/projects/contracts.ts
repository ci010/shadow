import { join } from 'node:path'

export const DEFAULT_PROJECT_ID = 'default'

export interface ProjectRecord {
  id: string
  name: string
  createdAt: string
}

export interface SessionRef {
  projectId: string
  sessionId: string
}

export function projectPaths(hostHome: string, projectId: string) {
  if (!/^(?:default|[0-9a-f]{8}-[0-9a-f-]{27})$/.test(projectId)) {
    throw new TypeError('Invalid project ID')
  }
  const root = join(hostHome, 'projects', projectId)
  return { root, home: join(root, 'workspace'), configPath: join(root, 'config', 'project.json') }
}

export function projectBasePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/`
}
