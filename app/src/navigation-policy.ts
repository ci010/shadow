import type {
  InstallationMode,
  UiScope,
} from './installation-context.ts'

export type NavigationGroup = 'primary' | 'diagnostics'
export type AppRouteName =
  | 'chat'
  | 'nodes'
  | 'settings'
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
    modes: ['main', 'child', 'client'],
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
    name: 'settings',
    label: 'Settings',
    group: 'primary',
    scopes: ['main:admin'],
    modes: ['main', 'client'],
  },
  {
    name: 'spans',
    label: 'Spans',
    group: 'diagnostics',
    scopes: ['audit:read'],
    modes: ['main', 'child', 'client'],
  },
  {
    name: 'logs',
    label: 'Logs',
    group: 'diagnostics',
    scopes: ['audit:read'],
    modes: ['main', 'child', 'client'],
  },
]

export function navigationFor(
  context: { readonly mode: InstallationMode; readonly uiScopes: readonly UiScope[] },
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