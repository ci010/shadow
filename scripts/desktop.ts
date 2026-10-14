import { consumeStartupProfileArm } from './startup-profile.ts'
import { createRequire } from 'node:module'
import { stageBackend } from './backend-bundle.ts'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pnpmInvocation, runPnpm } from './processes.ts'
import { superviseDesktopDevelopment } from './desktop-development.ts'
import { createReleaseManifest, sourceFingerprint } from './release-manifest.ts'
import { prepareReleaseDownloads } from './release-downloads.ts'
import { desktopTarget } from './desktop-target.ts'
import { verifyPreparedBuild } from './prepared-build.ts'
import { prepareAria2Signing, verifyAria2Package } from './aria2-package.ts'

const mode = process.argv[2] ?? 'build'
if (mode !== 'build' && mode !== 'dev' && mode !== 'package') {
  throw new TypeError(`Unknown desktop mode "${mode}". Use "build", "package" or "dev".`)
}

const target = mode !== 'dev' ? desktopTarget() : undefined
const sourceHash = mode === 'package' ? await verifyPreparedBuild(process.cwd(), 'desktop')
  : target ? await sourceFingerprint(process.cwd()) : undefined
if (mode !== 'package') {
  await runPnpm(['build'])
  await runPnpm(['--filter', '@shadow/desktop', 'build'])
}

if (target) {
  if (mode !== 'package') await runPnpm(['build:app'])
  // Reuse the same checked Vite output as development (or the verified prepared build).
  await stageBackend(process.cwd(), resolve('desktop/backend'))
  const electronDist = await prepareReleaseDownloads(process.cwd(), process.env, target)
  await verifyAria2Package(process.cwd(), target)
  await prepareAria2Signing(process.cwd(), target)
  await createReleaseManifest(process.cwd(), sourceHash!)
  await runPnpm(['--filter', '@shadow/desktop', 'dist', target.builderFlag, target.format, `--${target.arch}`, `--config.electronDist=${electronDist}`])
} else {
  const port = process.env.VITE_DEV_PORT ?? '5273'
  const url = `http://127.0.0.1:${port}`
  const vite = spawn(process.execPath, [
    'node_modules/vite/bin/vite.js', '--host', process.env.VITE_DEV_HOST ?? '0.0.0.0',
    '--port', port, '--strictPort',
  ], {
    cwd: 'app',
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, SHADOW_DESKTOP_DEV_IPC: '1',
      SHADOW_BROWSER_PIN_FILE: resolve(process.env.SHADOW_BROWSER_PIN_FILE ?? '.pin') },
    shell: false,
  })
  const require = createRequire(new URL('../desktop/package.json', import.meta.url))
  const executable: string = require('electron')
  const environment: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development', VITE_DEV_URL: url, SHADOW_DESKTOP_DEV_IPC: '1',
    SHADOW_BROWSER_PIN_FILE: resolve(process.env.SHADOW_BROWSER_PIN_FILE ?? '.pin'),
  }
  // Consume a local one-shot marker only on a fresh manual dev launch.
  // A failed first sidecar and its retry share this bounded diagnostic launch.
  delete environment.SHADOW_STARTUP_PROFILE_DIR
  const startupProfileDirectory = consumeStartupProfileArm(process.cwd(), process.env)
  if (startupProfileDirectory) environment.SHADOW_STARTUP_PROFILE_DIR = startupProfileDirectory
  delete environment.ELECTRON_RUN_AS_NODE
  await superviseDesktopDevelopment({
    vite,
    ready: signal => waitForRenderer(url, signal),
    spawnElectron: () => spawn(executable, ['.'], {
      cwd: 'desktop',
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: environment,
      shell: false,
    }),
    spawnBuild: args => {
      const { command, commandArgs } = pnpmInvocation(process.env.npm_execpath, args)
      return spawn(command, commandArgs, { stdio: 'inherit', shell: false })
    },
  }).run()
}

async function waitForRenderer(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (signal.aborted) return
    try {
      if ((await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) })).ok) return
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite did not become ready at ${url}`)
}
