import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AtomicLaunchProfileStore,
  launchProfilePath,
  parseMainLaunchProfile,
} from './launch-profile.js'

const profile = { version: 1, role: 'main', port: 43123, localExecutor: true } as const

test('launch profile is written atomically with protected permissions and can be overwritten idempotently', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-launch-profile-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = launchProfilePath(directory)
  const store = new AtomicLaunchProfileStore(filePath)

  await store.save(profile)
  await store.save(profile)

  assert.deepEqual(await store.load(), profile)
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), profile)
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600)
})

test('launch profile reader requires the exact non-secret schema', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-launch-profile-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = launchProfilePath(directory)
  const store = new AtomicLaunchProfileStore(filePath)
  assert.equal(await store.load(), null)

  await writeFile(filePath, JSON.stringify({ ...profile, token: 'secret' }), 'utf8').catch(async () => {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(filePath), { recursive: true }))
    await writeFile(filePath, JSON.stringify({ ...profile, token: 'secret' }), 'utf8')
  })
  await assert.rejects(store.load(), /Launch profile is invalid/)

  for (const value of [
    { ...profile, version: 2 },
    { ...profile, role: 'child' },
    { ...profile, port: 0 },
    { ...profile, localExecutor: 'yes' },
  ]) {
    assert.throws(() => parseMainLaunchProfile(value), /Launch profile is invalid/)
  }
})