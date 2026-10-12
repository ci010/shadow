import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { resolveLegacyProjectPath } from '../storage/legacy-paths.ts'
import { isImagePath, readImage } from '../utils/image-input.ts'

export async function validateAnswerUploads(workspace: string, owner: string, media: string[], signal?: AbortSignal): Promise<void> {
  const root = join(sessionWorkspacePath(workspace, owner), 'uploads')
  try {
    const realRoot = await realpath(root)
    for (const path of media) {
      signal?.throwIfAborted()
      if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Attach files uploaded to this conversation.')
      const target = await realpath(resolveLegacyProjectPath(workspace, resolve(path)))
      const rel = relative(realRoot, target)
      if (!rel || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)
        || !(await stat(target)).isFile()) throw new TypeError('Attach files uploaded to this conversation.')
      if (isImagePath(path)) {
        try { await readImage(target, signal) }
        catch (error) {
          if (!(error instanceof Error) || error.name === 'AbortError' || 'code' in error) throw error
          throw new TypeError(`Answer image: ${error.message}`)
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new TypeError('An answer attachment is unavailable. Remove it and upload it again.')
    }
    throw error
  }
}
