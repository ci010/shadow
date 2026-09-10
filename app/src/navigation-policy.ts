import type {
  InstallationContextV1,
  InstallationMode,
  UiScope,
} from './installation-context.ts'

export type NavigationGroup = 'primary' | 'diagnostics'
export type AppRouteName =
  | 'chat'
  | 'workspaces'
  | 'nodes'
  | 'approvals'
  | 'agents'
  | 'spans'
  | 'logs'

export interface NavigationItem {
  name: AppRouteName
  label: string
  group: NavigationGroup
}

interface NavigationPolicyItem extends NavigationItem {
  scopes: readonly UiScope[]
  modes: readonly InstallationMode[]
  childLocal?: boolean
}

const NAVIGATION_POLICY: readonly NavigationPolicyItem[] = [
  {
    name: 'chat',
    label: 'Chat',
    group: 'primary',
    scopes: ['chat:read'],
    modes: ['main', 'child'],
  },
  {
    name: 'workspaces',
    label: 'Workspaces',
    group: 'primary',
    scopes: ['chat:read'],
    modes: ['main', 'child'],
  },
  {
    name: 'nodes',
    label: 'Nodes',
    group: 'primary',
    scopes: ['nodes:admin'],
    modes: ['main', 'child'],
    childLocal: true,
  },
  {
    name: 'approvals',
    label: 'Approvals',
    group: 'primary',
    scopes: [],
    modes: ['child'],
    childLocal: true,
  },
  {
    name: 'agents',
    label: 'Agents',
    group: 'diagnostics',
    scopes: ['main:admin'],
    modes: ['main', 'child'],
  },
  {
    name: 'spans',
    label: 'Spans',
    group: 'diagnostics',
    scopes: ['audit:read'],
    modes: ['main', 'child'],
  },
  {
    name: 'logs',
    label: 'Logs',
    group: 'diagnostics',
    scopes: ['audit:read'],
    modes: ['main', 'child'],
  },
]

export function navigationFor(
  context: Pick<InstallationContextV1, 'mode' | 'uiScopes'>,
): NavigationItem[] {
  const scopes = new Set(context.uiScopes)

  return NAVIGATION_POLICY
    .filter((item) =>
      item.modes.includes(context.mode) &&
      (
        (item.childLocal === true && context.mode === 'child') ||
        item.scopes.some((scope) => scopes.has(scope))
      )
    )
    .map(({ name, label, group }) => ({ name, label, group }))
}