import { readonly, ref } from 'vue'

export function createChildWorkspaceConnection(apiBase: string, options: {
  fetch?: typeof fetch
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
} = {}) {
  const available = ref(false)
  const checking = ref(true)
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
    const current = new AbortController(); controller = current
    try {
      const response = await request(new URL('/api/projects', apiBase), {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]), cache: 'no-store',
      })
      if (!response.ok) throw new Error('Main unavailable')
      await response.body?.cancel()
      if (!disposed) available.value = true
    } catch { if (!disposed) available.value = false }
    finally {
      running = false
      if (!disposed) { checking.value = false; timer = schedule(refresh, available.value ? 10_000 : 3000) }
    }
  }
  return {
    available: readonly(available), checking: readonly(checking), refresh,
    dispose() { disposed = true; clear(timer); controller?.abort() },
  }
}
