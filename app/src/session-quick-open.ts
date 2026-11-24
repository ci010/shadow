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
  projectOrder: readonly string[] = [...new Set(sessions.map(session => session.projectId))], projectFilter = ''): T[] {
  const projectRank = new Map(projectOrder.map((id, index) => [id, index]))
  const rank = (session: T) => projectRank.get(session.projectId) ?? projectOrder.length
  const prefix = query.trim().toLocaleLowerCase()
  const tokens = prefix ? prefix.split(/\s+/u) : []
  const matches: Array<{ session: T; prefixMatch: number; recency: number }> = []
  for (const session of sessions) {
    if (projectFilter && session.projectId !== projectFilter) continue
    if (!isRegularQuickOpenSession(session) && !(prefix && session.automation)) continue
    const fields = prefix ? [session.title ?? '', session.label].map(value => value.toLocaleLowerCase()) : []
    if (!tokens.every(token => fields.some(field => field.includes(token)))) continue
    const time = Date.parse(session.lastActivityAt ?? '')
    matches.push({ session, prefixMatch: Number(fields.some(field => field.startsWith(prefix))),
      recency: Number.isFinite(time) ? time : 0 })
  }
  return matches.sort(({ session: a, prefixMatch: ap, recency: at }, { session: b, prefixMatch: bp, recency: bt }) =>
    rank(a) - rank(b) || a.projectId.localeCompare(b.projectId) || bp - ap || bt - at
    || a.sessionId.localeCompare(b.sessionId)).map(row => row.session)
}

export function isSessionQuickOpenShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'isComposing'>): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey
    && event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'
}

/** Dialog backdrop events target the dialog too; padding inside its bounds is not backdrop. */
export function isQuickOpenBackdropPoint(point: { clientX: number; clientY: number },
  bounds: { left: number; right: number; top: number; bottom: number }): boolean {
  return point.clientX < bounds.left || point.clientX > bounds.right
    || point.clientY < bounds.top || point.clientY > bounds.bottom
}
