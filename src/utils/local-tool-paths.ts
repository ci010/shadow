import { homedir } from 'node:os'
import { posix, win32, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

export type LocalTool = 'audio.cpp' | 'stable-diffusion.cpp'

/** Resolve only on the executing device, never from a remote display path.
 * Pure parameters support platform tests; production callers use local defaults.
 * This selects storage, not Project authorization or permission to execute.
 */
export function localToolRoot(tool: LocalTool, platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(home)) throw new Error('Local tool storage requires an absolute device-local home')
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw new Error('Local tool storage requires device-local LOCALAPPDATA')
    return path.join(env.LOCALAPPDATA, tool)
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', tool)
  if (platform !== 'linux') throw new Error(`Unsupported local tool platform: ${platform}`)
  return path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), tool)
}

/** Bounded discovery: direct CLI or versions/<identity>/{,bin/}CLI only.
 * Ambiguous versions require explicit configuration; discovery never probes executables.
 */
export async function discoverLocalToolBinary(root: string, executable: string): Promise<string | undefined> {
  const isFile = async (path: string) => {
    try { return (await stat(path)).isFile() } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  for (const path of [join(root, executable), join(root, 'bin', executable)]) {
    if (await isFile(path)) return path
  }
  let entries
  try { entries = await readdir(join(root, 'versions'), { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (entries.length > 100) return undefined
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const path of [join(root, 'versions', entry.name, executable), join(root, 'versions', entry.name, 'bin', executable)]) {
      if (await isFile(path)) found.push(path)
    }
  }
  return found.length === 1 ? found[0] : undefined
}
