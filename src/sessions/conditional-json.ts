import { createHash } from 'node:crypto'
import type { Context } from 'hono'

/** Recompute the authoritative representation on every request; only transfer is saved.
 * Validators are scoped to Project + request URL, never a read-model cache.
 */
export function conditionalSessionJson(c: Context, projectId: string | undefined, value: unknown): Response {
  const body = JSON.stringify(value)
  const etag = `"${createHash('sha256').update(JSON.stringify([projectId ?? null, c.req.url])).update('\n').update(body).digest('hex')}"`
  c.header('Cache-Control', 'no-store')
  c.header('ETag', etag)
  // If-None-Match uses weak comparison for GET, including lists and wildcard.
  const validators = c.req.header('If-None-Match')?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []
  if (validators.some(value => value === '*' || value.replace(/^W\//, '') === etag)) {
    return c.body(null, 304)
  }
  c.header('Content-Type', 'application/json')
  return c.body(body, 200)
}
