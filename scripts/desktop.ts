import { type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { manageChildren, runPnpm, startNode } from './processes.ts'

const mode = process.argv[2] ?? 'build'
if (mode !== 'build' && mode !== 'dev') {
  throw new TypeError(`Unknown desktop mode "${mode}". Use "build" or "dev".`)
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
  await runPnpm(['--filter', '@shadow/desktop', 'dist'])
} else {
  const port = process.env.VITE_DEV_PORT ?? '5273'
  const url = `http://127.0.0.1:${port}`
  const vite = startNode([
    'node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
    '--port', port, '--strictPort',
  ], { cwd: 'app' })
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
    const environment: NodeJS.ProcessEnv = { ...process.env, VITE_DEV_URL: url }
    delete environment.ELECTRON_RUN_AS_NODE
    children.push(spawn(executable, ['.'], {
      cwd: 'desktop',
      stdio: 'inherit',
      env: environment,
      shell: false,
    }))
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
