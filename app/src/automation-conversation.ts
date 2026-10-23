import type { AutomationRunHistory } from './automation-run-history.ts'

export function automationRunPosition(history: AutomationRunHistory, sessionId?: string) {
  const index = history.runs.findIndex(run => run.sessionId === sessionId)
  return {
    run: history.runs[index],
    historical: !!sessionId && !!history.runs.length && index !== 0,
    hasPrevious: index >= 0 && (index + 1 < history.runs.length || history.nextOffset < history.total),
    previous: index >= 0 ? history.runs[index + 1]?.sessionId : undefined,
    next: index > 0 ? history.runs[index - 1]?.sessionId : undefined,
    current: history.runs[0]?.sessionId,
    missing: !!sessionId && history.loaded && index < 0 && history.nextOffset >= history.total,
  }
}

/** Runs remain independent sessions; only the conversation navigation joins them. */
export function createAutomationConversation(
  history: AutomationRunHistory,
  options: {
    selected: () => string | undefined
    open: (sessionId: string, replace: boolean) => void
    loadMore: () => void
  },
) {
  let selected = options.selected()
  let followLatest = !selected
  let initialized = false
  let requested: string | undefined
  let pendingPrevious: string | undefined

  function open(sessionId: string, replace = false) {
    if (sessionId === options.selected() || sessionId === requested) return
    requested = sessionId
    options.open(sessionId, replace)
  }
  function reconcile() {
    const id = options.selected()
    if (id !== selected) {
      followLatest = id === requested ? followLatest : !id || id === history.runs[0]?.sessionId
      selected = id
      requested = undefined
      if (pendingPrevious !== id) pendingPrevious = undefined
    }
    if (!history.loaded || !id && history.loading) return
    if (!initialized) {
      initialized = true
      followLatest = !id || id === history.runs[0]?.sessionId
    }
    const position = automationRunPosition(history, id)
    if (followLatest && position.current) { open(position.current, true); return }
    if (pendingPrevious === id && position.previous) {
      pendingPrevious = undefined
      open(position.previous)
      return
    }
    if (!history.loading && !history.error && history.nextOffset < history.total
      && (pendingPrevious === id || !!id && !position.run)) options.loadMore()
  }
  return {
    reconcile,
    previous() {
      if (history.loading) return
      const id = options.selected()
      const position = automationRunPosition(history, id)
      followLatest = false
      if (position.previous) open(position.previous)
      else if (position.hasPrevious) {
        pendingPrevious = id
        options.loadMore()
      }
    },
    next() {
      if (history.loading) return
      const position = automationRunPosition(history, options.selected())
      if (position.next) {
        followLatest = position.next === position.current
        open(position.next)
      }
    },
    current() {
      if (history.loading) return
      followLatest = true
      const id = history.runs[0]?.sessionId
      if (id) open(id)
    },
  }
}
