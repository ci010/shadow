import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This directory is generated output, never the user's runtime workspace.
await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

execFileSync(process.execPath, [
  fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
  '-p', 'tsconfig.build.json',
], { stdio: 'inherit' })

await copyAssets('src', 'dist/src')
console.log('Built Node backend: dist/src/index.js')

async function copyAssets(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '__snapshots__') continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await copyAssets(from, to)
    } else if (!entry.name.endsWith('.ts')) {
      await mkdir(target, { recursive: true })
      await cp(from, to)
    }
  }
}
