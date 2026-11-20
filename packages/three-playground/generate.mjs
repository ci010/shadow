import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle only trusted dependencies. Snapshot code is never sent through esbuild.
await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['engine.mjs'],
  bundle: true,
  format: 'esm',
  inject: ['./export-shims.mjs'],
  platform: 'browser',
  target: 'es2022',
  outfile: 'generated/engine-source.js',
  write: false,
  minifyWhitespace: true,
  legalComments: 'inline',
}).then(async ({ outputFiles }) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(new URL('./generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('./generated/engine-source.js', import.meta.url), `export default ${JSON.stringify(outputFiles[0].text)};\n`);
  await writeFile(new URL('./generated/engine-source.d.ts', import.meta.url), 'declare const source: string;\nexport default source;\n');
});
