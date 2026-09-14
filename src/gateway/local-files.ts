import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from 'hono'
import { decodeTextPreview, isTextEncoding } from './text-encoding.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.xml': 'application/xml',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
}

function contained(base: string, target: string): boolean {
  const path = relative(base, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../')
}

/** Resolve a relative path without permitting escape from the selected root. */
export function resolveInWorkspace(baseDir: string, relPath: string): string | null {
  if (relPath.includes('\0')) return null
  const target = resolve(baseDir, relPath.replace(/^[/\\]+/, ''))
  return contained(baseDir, target) ? target : null
}

async function resolveLocalFile(base: string, path: string): Promise<string | null> {
  const target = resolveInWorkspace(base, path)
  if (!target) return null
  const [root, canonical] = await Promise.all([realpath(base), realpath(target)])
  return contained(root, canonical) ? canonical : null
}

export function filePreviewLimit(value: string | undefined): number {
  return Math.min(Math.max(parseInt(value ?? '4096', 10) || 4096, 256), 65536)
}

export function staticFilePath(c: Context): string | null {
  const pathname = new URL(c.req.url).pathname
  const marker = '/static/'
  const index = pathname.indexOf(marker)
  try {
    return decodeURIComponent(index >= 0 ? pathname.slice(index + marker.length) : '')
  } catch {
    return null
  }
}

/** Shared Main-local serving; callers must authorize and resolve the owning root. */
export async function serveLocalFiles(
  c: Context,
  base: string,
  identity: { key: string } | { projectId: string },
  operation: 'files' | 'raw' | 'preview',
  path: string,
  maxBytes = filePreviewLimit(c.req.query('maxBytes')),
  scope?: 'home',
): Promise<Response> {
  const encoding = operation === 'preview' ? c.req.query('encoding') ?? 'auto' : 'auto'
  if (!isTextEncoding(encoding)) return c.json({ error: 'invalid_text_encoding' }, 400)
  try {
    c.req.raw.signal.throwIfAborted()
    base = await realpath(base)
    const target = await resolveLocalFile(base, path)
    if (!target) return c.json({ error: 'invalid_path' }, 400)
    if (operation === 'files') {
      const dirents = await readdir(target, { withFileTypes: true })
      const entries = await Promise.all(dirents.map(async entry => {
        let size = 0
        let mtime: string | null = null
        let isDir = entry.isDirectory()
        try {
          const child = await resolveLocalFile(base, relative(base, resolve(target, entry.name)))
          if (child) {
            const info = await stat(child)
            size = info.size
            mtime = info.mtime.toISOString()
            isDir = info.isDirectory()
          }
        } catch { /* A disappearing or inaccessible entry remains visible. */ }
        return { name: entry.name, type: isDir ? 'dir' as const : 'file' as const,
          ext: isDir ? '' : extname(entry.name).toLowerCase(), size, mtime }
      }))
      entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
      c.req.raw.signal.throwIfAborted()
      return c.json({ ...identity, path: path.replace(/^[/\\]+/, ''),
        workdir: { kind: 'local', displayPath: base, ...(scope ? { scope } : {}) }, entries })
    }
    const file = await open(target, 'r')
    let streaming = false
    try {
      const info = await file.stat()
      if (!info.isFile()) return c.json({ error: 'not_a_file' }, 400)
      c.req.raw.signal.throwIfAborted()
      if (operation === 'raw') {
        const contentType = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream'
        const stream = file.createReadStream({ signal: c.req.raw.signal, autoClose: true })
        const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(info.size),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            ...(contentType.startsWith('image/') ? {
              'X-Shadow-Source-Path': encodeURIComponent(target),
              'Access-Control-Expose-Headers': 'X-Shadow-Source-Path',
            } : {}),
          },
        })
        streaming = true
        return response
      }
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      c.req.raw.signal.throwIfAborted()
      const slice = buffer.subarray(0, bytesRead)
      return c.json({ ...identity, path, size: info.size,
        ...(scope === 'home' ? { sourcePath: target } : {}),
        truncated: info.size > bytesRead, ...decodeTextPreview(slice, encoding, info.size > bytesRead) })
    } finally {
      if (!streaming) await file.close()
    }
  } catch {
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
    return c.json({ error: 'not_found', path }, 404)
  }
}
