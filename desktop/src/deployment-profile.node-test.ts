import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { test } from 'node:test'
import { parseManagedDeploymentProfile, readManagedDeploymentProfile } from './deployment-profile.js'

test('managed daily Main profile is separate from default/test profiles and never selects Child', () => {
  const userDataPath = join(process.cwd(), '.tmp', 'daily-main')
  const profile = { version: 1, role: 'main', userDataPath }
  assert.deepEqual(parseManagedDeploymentProfile(profile), profile)
  for (const value of [{ ...profile, role: 'child' }, { ...profile, userDataPath: 'relative' },
    { ...profile, userDataPath: parse(userDataPath).root }, { ...profile, token: 'unexpected' }, {}]) {
    assert.throws(() => parseManagedDeploymentProfile(value))
  }
})

test('only a managed packaged Mac app reads deployment metadata beside its bundle', async () => {
  const root = await mkdtemp(join(process.cwd(), '.shadow-test-deployment-'))
  try {
    const resources = join(root, 'Shadow.app', 'Contents', 'Resources')
    await mkdir(resources, { recursive: true })
    assert.equal(readManagedDeploymentProfile(resources, true, 'darwin'), undefined)
    const profile = { version: 1, role: 'main', userDataPath: join(root, 'profile-main') }
    await writeFile(join(root, 'desktop-deployment.v1.json'), JSON.stringify(profile), { mode: 0o600 })
    assert.deepEqual(readManagedDeploymentProfile(resources, true, 'darwin'), profile)
    assert.equal(readManagedDeploymentProfile(resources, false, 'darwin'), undefined)
    assert.equal(readManagedDeploymentProfile(resources, true, 'win32'), undefined)
    await writeFile(join(root, 'desktop-deployment.v1.json'), '{invalid')
    assert.throws(() => readManagedDeploymentProfile(resources, true, 'darwin'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
