export interface OrganizationSidebarPreferences {
  width: number
  collapsed: boolean
}

export const DEFAULT_ORGANIZATION_SIDEBAR: OrganizationSidebarPreferences = { width: 270, collapsed: false }

export function parseOrganizationSidebarPreferences(raw: string | null): OrganizationSidebarPreferences {
  if (raw === null) return { ...DEFAULT_ORGANIZATION_SIDEBAR }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('width' in value) || typeof value.width !== 'number'
    || !Number.isFinite(value.width) || !('collapsed' in value) || typeof value.collapsed !== 'boolean') {
    throw new TypeError('Invalid organization sidebar preferences')
  }
  return { width: Math.max(200, Math.min(440, Math.round(value.width))), collapsed: value.collapsed }
}
