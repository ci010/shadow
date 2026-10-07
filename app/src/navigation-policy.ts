import { t } from './i18n.ts'
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
    get label() { return t('Chat') },
    group: 'primary',
    scopes: ['chat:read'],
    modes: ['main', 'child', 'client'],
  },
  {
    name: 'nodes',
    get label() { return t('Nodes') },
    group: 'primary',
    scopes: ['nodes:admin'],
    modes: ['main', 'child'],
    childLocal: true,
  },
  {
    name: 'settings',
    get label() { return t('Settings') },
    group: 'primary',
    scopes: ['main:admin'],
    modes: ['main', 'client'],
  },
  {
    name: 'spans',
    get label() { return t('Spans') },
    group: 'diagnostics',
    scopes: ['audit:read'],
    modes: ['main', 'child', 'client'],
  },
  {
    name: 'logs',
    get label() { return t('Logs') },
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