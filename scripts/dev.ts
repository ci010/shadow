import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyNativeBuild } from './agent-desktop-integrity.ts'
import { prepareNativeAfterInstall } from './postinstall-native.ts'
import { manageChildren, runPnpm, startNode } from './processes.ts'

export async function prepareDevelopment(operations: {
  dependenciesReady: () => Promise<boolean>
  install: () => Promise<void>
  prepareNative: () => Promise<void>
  verifyNative: () => Promise<void>
}): Promise<void> {
  if (!await operations.dependenciesReady()) {
    await operations.install()
    if (!await operations.dependenciesReady()) throw new Error('Development dependencies are still missing after pnpm install.')
    // pnpm install already ran the native preparation hook.
  } else {
    await operations.prepareNative()
  }
  await operations.verifyNative()
}

async function main(root: string) {
  await prepareDevelopment({
    async dependenciesReady() {
      try {
        await access(join(root, 'node_modules/.modules.yaml'))
        createRequire(join(root, 'package.json')).resolve('tsx')
        createRequire(join(root, 'desktop/package.json')).resolve('electron')
        createRequire(join(root, 'app/package.json')).resolve('vite')
        return true
      } catch (error) {
        if (['ENOENT', 'MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
      }
    },
    install: () => runPnpm(['install', '--frozen-lockfile', '--prod=false']),
    prepareNative: () => prepareNativeAfterInstall(root),
    async verifyNative() {
      if (process.platform !== 'win32') return
      try {
        await verifyNativeBuild(root, process.arch)
      } catch (cause) {
        throw new Error('Agent Desktop native assets are not ready. Check the install warnings and access to the pinned Windows release, then rerun pnpm dev.', { cause })
      }
    },
  })
  await manageChildren([startNode(['--env-file-if-exists=.env', '--import', 'tsx', 'scripts/desktop.ts', 'dev'])]).wait()
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main(process.cwd())
