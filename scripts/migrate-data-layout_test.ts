import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-data-layout.ts', ...args], { cwd: resolve('.'), encoding: 'utf8' })
}
test('migration CLI requires explicit data root and validates arguments before IO', () => {
  for (const args of [[], ['--unknown'], ['--data-dir'], ['--data-dir', 'synthetic', '--copy', '--plan'], ['--data-dir', 'synthetic', '--offline']]) assert.equal(cli(...args).status, 1)
  const copy = cli('--data-dir', 'nonexistent-synthetic-root', '--copy')
  assert.equal(copy.status, 1)
  assert.match(copy.stderr, /offline acknowledgement/)
})
test('migration CLI help documents stopped-writer obligation and recovery evidence', () => {
  const result = cli('--help')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /STOP ALL/)
  assert.match(result.stdout, /cannot prove/)
  assert.match(result.stdout, /copy.lock/)
})
test('migration CLI defaults to preliminary read-only plan, copy requires acknowledgement', async t => {
  const root = await mkdtemp(join(resolve('.'), '.test-layout-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/bot.config.json'), '{"agent":{"workspace":"old"}}')
  await mkdir(join(root, 'workspace.projects/projects/default/workspace'), { recursive: true })
  await writeFile(join(root, 'workspace.projects/projects.v2.json'), '{"version":2,"projects":[{"id":"default"}],"folders":[]}')
  const before = await readdir(root)
  const plan = cli('--data-dir', root)
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).preliminary, true)
  assert.deepEqual(await readdir(root), before)
  const copy = cli('--data-dir', root, '--copy', '--offline')
  assert.equal(copy.status, 0, copy.stderr)
  assert.equal(JSON.parse(copy.stdout).status, 'copied')
})
