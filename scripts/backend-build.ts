import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileBackend } from './backend-bundle.ts'

/** Production checks without emitting; development only bundles. */
export async function buildBackend(root: string, output = join(root, 'dist'), { development = false } = {}): Promise<void> {
  if (!development) execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json', '--noEmit',
  ], { cwd: root, stdio: 'inherit' })
  await compileBackend(root, output)
}
