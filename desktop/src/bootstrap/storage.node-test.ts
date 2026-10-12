import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AtomicFileBootstrapStateStorage,
  bootstrapStatePath,
} from './storage.js'
import { createWizardState, transitionWizard } from '../wizard/state-machine.js'

test('atomic file storage round-trips and clears validated wizard state', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-desktop-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = bootstrapStatePath(directory)
  const storage = new AtomicFileBootstrapStateStorage(filePath)
  const state = transitionWizard(createWizardState(), { type: 'select-role', mode: 'child' })

  assert.equal(await storage.load(), null)
  await storage.save(state)
  assert.deepEqual(await storage.load(), state)
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true)
  const advanced = transitionWizard(state, { type: 'pairing-offer-entered' })
  await storage.save(advanced)
  assert.deepEqual(await storage.load(), advanced)
  await storage.clear()
  assert.equal(await storage.load(), null)
})

test('atomic file storage rejects invalid persisted state', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-desktop-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const storage = new AtomicFileBootstrapStateStorage(join(directory, 'state.json'))
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(storage.filePath, '{"version":2}', 'utf8')
  )
  await assert.rejects(storage.load(), /Unsupported wizard state version/)
})
test('durable Main execution preference and legacy capability-step migration survive storage reload', async context => {
  const scratch = fileURLToPath(new URL('../../../.tmp/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'wizard-state-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = bootstrapStatePath(directory)
  for (const localExecutor of [true, false]) {
    const state = transitionWizard(createWizardState(), { type: 'select-role', mode: 'main', localExecutor })
    await new AtomicFileBootstrapStateStorage(filePath).save(state)
    assert.deepEqual(await new AtomicFileBootstrapStateStorage(filePath).load(), state)
  }
  const legacy = { version: 1, revision: 4, mode: 'main', step: 'choose-local-capabilities' }
  await writeFile(filePath, JSON.stringify(legacy))
  assert.deepEqual(await new AtomicFileBootstrapStateStorage(filePath).load(), { ...legacy, step: 'launch-main' })
})
