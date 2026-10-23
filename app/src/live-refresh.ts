/** Coalesce invalidations without cancelling an in-flight snapshot on every event. */
export function createLiveRefresh<T>(options: {
  load: (signal: AbortSignal) => Promise<T>
  apply: (value: T) => void
  onError: (error: unknown) => void
  delayMs?: number
  timeoutMs?: number
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | undefined
  let pending = false
  let disposed = false

  function schedule() {
    if (disposed || current || timer !== undefined || !pending) return
    timer = setTimeout(() => { void run() }, options.delayMs ?? 50)
  }

  async function run() {
    timer = undefined
    if (disposed || !pending) return
    pending = false
    const controller = new AbortController()
    current = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
    try {
      const value = await options.load(signal)
      signal.throwIfAborted()
      if (!disposed && current === controller) options.apply(value)
    } catch (error) {
      if (!disposed && !controller.signal.aborted) options.onError(error)
    } finally {
      if (current === controller) current = undefined
      schedule()
    }
  }

  return {
    refresh() {
      if (disposed) return
      pending = true
      schedule()
    },
    dispose() {
      disposed = true
      pending = false
      clearTimeout(timer)
      timer = undefined
      current?.abort()
      current = undefined
    },
  }
}
