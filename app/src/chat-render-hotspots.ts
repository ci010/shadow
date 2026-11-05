/** Match Array.find's first-match semantics, including duplicate session IDs.
 * Building inside a computed tracks array replacement, insertion and ID changes.
 */
export function firstSessionIndex<T extends { sessionId: string }>(sessions: readonly T[]): ReadonlyMap<string, T> {
  const index = new Map<string, T>()
  for (const session of sessions) {
    const id = session.sessionId
    if (!index.has(id)) index.set(id, session)
  }
  return index
}

/** A bounded cache for bottom-follow requests after the SAME component commit.
 * No deferred work: callers keep their nextTick, cancellation and reveal ordering.
 * A new commit, user-scroll version, navigation generation or element invalidates it.
 */
export function createCommitBottomScroll() {
  let last: { element: HTMLElement; commit: number; version: number; generation: number; top: number } | undefined
  return (element: HTMLElement, commit: number, version: number, generation: number): number => {
    if (last?.element === element && last.commit === commit && last.version === version && last.generation === generation) return last.top
    element.scrollTop = element.scrollHeight
    const top = element.scrollTop
    const entry = { element, commit, version, generation, top }
    last = entry
    // Only coalesce sibling post-commit callbacks. Later requests must remeasure:
    // images and other browser layout changes need not cause a Vue update.
    queueMicrotask(() => { if (last === entry) last = undefined })
    return top
  }
}
