import { join } from 'node:path'
import { appDataPaths, projectDataPaths } from '../utils/data-paths.ts'

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
  const root = join(appDataPaths(hostHome).projects, projectId)
  return { root, home: root, configPath: join(projectDataPaths(root).config, 'project.json') }
}

export function projectBasePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/`
}
