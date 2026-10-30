import { readonly, ref } from 'vue'
import type { LiveStatus } from './live-client.ts'

export function createChildWorkspaceConnection(apiBase: string, options: {
  observeHost?: (base: string, callback: (status: LiveStatus) => void) => () => void
  fetch?: typeof fetch
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
} = {}) {
  const available = ref(false)
  const checking = ref(true)
  const error = ref<string | null>(null)
  const request = options.fetch ?? fetch
  const schedule = options.setTimer ?? setTimeout
  const clear = options.clearTimer ?? clearTimeout
  const page = options.document ?? (typeof document === 'undefined' ? undefined : document)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let running = false
  let attempted = false
  let phase: LiveStatus['phase'] = 'idle'
  function stopTimer() { clear(timer); timer = undefined }
  function scheduleFallback() {
    if (disposed || running || page?.hidden || (phase === 'live' && available.value)) {
      stopTimer()
      return
    }
    // Reconnect phase transitions must not keep pushing the fallback deadline.
    if (attempted && timer === undefined) {
      timer = schedule(() => { timer = undefined; void refresh() }, 30_000)
    }
  }
  const stopHost = options.observeHost?.(apiBase, status => {
    phase = status.phase
    scheduleFallback()
  })
  async function refresh() {
    if (disposed || running || page?.hidden) return
    stopTimer()
    attempted = true
    running = true
    if (!available.value) checking.value = true
    const current = new AbortController(); controller = current
    try {
      const response = await request(new URL('/api/projects', apiBase), {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]), cache: 'no-store',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const code = typeof body?.error === 'string' && /^[a-z_0-9]{1,80}$/.test(body.error) ? body.error : 'main_workspace_http_error'
        if (!disposed) error.value = `${code} (HTTP ${response.status})`
        if (!disposed) available.value = false
      } else {
        await response.body?.cancel()
        if (!disposed) { available.value = true; error.value = null }
      }
    } catch { if (!disposed) { available.value = false; error.value = 'main_workspace_connection_failed' } }
    finally {
      running = false
      if (!disposed) { checking.value = false; scheduleFallback() }
    }
  }
  const visibilityChanged = () => {
    if (page?.hidden) stopTimer()
    else if (phase !== 'live' || !available.value) void refresh()
  }
  page?.addEventListener('visibilitychange', visibilityChanged)
  return {
    available: readonly(available), checking: readonly(checking), error: readonly(error), refresh,
    dispose() { disposed = true; stopHost?.(); page?.removeEventListener('visibilitychange', visibilityChanged); stopTimer(); controller?.abort() },
  }
}
