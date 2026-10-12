import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BootstrapCoordinator } from './coordinator.js'
import { defaultMainDirectory } from './main-directory.js'
import { AtomicMainAgentConfigInitializer } from './main-agent-config.js'
import { AtomicRuntimeConfigWriter, FileRuntimeConfigReader, runtimeConfigPath } from './runtime-config.js'
import { createWizardState, transitionWizard, type WizardState } from '../wizard/state-machine.js'

async function fixture(context: TestContext) {
  const root = resolve('.tmp', 'desktop-main-directory-tests')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'case-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = runtimeConfigPath(join(directory, 'profile'))
  const dataDir = defaultMainDirectory(join(directory, 'fake-home'))
  let state: WizardState | null = transitionWizard(createWizardState(), { type: 'select-role', mode: 'main' })
  const storage = {
    load: async () => state,
    save: async (next: WizardState) => { state = next },
    clear: async () => { state = null },
  }
  const reader = new FileRuntimeConfigReader(filePath)
  const writer = new AtomicRuntimeConfigWriter(filePath, () => 'stable-test-node')
  const makeCoordinator = () => new BootstrapCoordinator(
    storage,
    writer,
    new AtomicMainAgentConfigInitializer(filePath),
    { start: async () => ({ phase: 'ready' }) },
    { load: async () => null, save: async () => undefined },
    reader,
    () => dataDir,
  )
  return { directory, filePath, dataDir, reader, writer, storage, makeCoordinator }
}

test('default selection is read-only until explicitly saved and then initializes under fake home', async (context) => {
  const f = await fixture(context)
  const coordinator = f.makeCoordinator()
  const selection = await coordinator.getMainDirectorySelection()
  assert.equal(selection.displayPath, f.dataDir)
  assert.equal(selection.displayName, '.shadow')
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
  await assert.rejects(stat(f.filePath), { code: 'ENOENT' })

  const committed = await coordinator.commitMainDirectory(selection.selectionId)
  assert.equal(committed.ok, true)
  assert.equal(committed.state.step, 'initialize-main')
  assert.equal((await stat(f.dataDir)).isDirectory(), true)
  assert.equal((await f.reader.readMain()).dataDir, f.dataDir)
  const initialized = await coordinator.initializeMain()
  assert.equal(initialized.ok, true)
  assert.equal(initialized.state.step, 'configure-provider')
  const config = JSON.parse(await readFile(join(f.dataDir, 'app.json'), 'utf8'))
  assert.equal(config.agent.workspace, f.dataDir)
  await assert.rejects(stat(join(f.dataDir, 'workspace')), { code: 'ENOENT' })
  assert.equal((await stat(config.agent.workspace)).isDirectory(), true)
})

test('resumed setup uses saved custom config instead of the default and preserves node identity', async (context) => {
  const f = await fixture(context)
  const custom = join(f.directory, 'custom-main')
  await f.writer.writeMain(custom)
  await writeFile(join(custom, 'keep.txt'), 'existing data')
  const configBefore = await readFile(f.filePath, 'utf8')
  const coordinator = f.makeCoordinator()
  const selection = await coordinator.getMainDirectorySelection()
  assert.equal(selection.displayPath, custom)
  assert.equal(await readFile(f.filePath, 'utf8'), configBefore)
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
  assert.equal((await coordinator.commitMainDirectory(selection.selectionId)).ok, true)
  assert.equal(await readFile(f.filePath, 'utf8'), configBefore)
  assert.equal(await readFile(join(custom, 'keep.txt'), 'utf8'), 'existing data')
})

test('custom edits and native selections survive reload without moving or deleting previous data', async (context) => {
  const f = await fixture(context)
  const previous = join(f.directory, 'previous')
  await f.writer.writeMain(previous)
  await writeFile(join(previous, 'keep.txt'), 'keep')
  const custom = join(f.directory, 'custom')
  const coordinator = f.makeCoordinator()
  const selection = await coordinator.selectMainDirectoryPath(join(custom, 'nested', '..'))
  assert.equal(selection.displayPath, custom)
  assert.equal((await coordinator.getMainDirectorySelection()).displayPath, custom)
  await assert.rejects(stat(custom), { code: 'ENOENT' })
  assert.equal((await coordinator.commitMainDirectory(selection.selectionId)).ok, true)
  assert.equal((await f.reader.readMain()).localNodeId, 'stable-test-node')
  assert.equal((await f.reader.readMain()).dataDir, custom)
  assert.equal(await readFile(join(previous, 'keep.txt'), 'utf8'), 'keep')
})

test('unavailable target produces a redacted retryable error without advancing setup', async (context) => {
  const f = await fixture(context)
  const blockingFile = join(f.directory, 'not-a-directory')
  await writeFile(blockingFile, 'do not overwrite')
  const coordinator = f.makeCoordinator()
  const selected = await coordinator.selectMainDirectoryPath(join(blockingFile, 'data'))
  const result = await coordinator.commitMainDirectory(selected.selectionId)
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('Expected write failure')
  assert.equal(result.code, 'write-failed')
  assert.equal(result.state.step, 'choose-data-directory')
  assert.equal(JSON.stringify(result).includes(f.directory), false)
  assert.equal(await readFile(blockingFile, 'utf8'), 'do not overwrite')
  await assert.rejects(stat(f.filePath), { code: 'ENOENT' })
  assert.equal((await coordinator.getMainDirectorySelection()).displayPath, join(blockingFile, 'data'))
  const retry = await coordinator.selectMainDirectoryPath(f.dataDir)
  assert.equal((await coordinator.commitMainDirectory(retry.selectionId)).ok, true)
})

test('invalid saved config fails closed instead of falling back or overwriting it', async (context) => {
  const f = await fixture(context)
  await f.writer.writeMain(join(f.directory, 'existing-main'))
  await writeFile(f.filePath, '{"invalid":"preserve me"}')
  const coordinator = f.makeCoordinator()
  await assert.rejects(coordinator.getMainDirectorySelection(), /Saved Main directory could not be loaded/)
  const selected = await coordinator.selectMainDirectoryPath(f.dataDir)
  assert.equal((await coordinator.commitMainDirectory(selected.selectionId)).ok, false)
  assert.equal(await readFile(f.filePath, 'utf8'), '{"invalid":"preserve me"}')
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})

test('directory IPC operations are unavailable outside the directory step', async (context) => {
  const f = await fixture(context)
  await f.storage.save(createWizardState())
  const coordinator = f.makeCoordinator()
  await assert.rejects(coordinator.getMainDirectorySelection(), /only available during directory setup/)
  await assert.rejects(coordinator.selectMainDirectoryPath(f.dataDir), /only available during directory setup/)
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' })
})
