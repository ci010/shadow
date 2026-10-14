import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDataLayoutReady, detectDataLayout } from './data-layout-startup.ts'
import { copyDataMigration } from './data-migration.ts'
import { runDataMigrationCli } from './data-migration-cli.ts'
import { AtomicMainAgentConfigInitializer } from '../../desktop/src/bootstrap/main-agent-config.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'layout-startup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function legacy(root: string) {
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'workspace.projects/projects/default/workspace'), { recursive: true })
  await writeFile(join(root, 'config/bot.config.json'), JSON.stringify({ agent: { workspace: root } }))
  await writeFile(join(root, 'workspace.projects/projects.v2.json'), JSON.stringify({ version: 2, projects: [{ id: 'default', name: 'Default', createdAt: '2026-01-01T00:00:00Z' }], folders: [] }))
}

test('new root gate is read-only; Desktop can initialize a new root', async t => {
  const parent = await fixture(t)
  const root = join(parent, 'new')
  await assertDataLayoutReady(root)
  assert.deepEqual(await readdir(parent), [])
  const config = join(parent, 'bootstrap.json')
  await writeFile(config, JSON.stringify({ version: 1, mode: 'main', dataDir: root, localNodeId: 'local' }))
  await new AtomicMainAgentConfigInitializer(config).initialize()
  assert.ok(await readFile(join(root, 'app.json'), 'utf8'))
})

test('legacy startup fails before Desktop writes; explicit offline copy resumes and never replays', async t => {
  const root = await fixture(t)
  await legacy(root)
  const config = join(root, 'bootstrap.json')
  await writeFile(config, JSON.stringify({ version: 1, mode: 'main', dataDir: root, localNodeId: 'local' }))
  await assert.rejects(assertDataLayoutReady(root), /Legacy data layout/)
  await assert.rejects(new AtomicMainAgentConfigInitializer(config).initialize(), /Legacy data layout/)
  await assert.rejects(readFile(join(root, 'app.json')), { code: 'ENOENT' })
  assert.equal((await copyDataMigration(root, { offline: true })).status, 'copied')
  await assertDataLayoutReady(root)
  await writeFile(join(root, 'projects/default/state/after-launch'), 'normal writes')
  await assertDataLayoutReady(root)
  await new AtomicMainAgentConfigInitializer(config).initialize()
  assert.ok(await readFile(join(root, 'config/bot.config.json'), 'utf8'))
})

test('locks and incomplete receipts fail closed even with new targets', async t => {
  const root = await fixture(t)
  await legacy(root)
  await copyDataMigration(root, { offline: true })
  await mkdir(join(root, '.layout-migration/copy.lock'))
  await assert.rejects(assertDataLayoutReady(root), /interrupted/)
  await rm(join(root, '.layout-migration/copy.lock'), { recursive: true })
  await rm(join(root, 'app.json'))
  await assert.rejects(assertDataLayoutReady(root), /incomplete/)
})

test('offline CLI rejects missing acknowledgement and unsupported layouts without new app data', async t => {
  const root = await fixture(t)
  await legacy(root)
  await assert.rejects(runDataMigrationCli(['--data-dir', root, '--copy']), /ALL writers/)
  await writeFile(join(root, 'config/unmapped'), 'preserve')
  await assert.rejects(runDataMigrationCli(['--data-dir', root, '--copy', '--offline']), /Unmapped/)
  await assert.rejects(readFile(join(root, 'app.json')), { code: 'ENOENT' })
  await assert.rejects(assertDataLayoutReady(root), /Legacy/)
})


test('Main/service entry checks data before loading mutable config or starting runtime', async t => {
  const { runProcessEntry } = await import('../runtime/process-entry.ts')
  const { ConfigSchema } = await import('../config/schema.ts')
  const root = await fixture(t)
  await legacy(root)
  const calls: string[] = []
  const dependencies = {
    prepareMainData: async (path: string) => { calls.push('gate'); await assertDataLayoutReady(path) },
    loadConfig: async () => { calls.push('load'); return ConfigSchema.parse({}) },
    startMainRuntime: async () => { calls.push('start'); return { ready: Promise.resolve(), finished: Promise.resolve(), shutdown: async () => {} } },
    startChildRuntime: async () => { throw new Error('unexpected child') },
    runLegacy: async () => { throw new Error('unexpected legacy') },
    runtime: {
      readTextFile: async () => JSON.stringify({ version: 1, mode: 'main', dataDir: root, localNodeId: 'main' }),
      process: { on() {}, off() {}, exit() {} },
      env: { WINDOWS_USE_LAUNCH_TOKEN: 'synthetic-test', GATEWAY_PORT: '43210' },
    },
  }
  await assert.rejects(runProcessEntry(['exe', 'entry.js', 'server', 'start', '--config', join(root, 'bootstrap.json'), '--service'], dependencies), /Legacy/)
  assert.deepEqual(calls, ['gate'])
  await copyDataMigration(root, { offline: true })
  calls.length = 0
  await runProcessEntry(['exe', 'entry.js', 'server', 'start', '--config', join(root, 'bootstrap.json')], dependencies)
  assert.deepEqual(calls, ['gate', 'load', 'start'])
})

test('Desktop and backend use identical read-only layout policy', async () => {
  assert.equal(await readFile(new URL('./data-layout-startup.ts', import.meta.url), 'utf8'),
    await readFile(new URL('../../desktop/src/bootstrap/data-layout-startup.ts', import.meta.url), 'utf8'))
})


test('directory selection refuses legacy root before protected bootstrap config publication', async t => {
  const { AtomicRuntimeConfigWriter } = await import('../../desktop/src/bootstrap/runtime-config.ts')
  const parent = await fixture(t)
  const root = join(parent, 'old')
  await legacy(root)
  const protectedPath = join(parent, 'bootstrap/runtime-config.json')
  await assert.rejects(new AtomicRuntimeConfigWriter(protectedPath).writeMain(root), /Legacy/)
  await assert.rejects(readFile(protectedPath), { code: 'ENOENT' })
  assert.deepEqual((await readdir(parent)).sort(), ['old'])
})


test('unsupported standalone legacy sibling blocks before root creation', async t => {
  const parent = await fixture(t)
  const root = join(parent, 'workspace')
  await mkdir(`${root}.projects`)
  await writeFile(join(`${root}.projects`, 'projects.v2.json'), '{}')
  await assert.rejects(assertDataLayoutReady(root), /standalone/)
  assert.deepEqual(await readdir(parent), ['workspace.projects'])
})


test('read-only UI detection classifies new, legacy, interrupted and invalid roots', async t => {
  const root = await fixture(t)
  const before = await readdir(root)
  assert.deepEqual(await detectDataLayout(root), { status: 'ready' })
  assert.deepEqual(await readdir(root), before)
  await mkdir(join(root, 'config'))
  assert.equal((await detectDataLayout(root)).status, 'migration-required')
  await mkdir(join(root, '.layout-migration/copy.lock'), { recursive: true })
  assert.equal((await detectDataLayout(root)).status, 'blocked')
  await rm(join(root, '.layout-migration/copy.lock'), { recursive: true })
  await writeFile(join(root, '.layout-migration/receipt.json'), '{}')
  assert.equal((await detectDataLayout(root)).status, 'blocked')
})
