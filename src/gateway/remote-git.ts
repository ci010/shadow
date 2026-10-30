import type { Context } from 'hono'
import type { RemoteFilesystemTarget } from '../execution/remote-filesystem-client.ts'
import { executeRemoteGit } from '../execution/remote-git-client.ts'
import { FolderError } from '../folders/registry.ts'
import { RemoteWorkdirIdentityError } from '../execution/remote-workdir-identity-client.ts'

export async function serveRemoteGit(c: Context, target: RemoteFilesystemTarget, operation: 'status' | 'diff'): Promise<Response> {
  try {
    const result = await executeRemoteGit(target, operation, c.req.query('path'))
    return c.json(result.body, result.status)
  } catch (error) {
    if (error instanceof FolderError || error instanceof RemoteWorkdirIdentityError) return c.json({ error: error.code, message: error.message }, error.status)
    return c.json({ error: 'remote_git_failed', message: error instanceof Error ? error.message : 'Remote Git inspection failed. Retry.' }, 503)
  }
}
