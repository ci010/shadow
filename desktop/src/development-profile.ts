import { isAbsolute, resolve } from 'node:path'
import { defaultMainDirectory } from './bootstrap/main-directory.js'
import { normalizeMainDirectoryPath } from './bootstrap/runtime-config.js'

export function resolveDesktopUserDataPath(
  appPath: string,
  packaged: boolean,
  override?: string,
): string | undefined {
  if (override) {
    if (!isAbsolute(override)) throw new TypeError('Desktop user data directory must be absolute')
    return resolve(override)
  }

  return packaged ? undefined : resolve(appPath, '..', '.tmp', 'desktop-dev', 'user-data')
}

export function resolveDesktopMainDirectory(
  appPath: string,
  packaged: boolean,
  developmentOverride?: string,
  homeDirectory?: string,
): string {
  if (packaged) return defaultMainDirectory(homeDirectory)
  return normalizeMainDirectoryPath(
    developmentOverride || resolve(appPath, '..', '.tmp', 'desktop-dev', 'data'),
  )
}
