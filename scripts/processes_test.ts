import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { manageChildren, startNode, waitForExit } from './processes.ts'

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
