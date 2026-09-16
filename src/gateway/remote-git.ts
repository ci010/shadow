import type { Context } from 'hono'
import type { RemoteFilesystemTarget } from '../execution/remote-filesystem-client.ts'
import { executeRemoteGit } from '../execution/remote-git-client.ts'

export async function serveRemoteGit(c: Context, target: RemoteFilesystemTarget, operation: 'status' | 'diff'): Promise<Response> {
  try {
    const result = await executeRemoteGit(target, operation, c.req.query('path'))
    return c.json(result.body, result.status)
  } catch (error) {
    return c.json({ error: 'remote_git_failed', message: error instanceof Error ? error.message : 'Remote Git inspection failed. Retry.' }, 503)
  }
}
