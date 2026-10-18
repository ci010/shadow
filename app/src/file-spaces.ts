import { t } from './i18n.ts'

/** Physical identifiers belong in workspaceInfo/tooltips, never the primary heading. */
export function sessionWorkspaceLabel(_displayPath: string | null | undefined, _sessionId: string): string {
  return t('Session workspace')
}
