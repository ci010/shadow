import { basename, resolve, relative, isAbsolute } from 'node:path'
import { lstat, mkdir, readdir, readFile, copyFile, rm } from 'node:fs/promises'
import { getOs } from '../utils/runtime.ts'

/** Resolve only recognized executable names; never guess Chrome for a custom browser. */
export function getDefaultUserDataDir(executable: string, os = getOs(), environment = process.env): string {
  if (/[/\\](?:Chrome Beta|Chrome Dev|Chrome SxS|Edge Beta|Edge Dev|Edge SxS|Brave-Browser-Beta|Brave-Browser-Nightly)[/\\]/i.test(executable)) throw new Error('Non-stable browser channel profile sources are not supported; select the stable browser')
  const name = basename(executable.replaceAll('\\', '/')).toLowerCase().replace(/\.exe$/, '')
  const browser = /^(msedge|microsoft edge|microsoft-edge(-stable)?)$/.test(name) ? 'edge'
    : /^(brave|brave-browser|brave browser)$/.test(name) ? 'brave'
      : /^(chromium|chromium-browser)$/.test(name) ? 'chromium'
        : /^(chrome|google-chrome(-stable)?|google chrome)$/.test(name) ? 'chrome' : undefined
  if (!browser) throw new Error(`Cannot determine user profile source for browser executable: ${executable}`)
  const home = environment.HOME
  if (os === 'windows' && environment.LOCALAPPDATA) {
    return resolve(environment.LOCALAPPDATA, { chrome: 'Google/Chrome/User Data', edge: 'Microsoft/Edge/User Data', brave: 'BraveSoftware/Brave-Browser/User Data', chromium: 'Chromium/User Data' }[browser])
  }
  if (os === 'darwin' && home) return resolve(home, 'Library/Application Support', { chrome: 'Google/Chrome', edge: 'Microsoft Edge', brave: 'BraveSoftware/Brave-Browser', chromium: 'Chromium' }[browser])
  if (os === 'linux' && (environment.XDG_CONFIG_HOME || home)) return resolve(environment.XDG_CONFIG_HOME || resolve(home!, '.config'), { chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'BraveSoftware/Brave-Browser', chromium: 'chromium' }[browser])
  throw new Error(`Cannot determine user profile directory for ${executable}: missing platform home directory`)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']
const omitted = new Set(['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'Crashpad', 'BrowserMetrics', 'DevToolsActivePort'])

/** Read-only snapshot. No lock bypass, symlink traversal, fallback on failure, or write-back. */
export async function copyUserProfile(source: string, destination: string, signal?: AbortSignal): Promise<{ profileDirectory?: string; fresh: boolean }> {
  const relation = relative(resolve(source), resolve(destination))
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation))) throw new Error('Managed profile destination must be outside the user profile source')
  if (await exists(destination)) throw new Error('Managed profile destination already exists; refusing to overwrite it')
  const checkLocks = async () => {
    for (const lock of locks) if (await exists(resolve(source, lock))) throw new Error(`User browser profile is locked (${lock}); close the source browser and retry (remove stale locks only after verifying it is closed)`)
  }
  try {
    signal?.throwIfAborted()
    if (!await exists(source)) {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      return { fresh: true }
    }
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('User profile source must be a real directory, not a symbolic link')
    await checkLocks()
    const profiles = (await readdir(source, { withFileTypes: true })).filter(e => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name)).map(e => e.name)
    let selected: string | undefined
    if (await exists(resolve(source, 'Local State'))) {
      if ((await lstat(resolve(source, 'Local State'))).isSymbolicLink()) throw new Error('Refusing symbolic link for Local State')
      const state = JSON.parse(await readFile(resolve(source, 'Local State'), 'utf8'))
      const lastUsed: unknown = state.profile?.last_used
      if (lastUsed !== undefined && (typeof lastUsed !== 'string' || !profiles.includes(lastUsed))) throw new Error('Local State profile.last_used does not identify an existing supported profile')
      selected = lastUsed as string | undefined
    }
    selected ??= profiles.includes('Default') ? 'Default' : profiles.length === 1 ? profiles[0] : undefined
    if (!selected && profiles.length) throw new Error('Multiple user profiles found without an unambiguous last-used profile')
    const copy = async (src: string, dst: string): Promise<void> => {
      signal?.throwIfAborted()
      const info = await lstat(src)
      if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in user profile: ${src}`)
      if (info.isDirectory()) {
        await mkdir(dst, { recursive: true, mode: 0o700 })
        for (const entry of await readdir(src)) {
          if (!omitted.has(entry)) await copy(resolve(src, entry), resolve(dst, entry))
        }
      } else if (info.isFile()) await copyFile(src, dst)
      else throw new Error(`Unsupported entry in user profile: ${src}`)
    }
    await copy(source, destination)
    await checkLocks()
    signal?.throwIfAborted()
    return { profileDirectory: selected, fresh: profiles.length === 0 }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw new Error(`Failed to copy user browser profile from ${source}; no blank-profile fallback: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
