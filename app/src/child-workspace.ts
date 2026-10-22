import { readonly, ref } from 'vue'

export function createChildWorkspaceConnection(apiBase: string, options: {
  fetch?: typeof fetch
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
} = {}) {
  const available = ref(false)
  const checking = ref(true)
  const error = ref<string | null>(null)
  const request = options.fetch ?? fetch
  const schedule = options.setTimer ?? setTimeout
  const clear = options.clearTimer ?? clearTimeout
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let running = false
  async function refresh() {
    if (disposed || running) return
    clear(timer)
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
      if (!disposed) { checking.value = false; timer = schedule(refresh, available.value ? 10_000 : 3000) }
    }
  }
  return {
    available: readonly(available), checking: readonly(checking), error: readonly(error), refresh,
    dispose() { disposed = true; clear(timer); controller?.abort() },
  }
}
