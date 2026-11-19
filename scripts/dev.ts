import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { downloadAgentDesktop } from './download-agent-desktop.ts'
import { manageChildren, runPnpm, startNode } from './processes.ts'

export async function prepareDevelopment(root: string, operations = {
  exists: existsSync, install: runPnpm, prepareDesktop: downloadAgentDesktop,
}) {
  const required = ['node_modules/tsx/package.json', 'desktop/node_modules/electron/package.json',
    'app/node_modules/vite/package.json']
  const missingModules = () => required.filter(path => !operations.exists(resolve(root, path)))
  if (missingModules().length) {
    await operations.install(['install', '--frozen-lockfile', '--prod=false'])
    const missing = missingModules()
    if (missing.length) throw new Error(`Development dependencies still missing after pnpm install: ${missing.join(', ')}`)
  }
  await operations.prepareDesktop(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  process.chdir(root)
  await prepareDevelopment(root)
  await manageChildren([startNode(['--env-file-if-exists=.env', '--import', 'tsx',
    'scripts/desktop.ts', 'dev', ...process.argv.slice(2)])]).wait()
}
