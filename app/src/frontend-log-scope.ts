import { watch } from 'vue'
import { startFrontendLog } from './frontend-log.ts'

/** A scope transition must restore hooks/discard queues before child updates.
 * The caller supplies only an explicit route Project base, never a fallback. */
export function watchFrontendLogScope(
  base: () => string | undefined,
  start: typeof startFrontendLog = startFrontendLog,
): () => void {
  return watch(base, (value, _old, onCleanup) => {
    if (!value) return
    const controller = new AbortController()
    const stop = start(value, controller.signal)
    onCleanup(() => { controller.abort(); stop() })
  }, { immediate: true, flush: 'sync' })
}
