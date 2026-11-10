import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { MiddlewareHandler } from 'hono'
import { diagnosticEndpoint, DIAGNOSTIC_ID_HEADER } from '../runtime/api-request-diagnostic.ts'
import { getProjectScope } from '../projects/scope.ts'

/** No stream wrapping/consumption. finish means handed to OS, not received by browser. */
export function requestDiagnostic(report: (message: string) => void = message => console.warn(message), now = performance.now.bind(performance)): MiddlewareHandler {
  let windowStart = now()
  let count = 0
  return async (c, next) => {
    const endpoint = diagnosticEndpoint(new URL(c.req.url).pathname)
    if (!endpoint || !['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD'].includes(c.req.method)) return next()
    const id = randomUUID()
    const start = now()
    let readyMs: number | undefined
    let status: number | undefined
    c.header(DIAGNOSTIC_ID_HEADER, id)
    const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing
    const scope = getProjectScope()
    let emitted = false
    const complete = (completion: 'finish' | 'early-close') => {
      if (emitted) return
      emitted = true
      outgoing?.off('finish', finish)
      outgoing?.off('close', close)
      const elapsedMs = Math.max(0, Math.round(now() - start))
      if (scope?.closed) return
      if (now() - windowStart >= 60_000) { windowStart = now(); count = 0 }
      if (count++ >= 120) return
      const emit = () => report(`API transport ${JSON.stringify({ id, endpoint, method: c.req.method, status: outgoing?.headersSent ? outgoing.statusCode : status, completion, readyMs, elapsedMs })}`)
      try {
        if (scope) scope.run(emit)
        else emit()
      } catch { /* diagnostics must not affect response delivery */ }
    }
    const finish = () => complete('finish')
    const close = () => complete(outgoing?.writableFinished ? 'finish' : 'early-close')
    outgoing?.once('finish', finish)
    outgoing?.once('close', close)
    try { await next() } finally {
      readyMs = Math.max(0, Math.round(now() - start))
      status = c.res.status
    }
  }
}
