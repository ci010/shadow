import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { manageChildren, pnpmInvocation, runPnpm, startNode, waitForExit } from './processes.ts'

test('pnpm launches native Windows and extensionless Unix executables directly', () => {
  const args = ['--filter', '@shadow/desktop', 'build', 'a path with spaces', 'literal;argument']
  for (const cli of [
    'C:\\Program Files\\pnpm\\pnpm.exe',
    '/home/runner/setup-pnpm/node_modules/pnpm/pnpm',
    '/Users/runner/setup-pnpm/node_modules/pnpm/pnpm',
  ]) {
    assert.deepEqual(pnpmInvocation(cli, args), { command: cli, commandArgs: args })
  }
})

test('pnpm JavaScript and Corepack entrypoints still use the current Node runtime', () => {
  for (const extension of ['js', 'cjs', 'mjs', 'CJS']) {
    const cli = join(process.cwd(), 'path with spaces', `pnpm.${extension}`)
    assert.deepEqual(pnpmInvocation(cli, ['typecheck']), {
      command: process.execPath, commandArgs: [cli, 'typecheck'],
    })
  }
  assert.throws(() => pnpmInvocation(undefined, []), /through pnpm/)
  assert.throws(() => pnpmInvocation('', []), /through pnpm/)
})

test('pnpm runner executes native and script entrypoints and propagates failures', async t => {
  await mkdir('.test-data', { recursive: true })
  const cwd = await mkdtemp(join(process.cwd(), '.test-data', 'pnpm entry-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const previous = process.env.npm_execpath
  try {
    process.env.npm_execpath = process.execPath
    await runPnpm(['-e', 'process.exit(0)'])
    await assert.rejects(runPnpm(['-e', 'process.exit(7)']), /exited with code 7/)
    const cli = join(cwd, 'pnpm fixture.cjs')
    const argument = 'spaces and ; shell & characters'
    await writeFile(cli, `process.exit(process.argv[2] === ${JSON.stringify(argument)} ? 0 : 9)\n`)
    process.env.npm_execpath = cli
    await runPnpm([argument])
    await assert.rejects(runPnpm(['wrong']), /exited with code 9/)
    process.env.npm_execpath = join(cwd, 'missing-pnpm')
    await assert.rejects(runPnpm([]), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.npm_execpath
    else process.env.npm_execpath = previous
  }
})

test('desktop development loads the optional root env file and passes it to child processes', async (t) => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const args = manifest.scripts['desktop:dev'].split(' ')
  assert.equal(args[0], 'node')
  assert.equal(args[1], '--env-file-if-exists=.env')
  await mkdir('.test-data', { recursive: true })
  const cwd = await mkdtemp(join(process.cwd(), '.test-data', 'desktop-env-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const checkChild = `
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['-e',
      'process.exit(process.env.SHADOW_DOTENV_FIXTURE === process.argv[1] ? 0 : 1)',
      process.argv[1]], { stdio: 'ignore' });
    process.exit(child.status ?? 1);
  `
  await writeFile(join(cwd, '.env'), 'SHADOW_DOTENV_FIXTURE=synthetic-file-value\n')
  assert.equal(await waitForExit(startNode([args[1], '-e', checkChild, 'synthetic-file-value'], {
    cwd, env: { SHADOW_DOTENV_FIXTURE: undefined },
  })), 0)
  assert.equal(await waitForExit(startNode([args[1], '-e', checkChild, 'synthetic-shell-value'], {
    cwd, env: { SHADOW_DOTENV_FIXTURE: 'synthetic-shell-value' },
  })), 0, 'Explicit environment values take precedence over .env')
  await rm(join(cwd, '.env'))
  assert.equal(await waitForExit(startNode([args[1], '-e', 'process.exit(0)'], { cwd })), 0)
})

test('Node subprocess launcher preserves the environment and reports failures', async () => {
  const child = startNode(['-e', 'process.exit(process.env.SHADOW_SCRIPT_TEST === "present" ? 7 : 9)'], {
    env: { SHADOW_SCRIPT_TEST: 'present' },
  })
  assert.equal(await waitForExit(child), 7)
})

test('waiting for an already signal-terminated process reports failure', { timeout: 5_000 }, async () => {
  const child = startNode(['-e', 'setInterval(() => {}, 1000)'])
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  assert.equal(await waitForExit(child), 1)
})

test('coordinated shutdown terminates owned processes and is idempotent', async () => {
  const child = startNode(['-e', 'setInterval(() => {}, 1000)'])
  const lifecycle = manageChildren([child])
  const first = lifecycle.stop()
  assert.equal(lifecycle.stop(), first)
  await first
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})
