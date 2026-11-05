import { computed, nextTick, onScopeDispose, ref, watch, type ComputedRef } from 'vue'

export interface HistoryFrameScheduler {
  request(callback: () => void): number
  cancel(handle: number): void
}
const frames: HistoryFrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
}

/** A suffix of presentation rows, never a slice of the underlying message/projection data.
 * One batch per animation frame, with the DOM commit between batches. Keys and source
 * indices belong to the caller; in particular a long tool group is ONE presentation row.
 */
export function useProgressiveHistory<T>(options: {
  rows: ComputedRef<readonly T[]>
  key: (row: T) => string
  context: () => string
  active: () => boolean
  /** Cancel navigation/queued commits without discarding the retained suffix. */
  navigation?: () => unknown
  beforeBatch: () => (() => void) | undefined
  scheduler?: HistoryFrameScheduler
  batchSize?: number
}) {
  const scheduler = options.scheduler ?? frames
  const size = Math.max(1, options.batchSize ?? 4)
  const start = ref(0)
  let keys: string[] = []
  let context: string | undefined
  let generation = 0
  let navigationGeneration = 0
  let frame: number | undefined
  let disposed = false
  let committing = false
  const pending = new Set<{ key: string; resolve: (value: boolean) => void; signal?: AbortSignal; abort: () => void }>()
  function settle(cancelled = false) {
    for (const request of pending) {
      if (!cancelled && keys.indexOf(request.key) < start.value && keys.includes(request.key)) continue
      pending.delete(request)
      request.signal?.removeEventListener('abort', request.abort)
      request.resolve(!cancelled && keys.includes(request.key))
    }
  }
  function cancel(cancelPending = true) {
    generation++
    if (frame !== undefined) scheduler.cancel(frame)
    frame = undefined
    committing = false
    if (cancelPending) { navigationGeneration++; settle(true) }
  }
  function schedule() {
    if (disposed || !options.active() || frame !== undefined || committing || start.value === 0) return
    const version = generation
    frame = scheduler.request(() => {
      frame = undefined
      if (version !== generation || disposed || !options.active()) return
      const restore = options.beforeBatch()
      committing = true
      start.value = Math.max(0, start.value - size)
      void nextTick(() => {
        if (version !== generation || disposed || !options.active()) return
        restore?.()
        committing = false
        settle()
        schedule()
      })
    })
  }
  watch([options.rows, options.context], ([rows, nextContext]) => {
    const nextKeys = rows.map(options.key)
    const retainedStart = keys[start.value]
    const retainedIndex = retainedStart === undefined ? -1 : nextKeys.indexOf(retainedStart)
    const reset = context !== nextContext || (keys.length > 0 && retainedIndex < 0)
    // Also cancel a pending post-commit scroll restoration on any source update.
    cancel(reset)
    start.value = reset || keys.length === 0 ? Math.max(0, rows.length - size) : retainedIndex
    keys = nextKeys
    context = nextContext
    const version = generation
    void nextTick(() => { if (version === generation && !disposed) settle() })
    schedule()
  }, { immediate: true, flush: 'sync' })
  watch(options.active, active => { cancel(); if (active) schedule() }, { flush: 'sync' })
  if (options.navigation) watch(options.navigation, () => { cancel(); schedule() }, { flush: 'sync' })
  onScopeDispose(() => { disposed = true; cancel() })
  const mountedRows = computed(() => options.rows.value.slice(start.value))
  async function reveal(key: string, signal?: AbortSignal): Promise<boolean> {
    if (disposed || !options.active() || signal?.aborted || !keys.includes(key)) return false
    if (keys.indexOf(key) >= start.value) {
      const version = navigationGeneration
      await nextTick()
      return version === navigationGeneration && !disposed && !signal?.aborted && options.active() && keys.includes(key)
    }
    return new Promise<boolean>(resolve => {
      const request = { key, resolve, signal, abort: () => { pending.delete(request); resolve(false) } }
      signal?.addEventListener('abort', request.abort, { once: true })
      pending.add(request)
      schedule()
    })
  }
  return { mountedRows, reveal }
}

/** Retain the viewport across a single prepend commit with O(1) layout reads.
 * The first retained row need not be visible: every retained row receives the
 * same prepend offset. The caller guards cancellation and deliberate browsing.
 */
export function captureHistoryScroll(container: HTMLElement, following: boolean): () => number {
  const anchor = following ? undefined : container.querySelector<HTMLElement>('[data-history-row-key]')
  const top = anchor?.getBoundingClientRect().top
  return () => {
    if (following) container.scrollTop = container.scrollHeight
    else if (anchor?.isConnected && top !== undefined) container.scrollTop += anchor.getBoundingClientRect().top - top
    return container.scrollTop
  }
}

interface PresentationMessage {
  role: string
  content: string
  event?: string
  media?: readonly unknown[]
  reasoningContent?: string
  reasoningText?: string
  isError?: boolean
  isSummary?: boolean
  sessionSource?: unknown
  commandReceipt?: unknown
}
/** Keep source indices and group anchors; skip only rows whose template body is
 * empty. Projection data is always derived from the FULL message collection.
 */
export function historyPresentationRows<T extends PresentationMessage>(messages: readonly T[], projections: {
  entries: readonly { has(index: number): boolean }[]
  after: readonly ReadonlyMap<number, readonly unknown[]>[]
  boundaries: { has(index: number): boolean }
}): { msg: T; idx: number }[] {
  return messages.flatMap((msg, idx) => {
    const projected = projections.entries.some(entries => entries.has(idx))
      || projections.after.some(after => !!after.get(idx)?.length)
    const emptyAssistant = msg.role === 'assistant' && !msg.event && !msg.content.trim() && !msg.media?.length
      && !(msg.reasoningContent || msg.reasoningText || '').trim() && !msg.isError
      && !msg.isSummary && !msg.sessionSource && !msg.commandReceipt
    const emptyTool = !msg.commandReceipt && (msg.event === 'tool_call' || msg.event === 'tool_result')
    return (projected || !emptyAssistant && !emptyTool || projections.boundaries.has(idx)) ? [{ msg, idx }] : []
  })
}

/** Rail decisions may have a synthetic index outside the message array. Resolve
 * their after-projection anchor before looking up a presentation/tool-group row.
 * Undefined leaves already-mounted streaming/unlinked nodes to the caller.
 */
export function historyRevealRow<T extends { idx: number }>(index: number, rows: readonly T[],
  groups: ReadonlyMap<number, { end: number }>,
  after: ReadonlyMap<number, readonly (readonly [number, unknown])[]>,
): T | undefined {
  let anchor = index
  for (const [candidate, decisions] of after) {
    if (decisions.some(([decisionIndex]) => decisionIndex === index)) { anchor = candidate; break }
  }
  return rows.find(row => row.idx === anchor)
    ?? rows.find(row => row.idx <= anchor && (groups.get(row.idx)?.end ?? -1) > anchor)
}
