export interface ProjectSidebarPreferences {
  width: number
  collapsed: boolean
}

export const DEFAULT_PROJECT_SIDEBAR: ProjectSidebarPreferences = { width: 270, collapsed: false }

export function projectSidebarStorageKey(apiBase: string): string {
  return `shadow:projects-sidebar:${apiBase}`
}

export function restoreProjectSidebarPreferences(storage: Pick<Storage, 'getItem'>, apiBase: string): ProjectSidebarPreferences {
  return parseProjectSidebarPreferences(storage.getItem(projectSidebarStorageKey(apiBase)))
}

export function parseProjectSidebarPreferences(raw: string | null): ProjectSidebarPreferences {
  if (raw === null) return { ...DEFAULT_PROJECT_SIDEBAR }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('width' in value) || typeof value.width !== 'number'
    || !Number.isFinite(value.width) || !('collapsed' in value) || typeof value.collapsed !== 'boolean') {
    throw new TypeError('Invalid project sidebar preferences')
  }
  return { width: Math.max(200, Math.min(440, Math.round(value.width))), collapsed: value.collapsed }
}
