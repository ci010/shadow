/** HTTP display-history only: each item is a complete message, never a field patch.
 * Top-level null means no display value (including tool-only assistant content).
 * Omission therefore clears a previous value only when replacing the whole item.
 * The opt-in conversation view also omits provider continuity state, which the
 * renderer never consumes. Do not use for persistence/provider messages or
 * recurse into content, tool arguments/results, or other opaque payloads.
 */
export function projectHistoryMessages<T extends object>(messages: readonly T[], displayOnly = false): Partial<T>[] {
  return messages.map(message => Object.fromEntries(
    Object.entries(message).filter(([key, value]) => value !== null && (!displayOnly || key !== 'provider_state')),
  ) as Partial<T>)
}

/** An initial suffix, or an already-visible offset pinned to its segment.
 * Back up over tool results so a window never begins inside a call/result pair. */
export const HISTORY_INITIAL_WINDOW_SIZE = 120
export const HISTORY_PREPEND_PAGE_SIZE = 40
// A larger contiguous prepend can fall back to a complete snapshot (e.g. search).
export const HISTORY_DELTA_PREPEND_LIMIT = 256
export function historyWindowCacheKey(url: URL): string {
  if (url.searchParams.get('historyWindow') !== 'recent') return url.toString()
  const key = new URL(url)
  for (const param of ['historyFrom', 'historyPhysicalId']) key.searchParams.delete(param)
  return key.toString()
}

export function parseHistoryOffset(text: string | null | undefined): number | undefined {
  const offset = text != null && /^\d+$/.test(text) ? Number(text) : NaN
  return Number.isSafeInteger(offset) ? offset : undefined
}

export function recentHistoryWindow<T extends { role: string }>(history: readonly T[], query: URLSearchParams, physicalId: string) {
  // System messages are not conversation rows (including a live prompt stored
  // as the first model-history message). Do not count or transport them here.
  const messages = history.filter(message => message.role !== 'system')
  const offset = parseHistoryOffset(query.get('historyFrom'))
  let start = query.get('historyPhysicalId') === physicalId && offset !== undefined && offset <= messages.length
    ? offset : Math.max(0, messages.length - HISTORY_INITIAL_WINDOW_SIZE)
  while (start > 0 && messages[start]?.role === 'tool') start--
  return { messages: projectHistoryMessages(messages.slice(start), true), start }
}
