import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle only trusted dependencies. Snapshot code is never sent through esbuild.
await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['sandbox-worker.mjs'],
  bundle: true,
  format: 'iife',
  banner: { js: '"use strict";' },
  platform: 'browser',
  target: 'es2022',
  outfile: 'generated/worker-source.js',
  write: false,
  minifyWhitespace: true,
  legalComments: 'inline',
}).then(async ({ outputFiles }) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(new URL('./generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('./generated/worker-source.js', import.meta.url), `export default ${JSON.stringify(outputFiles[0].text)};\n`);
  await writeFile(new URL('./generated/worker-source.d.ts', import.meta.url), 'declare const source: string;\nexport default source;\n');
});
