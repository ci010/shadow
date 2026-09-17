import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildBackend(root: string): Promise<void> {
  // Only this generated output is replaced; runtime data is never a build input.
  const output = join(root, 'dist')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json',
  ], { cwd: root, stdio: 'inherit' })
  await copyAssets(join(root, 'src'), join(output, 'src'), true)
}

async function copyAssets(source: string, target: string, sourceRoot = false): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '__snapshots__' || (sourceRoot && entry.name === 'testing')) continue
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
