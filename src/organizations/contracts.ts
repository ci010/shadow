import { join } from 'node:path'

export const DEFAULT_ORGANIZATION_ID = 'default'

export interface OrganizationRecord {
  id: string
  name: string
  createdAt: string
}

export interface SessionRef {
  organizationId: string
  sessionId: string
}

export function organizationPaths(hostHome: string, organizationId: string) {
  if (!/^(?:default|[0-9a-f]{8}-[0-9a-f-]{27})$/.test(organizationId)) {
    throw new TypeError('Invalid organization ID')
  }
  const root = join(hostHome, 'organizations', organizationId)
  return { root, home: join(root, 'workspace'), configPath: join(root, 'config', 'organization.json') }
}

export function organizationBasePath(organizationId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/`
}
