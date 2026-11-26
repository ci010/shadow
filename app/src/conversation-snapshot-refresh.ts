/** Await a refresh on the existing conversation subscription, never another
 * connection. Unsupported, failed, aborted and stalled refreshes fall back to
 * the caller's HTTP recovery. Install the waiter before dispatch (test sockets
 * and retained subscriptions may deliver synchronously).
 */
export function createConversationSnapshotRefresh(fallbackMs = 750) {
  const pending = new Set<(received: boolean) => void>()
  return {
    received() { for (const settle of [...pending]) settle(true) },
    failed() { for (const settle of [...pending]) settle(false) },
    wait(request: () => boolean, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false)
      return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = () => settle(false)
        const settle = (received: boolean) => {
          if (!pending.delete(settle)) return
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          resolve(received)
        }
        pending.add(settle)
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => settle(false), fallbackMs)
        try { if (!request()) settle(false) } catch { settle(false) }
      })
    },
  }
}

/** A recent socket tail cannot replace an explicitly paged/expanded window of
 * the same physical segment. Its independent input-delivery snapshot remains
 * usable even when history needs an on-demand HTTP read.
 */
export function canUseConversationHistory(
  chat: { currentPhysicalId?: unknown; historyStart?: unknown },
  physicalId: string | undefined, historyStart: number, from?: number,
): boolean {
  return from === undefined && !(physicalId && chat.currentPhysicalId === physicalId
    && typeof chat.historyStart === 'number' && chat.historyStart > historyStart)
}
