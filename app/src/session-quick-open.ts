export interface QuickOpenSession {
  projectId: string
  sessionId: string
  title?: string
  label: string
  lastActivityAt?: string
}

/** All whitespace-delimited tokens must occur in a human title or label. */
export function matchesSessionTitle(session: Pick<QuickOpenSession, 'title' | 'label'>, query: string): boolean {
  const fields = [session.title ?? '', session.label].map(value => value.toLocaleLowerCase())
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    .every(token => fields.some(field => field.includes(token)))
}

export function searchQuickOpenSessions<T extends QuickOpenSession>(sessions: readonly T[], query: string): T[] {
  const prefix = query.trim().toLocaleLowerCase()
  const isPrefix = (session: T) => [session.title ?? '', session.label]
    .some(field => field.toLocaleLowerCase().startsWith(prefix))
  const recency = (session: T) => {
    const time = Date.parse(session.lastActivityAt ?? '')
    return Number.isFinite(time) ? time : 0
  }
  return sessions.filter(session => matchesSessionTitle(session, query)).sort((a, b) =>
    Number(isPrefix(b)) - Number(isPrefix(a)) || recency(b) - recency(a)
    || a.projectId.localeCompare(b.projectId) || a.sessionId.localeCompare(b.sessionId))
}

export function isSessionQuickOpenShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey
    && event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'
}
