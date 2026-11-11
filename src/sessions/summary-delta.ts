import { createHash } from 'node:crypto'
import type { Context } from 'hono'

/** Bounded, per-runtime transport history only; never an authoritative read cache. */
export function createSummaryResponder(maxBytes = 16 * 1024 * 1024, maxEntries = 8) {
  const history = new Map<string, { scope: string; rows: Map<string, string>; bytes: number }>()
  let bytes = 0
  return <T extends { sessionId: string }>(c: Context, projectId: string | undefined, value: { sessions: T[] }): Response => {
    const scope = JSON.stringify([projectId ?? null, c.req.url])
    const body = JSON.stringify(value)
    const etag = `"${createHash('sha256').update(scope).update('\n').update(body).digest('hex')}"`
    c.header('Cache-Control', 'no-store')
    c.header('ETag', etag)
    c.header('Vary', 'Accept')
    const validators = c.req.header('If-None-Match')?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []
    if (validators.some(v => v === '*' || v.replace(/^W\//, '') === etag)) return c.body(null, 304)
    const rows = new Map(value.sessions.map(row => [row.sessionId, JSON.stringify(row)]))
    const baseTag = c.req.header('If-None-Match')
    const base = baseTag ? history.get(baseTag) : undefined
    let output = body
    if (c.req.header('Accept') === 'application/vnd.shadow.session-summary-delta+json' && base?.scope === scope) {
      const delta = JSON.stringify({ delta: 1, base: baseTag,
        upsert: value.sessions.filter(row => base.rows.get(row.sessionId) !== rows.get(row.sessionId)),
        removed: [...base.rows.keys()].filter(id => !rows.has(id)),
        order: value.sessions.map(row => row.sessionId) })
      if (Buffer.byteLength(delta) < Buffer.byteLength(body)) output = delta
    }
    if (!history.has(etag)) {
      const size = Buffer.byteLength(body)
      if (size <= maxBytes) {
        history.set(etag, { scope, rows, bytes: size }); bytes += size
        while (history.size > maxEntries || bytes > maxBytes) {
          const key = history.keys().next().value!
          bytes -= history.get(key)!.bytes; history.delete(key)
        }
      }
    }
    c.header('Content-Type', 'application/json')
    return c.body(output, 200)
  }
}
