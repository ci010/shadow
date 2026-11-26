import { lstat, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { resolveInWorkspace } from './local-files.ts'

export class FileDeleteError extends Error {
  constructor(readonly code: 'invalid_path' | 'not_a_file') { super(code) }
}

/** Delete one regular file in an already authorized root, never an archive member.
 * Symlinks (including parent directory aliases) are deliberately unsupported.
 * As with other path-based filesystem operations, concurrent hostile directory
 * replacement is outside the local trusted-workspace boundary.
 */
export async function deleteLocalFile(base: string, path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const parts = path.split('/')
  if (!path || isAbsolute(path) || /[\\\0!:]/.test(path) ||
    parts.some(part => !part || part === '.' || part === '..')) {
    throw new FileDeleteError('invalid_path')
  }
  const root = await realpath(base)
  const target = resolveInWorkspace(root, path)
  if (!target || target === root) throw new FileDeleteError('invalid_path')
  // Check the parent, not a dereferenced leaf: unlink must never delete a
  // symlink's referent or follow an ancestor outside the selected root.
  const parent = dirname(target)
  const canonicalParent = await realpath(parent)
  if (relative(parent, canonicalParent) !== '') throw new FileDeleteError('invalid_path')
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new FileDeleteError('not_a_file')
  signal.throwIfAborted()
  await unlink(target)
}
