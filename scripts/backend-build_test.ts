import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { buildBackend } from './backend-build.ts'

async function fixture(root: string): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'tsconfig.build.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [],
      rootDir: 'src', outDir: 'dist/src', rewriteRelativeImportExtensions: true, noEmitOnError: true,
    },
    include: ['src/**/*.ts'], exclude: ['src/**/*_test.ts', 'src/testing/**'],
  }))
}

test('backend build emits runnable JS, copies nested instruction assets and removes stale output', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'stale.js'), 'stale')
    await writeFile(join(root, 'src', 'index.ts'), "export { value } from './value.ts'\n")
    await writeFile(join(root, 'src', 'value.ts'), 'export const value: number = 42\n')
    await writeFile(join(root, 'src', 'example_test.ts'), 'const broken: number = "not compiled"\n')
    for (const [path, text] of [
      ['skills/builtin/example/SKILL.md', 'instruction'],
      ['agent/types/builtin/example/AGENT.md', 'agent'],
      ['__snapshots__/fixture.snap', 'snapshot'],
      ['testing/fixture.json', '{}'],
    ]) {
      const file = join(root, 'src', path)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, text)
    }
    await buildBackend(root)
    assert.equal((await import(pathToFileURL(join(root, 'dist', 'src', 'index.js')).href)).value, 42)
    assert.equal(await readFile(join(root, 'dist/src/skills/builtin/example/SKILL.md'), 'utf8'), 'instruction')
    assert.equal(await readFile(join(root, 'dist/src/agent/types/builtin/example/AGENT.md'), 'utf8'), 'agent')
    for (const path of ['stale.js', 'src/example_test.js', 'src/__snapshots__/fixture.snap', 'src/testing/fixture.json']) {
      await assert.rejects(readFile(join(root, 'dist', path)), { code: 'ENOENT' })
    }
  })
})

test('backend build rejects compilation failures instead of copying success-shaped assets', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await writeFile(join(root, 'src/index.ts'), 'const value: number = "invalid"\n')
    await writeFile(join(root, 'src/SKILL.md'), 'not yet built')
    await assert.rejects(buildBackend(root))
    await assert.rejects(readFile(join(root, 'dist/src/index.js')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(root, 'dist/src/SKILL.md')), { code: 'ENOENT' })
  })
})
