import { extname } from 'node:path'
import type { Context } from 'hono'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemImage, executeRemoteFilesystemText, RemoteFilesystemError, type RemoteFilesystemTarget } from '../execution/remote-filesystem-client.ts'
import { filePreviewLimit } from '../execution/filesystem/contracts.ts'
import { isTextEncoding } from '../execution/filesystem/text-encoding.ts'
import type { RemoteFolderRecord } from './contracts.ts'

export async function serveRemoteFolderFiles(
  c: Context, target: RemoteFilesystemTarget, folder: RemoteFolderRecord,
  operation: 'files' | 'raw' | 'preview' | 'static', input: string,
): Promise<Response> {
  const rawImage = operation === 'raw' && /\.(png|jpe?g|gif|webp)$/i.test(extname(input.replaceAll('\\', '/')))
  if (operation === 'static' || (operation === 'raw' && !rawImage)) return c.json({
    error: 'remote_raw_unavailable',
    message: 'Remote raw previews support PNG, JPEG, GIF and WebP images only. Remote static files are unavailable.',
  }, 501)
  const path = input.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\0\r\n]/.test(path) || path.split('/').includes('..')) {
    return c.json({ error: 'invalid_path' }, 400)
  }
  if (rawImage) {
    try {
      const image = await executeRemoteFilesystemImage(target, path)
      // The client has validated both the encoded result and its raster MIME.
      const url = image.part.image_url.url
      const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
      return c.body(bytes, 200, {
        'Content-Type': image.mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      return remoteFileError(c, error)
    }
  }
  const encoding = c.req.query('encoding') ?? 'auto'
  if (!isTextEncoding(encoding)) return c.json({ error: 'invalid_text_encoding' }, 400)
  if (encoding !== 'auto' && encoding !== 'utf-8') return c.json({ error: 'remote_encoding_unavailable' }, 501)
  try {
    const output = await executeRemoteFilesystemText(target, FILESYSTEM_READ_OPERATION, { path: path || '.' })
    if (operation === 'files') {
      const entries = output ? output.split('\n').map(entry => {
        const isDir = entry.endsWith('/')
        const name = isDir ? entry.slice(0, -1) : entry
        if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') throw new Error('Invalid remote directory entry')
        return { name, type: isDir ? 'dir' as const : 'file' as const, ext: isDir ? '' : extname(name).toLowerCase(), size: 0, mtime: null }
      }) : []
      entries.sort((a, b) => a.type !== b.type ? a.type === 'dir' ? -1 : 1 : a.name.localeCompare(b.name))
      return c.json({ folderId: folder.id, path, workdir: { kind: 'remote', displayPath: folder.path || null }, entries })
    }
    const bytes = new TextEncoder().encode(output)
    const slice = bytes.subarray(0, filePreviewLimit(c.req.query('maxBytes')))
    return c.json({ folderId: folder.id, path, binary: false, encoding: 'utf-8', size: bytes.length,
      truncated: bytes.length > slice.length, content: new TextDecoder().decode(slice, { stream: bytes.length > slice.length }) })
  } catch (error) {
    return remoteFileError(c, error)
  }
}

function remoteFileError(c: Context, error: unknown): Response {
  if (error instanceof RemoteFilesystemError) return c.json({ error: 'remote_filesystem_failed', code: error.code, message: error.message },
    error.code === 'file-not-found' ? 404 : ['path-denied', 'invalid-filesystem-args', 'file-type-denied', 'invalid-image'].includes(error.code) ? 400 : 503)
  return c.json({ error: 'remote_filesystem_failed', message: 'The device returned an invalid file result. No local folder was used.' }, 503)
}
