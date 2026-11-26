import type { Context } from 'hono'
import { deleteLocalFile, FileDeleteError } from '../execution/filesystem/delete-file.ts'

/** Caller must authorize and resolve the owning local root first. */
export async function serveDeleteFile(c: Context, base: string): Promise<Response> {
  const paths = c.req.queries('path')
  if (!paths || paths.length !== 1) return c.json({ error: 'invalid_path' }, 400)
  try {
    await deleteLocalFile(base, paths[0], c.req.raw.signal)
    return c.json({ deleted: true, path: paths[0] })
  } catch (error) {
    if (error instanceof FileDeleteError) return c.json({ error: error.code }, 400)
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return c.json({ error: 'not_found' }, 404)
    if (code === 'EACCES' || code === 'EPERM') return c.json({ error: 'permission_denied' }, 403)
    return c.json({ error: 'file_delete_failed' }, 500)
  }
}
