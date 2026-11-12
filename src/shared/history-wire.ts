/** HTTP display-history only: each item is a complete message, never a field patch.
 * Top-level null means no display value (including tool-only assistant content).
 * Omission therefore clears a previous value only when replacing the whole item.
 * Do not use for persistence/provider messages or recurse into content, tool
 * arguments/results, provider continuity, or other opaque business payloads.
 */
export function projectHistoryMessages<T extends object>(messages: readonly T[]): Partial<T>[] {
  return messages.map(message => Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== null),
  ) as Partial<T>)
}
