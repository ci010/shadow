import { t } from './i18n.ts'
import type {
  InstallationMode,
} from './installation-context.ts'

export type AppRouteName =
  | 'chat'
  | 'usage'
  | 'settings'

export interface NavigationItem {
  name: AppRouteName
  label: string
}

const NAVIGATION_POLICY: readonly NavigationItem[] = [
  {
    name: 'chat',
    get label() { return t('Chat') },
  },
  { name: 'usage', get label() { return t('Usage') } },
  {
    name: 'settings',
    get label() { return t('Settings') },
  },
]

// Authentication establishes management access. Mode only selects local surfaces;
// connection availability and backend route restrictions are enforced separately.
export function navigationFor(
  _context: { readonly mode: InstallationMode },
): NavigationItem[] {
  return NAVIGATION_POLICY.map(({ name, label }) => ({ name, label }))
}
