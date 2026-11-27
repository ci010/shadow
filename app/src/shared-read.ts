/** A view never cancels a read owned by another view. */
export function callerRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) { void promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, cause => { cleanup(); reject(cause) })
  })
}
/** Bound shared transport lifetime independently of any individual reader. */
export function sharedTransport<T>(load: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('Shared read timed out. Retry.', 'TimeoutError')), 12_000)
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return callerRead(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal) }), controller.signal).finally(() => {
    clearTimeout(timeout)
    parent?.removeEventListener('abort', abort)
  })
}
