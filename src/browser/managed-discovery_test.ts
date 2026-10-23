import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { discoverManagedBrowsers, selectManagedBrowser } from './managed-browsers.ts'
import { BrowserSetupTool } from '../tools/browser-setup.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('installed inventory, matching roots, minimal labels and deterministic selection', async () => withTempWorkspace(async home => {
  const executable = join(home, 'synthetic-edge'), userDataDir = join(home, 'edge-data')
  await writeFile(executable, 'not executable')
  await mkdir(join(userDataDir, 'Default'), { recursive: true })
  await writeFile(join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal', user_name: 'secret@example.com', gaia_name: 'private' } } }, secret: 'never return' }))
  const installations = [{ browser: 'edge' as const, channel: 'stable', executable, userDataDir }]
  let inventory = await discoverManagedBrowsers([...installations, { ...installations[0], executable: join(home, 'absent') }])
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0].id, 'edge:stable')
  assert.deepEqual(inventory[0].profiles, [{ directory: 'Default', displayName: 'Personal' }])
  assert.doesNotMatch(JSON.stringify(inventory), /secret|private|user_name|gaia_name/)
  assert.equal(selectManagedBrowser(inventory, {}).profileDirectory, 'Default')
  assert.equal(selectManagedBrowser(inventory, { profile: 'personal' }).browser, 'edge')
  await mkdir(join(userDataDir, 'Profile 1'))
  await writeFile(join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'secret@example.com' } } } }))
  inventory = await discoverManagedBrowsers(installations)
  assert.throws(() => selectManagedBrowser(inventory, {}), /AMBIGUOUS_PROFILE/)
  assert.equal(selectManagedBrowser(inventory, { profile: 'Personal' }).profileDirectory, 'Default')
  assert.equal(inventory[0].profiles[1].displayName, 'Profile 1')
  assert.throws(() => selectManagedBrowser(inventory, { profile: 'absent' }), /PROFILE_NOT_FOUND/)
  assert.throws(() => selectManagedBrowser([...inventory, { ...inventory[0], id: 'edge:beta', channel: 'beta' }], { browser: 'edge' }), /AMBIGUOUS_BROWSER/)
  assert.equal(selectManagedBrowser([...inventory, { ...inventory[0], id: 'edge:beta', channel: 'beta' }], { installation: 'edge:beta', profile: 'Default' }).browser, 'edge')
  const collision = [{ ...inventory[0], profiles: [{ directory: 'Default', displayName: 'Profile 1' }, { directory: 'Profile 1', displayName: 'Profile 2' }] }]
  assert.throws(() => selectManagedBrowser(collision, { profile: 'Profile 1' }), /AMBIGUOUS_PROFILE/)
  assert.equal(selectManagedBrowser(collision, { profileDirectory: 'Profile 1' }).profileDirectory, 'Profile 1')
  let selected: unknown
  const ctx = { tools: {} } as ExecutionContext
  Object.assign(ctx.tools, { dynamicOwner: ctx.tools })
  const tool = new BrowserSetupTool(async request => { selected = request; return 'bound' }, () => undefined, async () => inventory)
  assert.match(await tool.execute({ action: 'managed', browser: 'edge' }, ctx), /AMBIGUOUS_PROFILE/)
  assert.equal(await tool.execute({ action: 'managed', browser: 'edge', profile: 'Personal' }, ctx), 'bound')
  assert.deepEqual(selected, { action: 'open', target: { mode: 'managed', browser: 'edge', executablePath: executable, userDataDir, profileDirectory: 'Default', arguments: [] } })
  const shared = selectManagedBrowser(inventory, { profile: 'Default' })
  const reuse = new BrowserSetupTool(async () => 'reused', () => shared, async () => { throw new Error('must not rediscover') })
  assert.equal(await reuse.execute({ action: 'managed' }, ctx), 'reused')
  assert.match(await reuse.execute({ action: 'managed', browser: 'brave' }, ctx), /already selected/)
}))

test('shared choice validates explicit constraints without reselecting among profiles or unrelated installations', async () => {
  const shared = { browser: 'edge' as const, executablePath: '/synthetic/edge', userDataDir: '/synthetic/edge-data', profileDirectory: 'Default' }
  const edge = { browser: 'edge' as const, executable: shared.executablePath, userDataDir: shared.userDataDir, id: 'edge:stable', channel: 'stable', profileStatus: 'available' as const,
    profiles: [{ directory: 'Default', displayName: 'Personal' }, { directory: 'Profile 1', displayName: 'Work' }] }
  const inventory = [edge,
    { ...edge, id: 'edge:beta', channel: 'beta', executable: '/synthetic/edge-beta', userDataDir: '/synthetic/edge-beta-data' },
    { ...edge, browser: 'brave' as const, id: 'brave:stable', executable: '/synthetic/brave', userDataDir: '/synthetic/brave-data' }]
  const ctx = { tools: {} } as ExecutionContext
  Object.assign(ctx.tools, { dynamicOwner: ctx.tools })
  let binds = 0
  const tool = new BrowserSetupTool(async request => {
    binds++
    assert.deepEqual(request, { action: 'open', target: { mode: 'managed', ...shared, arguments: [] } })
    return 'reused'
  }, () => shared, async () => inventory)
  for (const selectors of [
    { installation: 'edge:stable' },
    { browser: 'edge', installation: 'edge:stable' },
    { profile: 'Personal' },
    { profile: 'Default' },
    { installation: 'edge:stable', profile: 'Personal' },
  ]) assert.equal(await tool.execute({ action: 'managed', ...selectors }, ctx), 'reused')
  assert.equal(binds, 5)
  for (const selectors of [
    { installation: 'edge:beta' },
    { installation: 'brave:stable' },
    { browser: 'brave' },
    { profile: 'Work' },
    { profileDirectory: 'Profile 1' },
    { installation: 'edge:beta', profile: 'Personal' },
  ]) assert.match(await tool.execute({ action: 'managed', ...selectors }, ctx), /already selected/)
  assert.equal(binds, 5, 'conflicting constraints never bind or replace the shared choice')
})
