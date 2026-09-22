import { onScopeDispose, reactive } from 'vue'
import { mobileResourcePath } from '../mobile-resources.ts'

/** Fetch protected files in the renderer so downloads retain its request authorization. */
export function useFileDownload() {
  const pending = reactive(new Set<string>())
  const errors = reactive(new Map<string, string>())
  const requests = new Map<string, AbortController>()
  const objects = new Map<string, ReturnType<typeof setTimeout>>()

  function release(url: string) {
    clearTimeout(objects.get(url))
    objects.delete(url)
    URL.revokeObjectURL(url)
  }
  function reset() {
    for (const controller of requests.values()) controller.abort()
    requests.clear()
    pending.clear()
    errors.clear()
    for (const url of objects.keys()) release(url)
  }
  onScopeDispose(reset)

  async function download(event: MouseEvent, value: string | undefined, name: string): Promise<void> {
    if (!value || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const url = new URL(value, window.location.href)
    // External attachments keep normal link behavior; fetching them may require unsupported CORS.
    if (!mobileResourcePath(url.href, url.origin)) return
    event.preventDefault()
    if (pending.has(value)) return
    const controller = new AbortController()
    requests.set(value, controller)
    pending.add(value)
    errors.delete(value)
    try {
      const response = await fetch(url.href, { signal: controller.signal, credentials: 'same-origin', referrerPolicy: 'no-referrer' })
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403
          ? 'Access was denied. Reconnect and try again.'
          : response.status === 404 ? 'The file is missing or outside the folders accessible to this conversation.' : 'Please try again.'
        throw new Error(`Download failed (${response.status}). ${reason}`)
      }
      const blob = await response.blob()
      if (controller.signal.aborted) return
      const objectUrl = URL.createObjectURL(blob)
      objects.set(objectUrl, setTimeout(() => release(objectUrl), 60_000))
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = name
      document.body.append(link)
      try { link.click() } finally { link.remove() }
    } catch (cause) {
      if (!controller.signal.aborted) errors.set(value, cause instanceof Error ? cause.message : 'Download failed. Please try again.')
    } finally {
      if (requests.get(value) === controller) {
        requests.delete(value)
        pending.delete(value)
      }
    }
  }
  return { download, pending, errors, reset }
}
