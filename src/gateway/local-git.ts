import { resolve } from 'node:path'
import type { Context } from 'hono'
import { GitReadError, localGitDiff, localGitStatus } from '../execution/git/local-git.ts'

/** The caller resolves the registered folder or local session workdir before invoking this. */
export async function serveLocalGit(c: Context, base: string, operation: 'status' | 'diff', scope?: 'home'): Promise<Response> {
  try {
    const result = operation === 'status' ? await localGitStatus(base, c.req.raw.signal)
      : await localGitDiff(base, c.req.query('path') ?? '', c.req.raw.signal)
    return c.json(scope === 'home' && 'path' in result
      ? { ...result, sourcePath: resolve(base, result.path) } : result)
  } catch (error) {
    if (error instanceof GitReadError) return c.json({ error: error.code, message: error.message }, error.status)
    return c.json({ error: 'git_files_unavailable', message: 'Git files are unavailable. Check workdir access and retry.' }, 503)
  }
}
