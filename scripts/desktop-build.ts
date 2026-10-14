import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

/** Electron main is ESM; sandboxed preload must remain one self-contained CJS file. */
export async function buildDesktop(root: string, output = join(root, 'desktop/dist')): Promise<void> {
  root = resolve(root)
  output = resolve(output)
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
    '-p', join(root, 'desktop/tsconfig.build.json'), '--noEmit'], { cwd: root, stdio: 'inherit' })
  const external = (id: string) => id === 'electron' || id.startsWith('node:') || builtinModules.includes(id)
  await build({
    configFile: false, publicDir: false,
    build: {
      ssr: true, target: 'node24', outDir: output, emptyOutDir: true, minify: false,
      rollupOptions: {
        input: { main: join(root, 'desktop/src/main.ts') }, external,
        output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: '_chunks/[name]-[hash].js' },
      },
    }, ssr: { noExternal: true },
  })
  await build({
    configFile: false, publicDir: false,
    build: {
      ssr: true, target: 'node24', outDir: output, emptyOutDir: false, minify: false,
      rollupOptions: {
        input: join(root, 'desktop/src/preload.ts'), external,
        output: { format: 'cjs', entryFileNames: 'preload.cjs', codeSplitting: false },
      },
    }, ssr: { noExternal: true },
  })
}

if (import.meta.main) await buildDesktop(resolve(import.meta.dirname, '..'))
