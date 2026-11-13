import { createHash } from 'node:crypto'
import type { Context } from 'hono'

/** Bounded, per-runtime transport history only; never an authoritative read cache. */
export function createSummaryResponder(maxBytes = 16 * 1024 * 1024, maxEntries = 8, immutableRows = false) {
  const serialized = new WeakMap<object, string>()
  let latest: { scope: string; refs: object[]; body: string; etag: string } | undefined
  const history = new Map<string, { scope: string; rows: Map<string, string>; bytes: number }>()
  let bytes = 0
  return <T extends { sessionId: string }>(c: Context, projectId: string | undefined, value: { sessions: T[] }): Response => {
    // A summary is a set. Canonical wire order stabilizes validators and history
    // even when archive/live enumeration changes; it is not navigation order.
    const sessions = [...value.sessions].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    const scope = JSON.stringify([projectId ?? null, c.req.url])
    const same = immutableRows && latest?.scope === scope && latest.refs.length === sessions.length
      && sessions.every((row, i) => row === latest!.refs[i])
    const encode = (row: T): string => {
      const cached = immutableRows ? serialized.get(row) : undefined
      if (cached !== undefined) return cached
      const text = JSON.stringify(row)
      if (immutableRows) serialized.set(row, text)
      return text
    }
    const body = same ? latest!.body : `{"sessions":[${sessions.map(encode).join(',')}]}`
    const etag = same ? latest!.etag : `"${createHash('sha256').update(scope).update('\n').update(body).digest('hex')}"`
    if (!same) latest = immutableRows && Buffer.byteLength(body) <= maxBytes
      ? { scope, refs: [...sessions], body, etag } : undefined
    c.header('Cache-Control', 'no-store')
    c.header('ETag', etag)
    c.header('Vary', 'Accept, Accept-Encoding')
    const validators = c.req.header('If-None-Match')?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []
    if (validators.some(v => v === '*' || v.replace(/^W\//, '') === etag)) return c.body(null, 304)
    const rows = new Map(sessions.map(row => [row.sessionId, encode(row)]))
    const baseTag = c.req.header('If-None-Match')
    const base = baseTag ? history.get(baseTag.replace(/^W\//, '')) : undefined
    let output = body
    if (c.req.header('Accept') === 'application/vnd.shadow.session-summary-delta+json' && base?.scope === scope) {
      const delta = JSON.stringify({ delta: 1, base: baseTag,
        upsert: sessions.filter(row => base.rows.get(row.sessionId) !== rows.get(row.sessionId)),
        removed: [...base.rows.keys()].filter(id => !rows.has(id)) })
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
