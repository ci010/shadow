export interface QuickOpenSession {
  projectId: string
  sessionId: string
  title?: string
  label: string
  lastActivityAt?: string
  mode?: 'session' | 'task' | 'call'
  parentSessionId?: string | null
  createdBySessionId?: string
  automation?: unknown
}

/** All whitespace-delimited tokens must occur in a human title or label. */
export function matchesSessionTitle(session: Pick<QuickOpenSession, 'title' | 'label'>, query: string): boolean {
  const fields = [session.title ?? '', session.label].map(value => value.toLocaleLowerCase())
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    .every(token => fields.some(field => field.includes(token)))
}

/** Only ordinary root conversations belong in quick navigation. */
export function isRegularQuickOpenSession(session: QuickOpenSession): boolean {
  return session.mode !== 'task' && session.mode !== 'call'
    && !session.parentSessionId && !session.createdBySessionId && !session.automation
}

export function searchQuickOpenSessions<T extends QuickOpenSession>(sessions: readonly T[], query: string,
  projectOrder: readonly string[] = [...new Set(sessions.map(session => session.projectId))]): T[] {
  const projectRank = new Map(projectOrder.map((id, index) => [id, index]))
  const rank = (session: T) => projectRank.get(session.projectId) ?? projectOrder.length
  const prefix = query.trim().toLocaleLowerCase()
  const isPrefix = (session: T) => [session.title ?? '', session.label]
    .some(field => field.toLocaleLowerCase().startsWith(prefix))
  const recency = (session: T) => {
    const time = Date.parse(session.lastActivityAt ?? '')
    return Number.isFinite(time) ? time : 0
  }
  return sessions.filter(session => isRegularQuickOpenSession(session) && matchesSessionTitle(session, query)).sort((a, b) =>
    rank(a) - rank(b) || a.projectId.localeCompare(b.projectId) || Number(isPrefix(b)) - Number(isPrefix(a)) || recency(b) - recency(a)
    || a.sessionId.localeCompare(b.sessionId))
}

export function isSessionQuickOpenShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey
    && event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'
}
