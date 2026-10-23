import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

const locks = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'LOCK'])
const omitted = new Set(['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'Crashpad', 'BrowserMetrics', 'DevToolsActivePort'])

export interface ProfileSource { userDataDir: string; profileDirectory: string }

async function checkLocks(root: string): Promise<void> {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { await lstat(join(root, name)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error('Source profile is locked. Close the source browser yourself before copying; Shadow does not remove source locks.')
  }
}

/** Explicit selected profile only. Never parse credentials/Local State or infer last_used.
 * Adapted from the historical profile-copy implementation, without whole-root copying,
 * implicit selection, missing-source fallback, or deletion of pre-existing destinations.
 */
export async function copyUserProfile(source: ProfileSource, destination: string, signal?: AbortSignal): Promise<void> {
  if (!isAbsolute(source.userDataDir) || !/^(Default|Profile [0-9]+)$/.test(source.profileDirectory)) {
    throw new Error('Select an absolute user data root and a Default or Profile N directory explicitly.')
  }
  let created = false
  try {
    const rootInfo = await lstat(source.userDataDir)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Source root must be a real directory.')
    const root = await realpath(source.userDataDir)
    // Destination parent is created by the manager, not an agent-selected path.
    const canonicalDestination = join(await realpath(dirname(destination)), basename(destination))
    const rel = relative(root, canonicalDestination)
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Copy destination must be outside the source root.')
    const profileInfo = await lstat(join(root, source.profileDirectory))
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) throw new Error('Selected profile must be a real directory.')
    await checkLocks(root)
    signal?.throwIfAborted()
    await mkdir(destination, { mode: 0o700 }) // EEXIST must never trigger removal
    created = true
    const copy = async (src: string, dst: string): Promise<void> => {
      signal?.throwIfAborted()
      const info = await lstat(src)
      if (info.isSymbolicLink()) throw new Error('Symbolic links in selected profile are not supported.')
      if (info.isDirectory()) {
        await mkdir(dst, { mode: 0o700 })
        for (const name of await readdir(src)) {
          if (!omitted.has(name) && !locks.has(name)) await copy(join(src, name), join(dst, name))
        }
      } else if (info.isFile()) await copyFile(src, dst, constants.COPYFILE_EXCL)
      else throw new Error('Unsupported entry in selected profile.')
    }
    await copy(join(root, source.profileDirectory), join(destination, source.profileDirectory))
    // Opaque copy: may be needed for encryption, but portability is not guaranteed.
    try {
      const stateInfo = await lstat(join(root, 'Local State'))
      if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) throw new Error('Local State must be a real file.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await checkLocks(root)
      signal?.throwIfAborted()
      return
    }
    await copy(join(root, 'Local State'), join(destination, 'Local State'))
    await checkLocks(root)
    signal?.throwIfAborted()
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true })
    // Do not leak filenames, profile content or OS errors containing personal data.
    if (signal?.aborted) throw signal.reason
    throw new Error('Profile copy failed (missing, locked, unsupported or unreadable source, or existing destination). No blank-profile fallback; original profile was not modified.', { cause: error })
  }
}
