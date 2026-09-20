import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function isMissingMediaFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function disposition(path: string, download: boolean): string {
  const filename = basename(path).replace(/[\u0000-\u001f\u007f]/g, '_')
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function byteRange(value: string | null, size: number):
  { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  // Unsupported units, malformed ranges and multi-range requests receive the full representation.
  if (!match || (!match[1] && !match[2])) return undefined
  const start = match[1] ? BigInt(match[1]) : undefined
  const end = match[2] ? BigInt(match[2]) : undefined
  if (start !== undefined && end !== undefined && end < start) return undefined
  if (size === 0 || (start !== undefined && start >= size) ||
    (start === undefined && end === 0n)) return 'unsatisfiable'
  return start === undefined
    ? { start: end! >= size ? 0 : size - Number(end), end: size - 1 }
    : { start: Number(start), end: end === undefined || end >= size ? size - 1 : Number(end) }
}

/** Stream an already-authorized file; callers must enforce path containment first. */
export async function mediaFileResponse(
  path: string,
  request: Request,
  download = false,
): Promise<Response> {
  request.signal.throwIfAborted()
  let file
  try {
    file = await open(path, 'r')
  } catch (error) {
    if (isMissingMediaFile(error)) return new Response(null, { status: 404 })
    throw error
  }
  let streaming = false
  try {
    const info = await file.stat()
    if (!info.isFile()) return new Response(null, { status: 404 })
    request.signal.throwIfAborted()
    const headers = new Headers({
      'Content-Type': mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Disposition': disposition(path, download),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    })
    // Range only applies to GET. Without validators, If-Range requests use the full representation.
    const range = request.method === 'GET' && !request.headers.has('If-Range')
      ? byteRange(request.headers.get('Range'), info.size) : undefined
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${info.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    const length = range ? range.end - range.start + 1 : info.size
    headers.set('Content-Length', String(length))
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers })

    const stream = file.createReadStream({
      start: range?.start ?? 0, end: range?.end ?? info.size - 1,
      signal: request.signal, autoClose: true,
    })
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
    }) as ReadableStream<Uint8Array>
    streaming = true
    return new Response(body, { status, headers })
  } finally {
    if (!streaming) await file.close()
  }
}
