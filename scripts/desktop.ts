import { type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { manageChildren, runPnpm } from './processes.ts'
import { forwardDesktopEndpoint } from './desktop-endpoint.ts'
import { createReleaseManifest, sourceFingerprint } from './release-manifest.ts'
import { prepareReleaseDownloads } from './release-downloads.ts'

const mode = process.argv[2] ?? 'build'
if (mode !== 'build' && mode !== 'dev') {
  throw new TypeError(`Unknown desktop mode "${mode}". Use "build" or "dev".`)
}

const sourceHash = mode === 'build' ? await sourceFingerprint(process.cwd()) : undefined
if (mode === 'build') {
  if (process.platform !== 'win32') throw new Error('The release target is Windows x64.')
  if (process.arch !== 'x64') throw new Error('The release target currently requires a Windows x64 build host.')
  await runPnpm(['typecheck'])
  await runPnpm(['test:release'])
}
await runPnpm(['build'])
await runPnpm(['--filter', '@shadow/desktop', 'build'])

if (mode === 'build') {
  await runPnpm(['build:app'])
  await rm('desktop/backend', { recursive: true, force: true })
  await runPnpm([
    '--filter', '@shadow/shadow', 'deploy', '--prod',
    '--node-linker', 'hoisted', 'desktop/backend',
  ])
  const electronDist = await prepareReleaseDownloads(process.cwd())
  await createReleaseManifest(process.cwd(), sourceHash!)
  await runPnpm(['--filter', '@shadow/desktop', 'dist', `--config.electronDist=${electronDist}`])
  await runPnpm(['test:packaged'])
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
  const children: ChildProcess[] = [vite]
  const lifecycle = manageChildren(children)
  const startupFailure = new Promise<never>((_resolve, reject) => {
    vite.once('error', reject)
    vite.once('exit', (code) => reject(new Error(`Vite exited with code ${code}`)))
  })
  try {
    await Promise.race([waitForRenderer(url), startupFailure])
    const require = createRequire(new URL('../desktop/package.json', import.meta.url))
    const executable: string = require('electron')
    const environment: NodeJS.ProcessEnv = {
      ...process.env, VITE_DEV_URL: url, SHADOW_DESKTOP_DEV_IPC: '1',
      SHADOW_BROWSER_PIN_FILE: resolve(process.env.SHADOW_BROWSER_PIN_FILE ?? '.pin'),
    }
    delete environment.ELECTRON_RUN_AS_NODE
    const electron = spawn(executable, ['.'], {
      cwd: 'desktop',
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: environment,
      shell: false,
    })
    children.push(electron)
    forwardDesktopEndpoint(electron, vite)
    await lifecycle.wait()
  } finally {
    await lifecycle.stop()
  }
}

async function waitForRenderer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite did not become ready at ${url}`)
}
