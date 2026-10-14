import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/** One decision per Electron process, retained across sidecar/host retries. */
export function createStartupProfileEnvironmentResolver() {
  let checked = false
  let directory: string | undefined
  return (
    paths: { readonly appPath: string; readonly packaged: boolean },
    environment: Readonly<NodeJS.ProcessEnv>,
  ): NodeJS.ProcessEnv => {
    const result = { ...environment }
    delete result.SHADOW_STARTUP_PROFILE_DIR
    // Never inspect repository markers in installed or non-development launches.
    if (paths.packaged || environment.SHADOW_DESKTOP_DEV_IPC !== '1') return result
    if (!checked) {
      checked = true
      if (environment.SHADOW_STARTUP_PROFILE !== '0') {
        // A fresh pnpm dev may already have consumed the marker in its launcher.
        directory = environment.SHADOW_STARTUP_PROFILE_DIR
        try {
          unlinkSync(resolve(paths.appPath, '..', '.logs', 'startup-profile.arm'))
          directory = resolve(paths.appPath, '..', '.logs', 'startup-profiles')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    if (directory) result.SHADOW_STARTUP_PROFILE_DIR = directory
    return result
  }
}

export const resolveStartupProfileEnvironment = createStartupProfileEnvironmentResolver()
