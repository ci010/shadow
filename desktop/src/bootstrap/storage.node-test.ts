import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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