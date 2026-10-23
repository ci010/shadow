import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { SafegitRunner, safegitTarget } from '../src/execution/git/safegit.ts'
import { prepareSafegit, verifySafegitPackage } from './safegit-package.ts'

const exists = async (path: string): Promise<boolean> => {
  try { await access(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Source launch only. Never called by installed applications or release packaging. */
export async function ensureDevelopmentSafegit(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
  dependencies = { exists, prepare: prepareSafegit, verify: verifySafegitPackage,
    status: (binary: string) => new SafegitRunner(() => binary).status() },
): Promise<void> {
  try {
    if (env.SHADOW_SAFEGIT_PATH !== undefined) {
      if (!isAbsolute(env.SHADOW_SAFEGIT_PATH)) throw new Error('SHADOW_SAFEGIT_PATH must be absolute')
      const status = await dependencies.status(env.SHADOW_SAFEGIT_PATH)
      if (!status.supported) throw new Error(status.reason ?? 'Unsupported safegit host')
      return // Explicit configuration is never downloaded over or replaced.
    }
    if (!safegitTarget(platform, arch)) throw new Error(`Unsupported safegit host: ${platform}/${arch}`)
    const directory = join(root, 'desktop', 'safegit')
    const binary = join(directory, platform === 'win32' ? 'safegit.exe' : 'safegit')
    const [hasBinary, hasInventory] = await Promise.all([
      dependencies.exists(binary), dependencies.exists(join(directory, 'release.json')),
    ])
    if (!hasBinary && !hasInventory) await dependencies.prepare(root, platform, arch)
    // Present/partial/corrupt installations must not silently download or replace files.
    // Repair explicitly with scripts/safegit-package.ts after investigating the failure.
    await dependencies.verify(root, platform, arch)
  } catch (error) {
    throw new Error('Development safegit preparation failed. Check SHADOW_SAFEGIT_PATH or repair with '
      + 'pnpm exec node --import tsx scripts/safegit-package.ts; no PATH/raw Git fallback.', { cause: error })
  }
}
