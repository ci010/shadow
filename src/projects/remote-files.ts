import { extname } from 'node:path'
import type { Context } from 'hono'
import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError, type RemoteFilesystemTarget } from '../execution/remote-filesystem-client.ts'
import { filePreviewLimit } from '../gateway/local-files.ts'
import { isTextEncoding } from '../gateway/text-encoding.ts'
import type { RemoteProjectRecord } from './contracts.ts'

export async function serveRemoteProjectFiles(
  c: Context, target: RemoteFilesystemTarget, project: RemoteProjectRecord,
  operation: 'files' | 'raw' | 'preview', input: string,
): Promise<Response> {
  if (operation === 'raw') return c.json({
    error: 'remote_raw_unavailable',
    message: 'Raw media and static previews are not supported by this remote filesystem protocol. Text previews and file listings remain available.',
  }, 501)
  const path = input.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\0\r\n]/.test(path) || path.split('/').includes('..')) {
    return c.json({ error: 'invalid_path' }, 400)
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
      return c.json({ projectId: project.id, path, workdir: { kind: 'remote', displayPath: project.path || null }, entries })
    }
    const bytes = new TextEncoder().encode(output)
    const slice = bytes.subarray(0, filePreviewLimit(c.req.query('maxBytes')))
    return c.json({ projectId: project.id, path, binary: false, encoding: 'utf-8', size: bytes.length,
      truncated: bytes.length > slice.length, content: new TextDecoder().decode(slice, { stream: bytes.length > slice.length }) })
  } catch (error) {
    if (error instanceof RemoteFilesystemError) return c.json({ error: 'remote_filesystem_failed', code: error.code, message: error.message },
      error.code === 'file-not-found' ? 404 : ['path-denied', 'invalid-filesystem-args', 'file-type-denied'].includes(error.code) ? 400 : 503)
    return c.json({ error: 'remote_filesystem_failed', message: 'The device returned an invalid file result. No local folder was used.' }, 503)
  }
}
