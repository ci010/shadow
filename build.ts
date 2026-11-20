import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileBackend } from './scripts/backend-bundle.ts'

/** Production checks without emitting; development only bundles. */
export async function buildBackend(root: string, output = join(root, 'dist'), { development = false } = {}): Promise<void> {
  if (!development) execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json', '--noEmit',
  ], { cwd: root, stdio: 'inherit' })
  await compileBackend(root, output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const development = args[0] === '--development'
  if (development) args.shift()
  if (args.length && (args.length !== 2 || args[0] !== '--desktop-stage' || !args[1])) {
    throw new Error('Expected [--development] [--desktop-stage <directory>]')
  }
  const output = args[1] ? join(args[1], 'dist') : join(process.cwd(), 'dist')
  // A staged build must never overwrite an existing bundle (even on failure).
  if (args[1]) await mkdir(output)
  await buildBackend(process.cwd(), output, { development })
  console.log(`Built Node backend: ${join(output, 'src', 'index.js')}`)
}
