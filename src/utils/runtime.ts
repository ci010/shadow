/**
 * Platform names used in configuration, prompts, and persisted metadata.
 *
 * Returns stable names (`'windows' | 'darwin' | 'linux' | ...`
 * for OS, `'x86_64' | 'aarch64' | ...` for arch) so that existing comparisons,
 * config values, and persisted metadata continue to work unchanged when the
 * code runs under Node.js.
 */

import process from 'node:process'

export type RuntimeOs =
  | 'windows'
  | 'darwin'
  | 'linux'
  | 'freebsd'
  | 'netbsd'
  | 'aix'
  | 'solaris'
  | 'illumos'
  | 'android'

export type RuntimeArch =
  | 'x86_64'
  | 'aarch64'

/** Returns the current OS name used in configuration. */
export function getOs(): RuntimeOs {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'darwin'
    case 'linux':
      return 'linux'
    case 'freebsd':
      return 'freebsd'
    case 'aix':
      return 'aix'
    case 'sunos':
      return 'solaris'
    case 'android':
      return 'android'
    default:
      // Best-effort fallback - covers netbsd / illumos under newer node.
      return (process.platform as RuntimeOs) ?? 'linux'
  }
}

/** Returns the current CPU architecture used in configuration. */
export function getArch(): RuntimeArch {
  switch (process.arch) {
    case 'x64':
      return 'x86_64'
    case 'arm64':
      return 'aarch64'
    default:
      // The supported distributions target x86_64 and aarch64.
      return 'x86_64'
  }
}

/** True when running on Windows. Cheap convenience. */
export const isWindows = getOs() === 'windows'

/** True when a thrown filesystem error refers to a missing path. */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  return code === 'ENOENT'
}
