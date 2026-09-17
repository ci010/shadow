import { extname } from 'node:path'
import type { Context } from 'hono'
import { filePreviewLimit, type LocalFileOperation } from '../execution/filesystem/contracts.ts'
import { FileReadError, localFiles } from '../execution/filesystem/local-files.ts'
import { isTextEncoding } from '../execution/filesystem/text-encoding.ts'

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
  identity: { key: string } | { folderId: string },
  operation: LocalFileOperation,
  path: string,
  maxBytes = filePreviewLimit(c.req.query('maxBytes')),
  scope?: 'home',
): Promise<Response> {
  const encoding = operation === 'preview' ? c.req.query('encoding') ?? 'auto' : 'auto'
  if (!isTextEncoding(encoding)) return c.json({ error: 'invalid_text_encoding' }, 400)
  try {
    const result = await localFiles(base, operation, path, c.req.raw.signal, maxBytes, encoding)
    if (result.operation === 'files') {
      return c.json({ ...identity, path: result.path,
        workdir: { kind: 'local', displayPath: result.base, ...(scope ? { scope } : {}) }, entries: result.entries })
    }
    if (result.operation === 'raw') {
      const contentType = MIME_BY_EXT[extname(result.target).toLowerCase()] ?? 'application/octet-stream'
      try {
        return new Response(result.stream, {
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(result.size),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            ...(contentType.startsWith('image/') ? {
              'X-Shadow-Source-Path': encodeURIComponent(result.target),
              'Access-Control-Expose-Headers': 'X-Shadow-Source-Path',
            } : {}),
          },
        })
      } catch (error) {
        await result.stream.cancel()
        throw error
      }
    }
    return c.json({ ...identity, ...result.preview,
      ...(scope === 'home' ? { sourcePath: result.target } : {}) })
  } catch (error) {
    if (error instanceof FileReadError) return c.json({ error: error.code }, 400)
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
    return c.json({ error: 'not_found', path }, 404)
  }
}
