import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { withTempWorkspace } from '../src/testing/workspace.ts'

test('compiled root entry reaches migration with bundled-runtime argument shapes, no tsx', async () => {
  await withTempWorkspace(async root => {
    const repository = fileURLToPath(new URL('..', import.meta.url))
    const output = join(root, 'dist/src')
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
      '-p', join(repository, 'tsconfig.build.json'), '--outDir', output], { cwd: repository, stdio: 'pipe' })
    await cp(join(repository, 'src'), output, { recursive: true, filter: path => !path.endsWith('.ts') && !/[\\/](__snapshots__|testing)([\\/]|$)/.test(path) })
    const data = join(root, 'synthetic-data')
    await mkdir(join(data, 'config'), { recursive: true })
    await mkdir(join(data, 'workspace.projects/projects/default/workspace'), { recursive: true })
    await writeFile(join(data, 'config/bot.config.json'), JSON.stringify({ agent: { workspace: data } }))
    await writeFile(join(data, 'workspace.projects/projects.v2.json'), JSON.stringify({ version: 2, projects: [{ id: 'default' }], folders: [] }))
    const entry = join(output, 'index.js')
    const bundledRuntime: string = createRequire(new URL('../desktop/package.json', import.meta.url))('electron')
    const run = (args: string[]) => execFileSync(bundledRuntime, [entry, 'data-migration', '--data-dir', data, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe',
    })
    assert.match(run(['--plan']), /"preliminary":true/)
    await assert.rejects(readFile(join(data, 'app.json')), { code: 'ENOENT' })
    assert.throws(() => run(['--copy']), /Command failed/)
    const migrated = spawnSync(bundledRuntime, [entry, 'data-migration', '--data-dir', data, '--copy', '--offline', '--progress'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.equal(migrated.status, 0, migrated.stderr)
    assert.match(migrated.stdout, /"status":"copied"/)
    assert.equal(JSON.parse(migrated.stdout).status, 'copied')
    const progress = migrated.stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.equal(progress[0].type, 'migration-progress')
    assert.equal(progress[0].phase, 'inventory')
    assert.equal(progress.at(-1).phase, 'complete')
    assert.ok(await readFile(join(data, '.layout-migration/receipt.json'), 'utf8'))
    assert.match(run(['--copy', '--offline']), /"status":"already-copied"/)
    // Some packaged launchers omit the script slot in argv.
    const cli = join(output, 'runtime/main/cli.js')
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { runRootProcessEntry } from ${JSON.stringify(pathToFileURL(cli).href)};\n` +
      `const result = await runRootProcessEntry({argv:['exe','data-migration','--data-dir',${JSON.stringify(data)},'--plan'],on(){},off(){},exit(){throw Error('unexpected exit')}});\n` +
      `if(result.route !== 'data-migration') throw Error('wrong route');`], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })
    assert.match(result, /"preliminary":true/)
  })
})
