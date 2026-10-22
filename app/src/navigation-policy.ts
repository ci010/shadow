import { t } from './i18n.ts'
import type {
  InstallationMode,
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

const NAVIGATION_POLICY: readonly NavigationItem[] = [
  {
    name: 'chat',
    get label() { return t('Chat') },
    group: 'primary',
  },
  {
    name: 'settings',
    get label() { return t('Settings') },
    group: 'primary',
  },
  {
    name: 'spans',
    get label() { return t('Spans') },
    group: 'diagnostics',
  },
  {
    name: 'logs',
    get label() { return t('Logs') },
    group: 'diagnostics',
  },
]

// Authentication establishes management access. Mode only selects local surfaces;
// connection availability and backend route restrictions are enforced separately.
export function navigationFor(
  _context: { readonly mode: InstallationMode },
): NavigationItem[] {
  return NAVIGATION_POLICY.map(({ name, label, group }) => ({ name, label, group }))
}
