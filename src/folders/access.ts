import type { MiddlewareHandler } from 'hono'
import type { FolderRegistry } from './registry.ts'

/** Retain raw-file read leases until the response body is consumed or cancelled. */
export function folderAccessMiddleware(registry: FolderRegistry): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path
    if (c.req.method === 'DELETE' && /^\/api\/folders\/[^/]+$/.test(path) ||
      c.req.method === 'POST' && /^\/api\/folders\/[^/]+\/move$/.test(path)) return next()
    const release = registry.acquireAccess()
    let streaming = false
    try {
      await next()
      if (!/\/(?:raw|static)(?:\/|$)/.test(path) || !c.res.body) return
      const reader = c.res.body.getReader()
      const done = () => {
        c.req.raw.signal.removeEventListener('abort', abort)
        release()
      }
      const abort = () => { void reader.cancel().finally(done).catch(() => {}) }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) { done(); controller.close() }
            else controller.enqueue(chunk.value)
          } catch (error) { done(); controller.error(error) }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { done() } },
      }, { highWaterMark: 0 })
      c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers })
      streaming = true
      c.req.raw.signal.addEventListener('abort', abort, { once: true })
      if (c.req.raw.signal.aborted) abort()
    } finally { if (!streaming) release() }
  }
}
