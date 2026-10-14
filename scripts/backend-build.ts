import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileBackend } from './backend-bundle.ts'

/** Check without emitting; Vite consumes TypeScript directly for every launch mode. */
export async function buildBackend(root: string): Promise<void> {
  execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json', '--noEmit',
  ], { cwd: root, stdio: 'inherit' })
  await compileBackend(root, join(root, 'dist'))
}
