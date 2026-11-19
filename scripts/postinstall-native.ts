import { mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyNativeBuild } from './agent-desktop-integrity.ts'

export async function acquireNativeInstallLock(root: string, arch: string): Promise<() => Promise<void>> {
  const directory = join(root, 'integrations', 'agent-desktop', 'artifacts')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `.postinstall-win32-${arch}.lock`)
  const file = await open(path, 'wx')
  try {
    await file.writeFile(`pid=${process.pid}\n`)
  } catch (error) {
    await file.close()
    await unlink(path)
    throw error
  }
  return async () => {
    await file.close()
    await unlink(path)
  }
}

async function repair(root: string, arch: string): Promise<void> {
  const { installAgentDesktop } = await import('./download-agent-desktop.ts')
  await installAgentDesktop(root, arch)
}

// Node's built-in type stripping keeps this hook independent of tsx/devDependencies.
export async function prepareNativeAfterInstall(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
  dependencies: {
    verify: typeof verifyNativeBuild
    repair: (root: string, arch: string) => void | Promise<void>
    acquireLock: typeof acquireNativeInstallLock
    info: (message: string) => void
    warn: (message: string) => void
  } = { verify: verifyNativeBuild, repair, acquireLock: acquireNativeInstallLock, info: console.info, warn: console.warn },
): Promise<void> {
  const prefix = '[shadow postinstall]'
  if (platform !== 'win32') return
  if (env.SHADOW_SKIP_NATIVE_BUILD === '1') {
    dependencies.info(`${prefix} Native preparation skipped (SHADOW_SKIP_NATIVE_BUILD=1).`)
    return
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    dependencies.warn(`${prefix} Windows ${arch} is unsupported; native desktop assets require x64 or arm64.`)
    return
  }
  let release: (() => Promise<void>) | undefined
  try {
    try {
      await dependencies.verify(root, arch)
      dependencies.info(`${prefix} Verified cached Windows ${arch} native assets; no build needed.`)
      return
    } catch (error) {
      dependencies.info(`${prefix} Native release assets need preparation: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      release = await dependencies.acquireLock(root, arch)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        dependencies.warn(`${prefix} Another installer may be downloading native assets. No concurrent install started. `
          + `If an install was interrupted, confirm no installer is running before removing `
          + `integrations/agent-desktop/artifacts/.postinstall-win32-${arch}.lock, then rerun pnpm install.`)
        return
      }
      throw error
    }
    // Another installer may have finished between the first check and acquiring the lock.
    let cached = false
    try { await dependencies.verify(root, arch); cached = true } catch (error) {
      dependencies.info(`${prefix} Downloading missing, stale or invalid native release assets: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!cached) await dependencies.repair(root, arch)
    await dependencies.verify(root, arch)
    dependencies.info(`${prefix} Windows ${arch} native assets verified.`)
  } catch (error) {
    dependencies.warn(`${prefix} Native preparation did not complete: ${error instanceof Error ? error.message : String(error)}. `
      + `Dependency installation can continue, but Windows desktop startup still requires valid native assets. `
      + `Check network access to the pinned GitHub release and rerun pnpm install. No local compilation was attempted.`)
  } finally {
    if (release) {
      try { await release() } catch (error) {
        dependencies.warn(`${prefix} Could not release native build lock: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareNativeAfterInstall(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}
