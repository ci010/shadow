import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import type { Context } from 'hono'
import { MIME_BY_EXT } from './local-files.ts'

const TTL = 5 * 60_000
const MAX_LEASES = 128
const MAX_FILE = 32 * 1024 * 1024
interface Lease {
  root: string; base: string; origin: string; expires: number
  validate: () => Promise<string | undefined>
  owner?: AbortSignal; cleanup: () => void
}
export const previewContext = new AsyncLocalStorage<{ store: HtmlPreviewLeases; origin: string; owner?: AbortSignal }>()

/** Dedicated bounded capabilities, never business API credentials. In-memory only. */
export class HtmlPreviewLeases {
  private active = 0
  private leases = new Map<string, Lease>()
  constructor(private now = Date.now) {}
  private prune() {
    for (const [key, lease] of this.leases) if (lease.expires <= this.now() || lease.owner?.aborted) this.revoke(key)
  }
  revoke(token: string) { const lease = this.leases.get(token); this.leases.delete(token); lease?.cleanup() }
  async create(base: string, path: string, origin: string, validate: Lease['validate'], owner?: AbortSignal) {
    this.prune()
    if (this.leases.size >= MAX_LEASES) throw new Error('preview_capacity')
    const parts = safePath(path)
    if (!parts || !/\.html?$/i.test(path)) throw new Error('invalid_preview_path')
    base = await realpath(base)
    // Reject symlinks, including directory components. Never widen to the target directory.
    const target = await checkedPath(base, parts)
    const info = await lstat(target)
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('invalid_preview_path')
    const token = randomBytes(32).toString('base64url')
    const expires = this.now() + TTL
    this.prune()
    if (this.leases.size >= MAX_LEASES || owner?.aborted) throw new Error('preview_capacity')
    const revoke = () => this.revoke(token)
    const timer = setTimeout(revoke, TTL)
    timer.unref()
    owner?.addEventListener('abort', revoke, { once: true })
    this.leases.set(token, { base, root: dirname(target), origin, validate, owner, expires,
      cleanup: () => { clearTimeout(timer); owner?.removeEventListener('abort', revoke) } })
    return { url: `/api/html-preview/${token}/${encodeURIComponent(basename(target))}`, revokeUrl: `/api/html-preview-leases/${token}`, expiresAt: expires }
  }
  async serve(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/html-preview/')) return
    const deny = () => Response.json({ error: 'preview_unavailable' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    this.prune()
    const match = /^\/api\/html-preview\/([\w-]{43})\/(.+)$/.exec(url.pathname)
    const lease = match && this.leases.get(match[1]!)
    if (!match || !lease || lease.origin !== url.origin) return deny()
    if (this.active >= 8) return new Response(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
    this.active++
    try {
      let base: string | undefined
      try { base = await lease.validate() } catch { this.revoke(match[1]!); return deny() }
      if (base !== lease.base) { this.revoke(match[1]!); return deny() }
      const parts = safePath(decodeURIComponent(match[2]!))
      if (!parts) return deny()
      const target = await checkedPath(lease.root, parts)
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        const verified = await checkedPath(lease.root, parts)
        const current = await lstat(verified)
        if (info.dev !== current.dev || info.ino !== current.ino || !info.isFile() || info.size > MAX_FILE) return deny()
        let bytes: Buffer<ArrayBuffer> | null = null
        if (request.method !== 'HEAD') {
          bytes = Buffer.alloc(info.size)
          let offset = 0
          while (offset < bytes.length) {
            request.signal.throwIfAborted()
            const read = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!read.bytesRead) break
            offset += read.bytesRead
          }
          bytes = bytes.subarray(0, offset)
        }
        if (this.leases.get(match[1]!) !== lease || lease.owner?.aborted || lease.expires <= this.now()) return deny()
        const assets = `${url.origin}/api/html-preview/${match[1]}/`
        return new Response(bytes, { headers: {
          'Content-Type': MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
          // Opaque origin remains isolated even if the URL is opened outside our iframe.
          'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${assets}; style-src 'unsafe-inline' ${assets}; img-src data: blob: ${assets}; font-src data: ${assets}; media-src blob: ${assets}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`,
        } })
      } finally { await handle.close() }
    } catch { return deny() } finally { this.active-- }
  }
}
function safePath(path: string): string[] | undefined {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path)) return
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return
  return parts
}
async function checkedPath(root: string, parts: string[]) {
  // Recheck the root itself so replacing it with a symlink revokes access.
  if (await realpath(root) !== root) throw new Error('invalid_preview_path')
  let target = root
  for (const part of parts) {
    target = resolve(target, part)
    if ((await lstat(target)).isSymbolicLink()) throw new Error('invalid_preview_path')
  }
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('invalid_preview_path')
  return target
}

/** Called only by authenticated, Project-scoped file routes. Closure revalidates ownership on every read. */
export async function createHtmlPreview(c: Context, validate: () => Promise<string | undefined>): Promise<Response> {
  const context = previewContext.getStore()
  if (!context) return c.json({ error: 'preview_unavailable' }, 503)
  const path = c.req.query('path') ?? ''
  try {
    const base = await validate()
    if (!base) return c.json({ error: 'html_preview_requires_local_folder', message: 'Interactive HTML preview is unavailable for this resource. Remote folders are not supported.' }, 501)
    return c.json(await context.store.create(base, path, context.origin, validate, context.owner))
  } catch (error) {
    return c.json({ error: error instanceof Error && error.message === 'preview_capacity' ? 'preview_capacity' : 'invalid_preview_path' }, 400)
  }
}
