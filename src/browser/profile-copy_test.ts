import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises'
import { copyUserProfile, getDefaultUserDataDir } from './profile-copy.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ChromeManager, ChromePortAllocator, browserProcessArguments } from './chrome-manager.ts'

test('profile source follows the actual executable and platform, not a Chrome fallback', () => {
  const environment = { LOCALAPPDATA: join(process.cwd(), 'local'), HOME: join(process.cwd(), 'home'), XDG_CONFIG_HOME: join(process.cwd(), 'xdg') }
  assert.equal(getDefaultUserDataDir('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'windows', environment), join(environment.LOCALAPPDATA, 'Microsoft/Edge/User Data'))
  assert.equal(getDefaultUserDataDir('/usr/bin/chromium', 'linux', environment), join(environment.XDG_CONFIG_HOME, 'chromium'))
  assert.equal(getDefaultUserDataDir('/usr/bin/google-chrome-stable', 'linux', environment), join(environment.XDG_CONFIG_HOME, 'google-chrome'))
  assert.equal(getDefaultUserDataDir('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'darwin', environment), join(environment.HOME, 'Library/Application Support/BraveSoftware/Brave-Browser'))
  assert.equal(getDefaultUserDataDir('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'darwin', environment), join(environment.HOME, 'Library/Application Support/Microsoft Edge'))
  assert.throws(() => getDefaultUserDataDir('C:\\Chrome Beta\\chrome.exe'), /Non-stable/)
  assert.throws(() => getDefaultUserDataDir('/custom/unknown'), /Cannot determine user profile source/)
  assert.throws(() => getDefaultUserDataDir('chrome.exe', 'windows', {}), /missing platform home/)
})

test('copies Local State and all profiles, selects last-used, excludes caches, never writes back', async () => {
  await withTempWorkspace(async root => {
    const src = join(root, 'source'), dst = join(root, 'snapshot')
    for (const profile of ['Default', 'Profile 2']) {
      await mkdir(join(src, profile, 'Network'), { recursive: true })
      await writeFile(join(src, profile, 'Network', 'Cookies'), 'synthetic fixture, not real credentials')
    }
    await mkdir(join(src, 'Profile 2', 'Cache'))
    await writeFile(join(src, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2' }, os_crypt: { encrypted_key: 'synthetic' } }))
    assert.deepEqual(await copyUserProfile(src, dst), { fresh: false, profileDirectory: 'Profile 2' })
    assert.equal(await readFile(join(dst, 'Local State'), 'utf8'), await readFile(join(src, 'Local State'), 'utf8'))
    assert.deepEqual(await readdir(join(dst, 'Profile 2')), ['Network'])
    await writeFile(join(dst, 'Profile 2', 'Network', 'Cookies'), 'changed copy')
    assert.equal(await readFile(join(src, 'Profile 2', 'Network', 'Cookies'), 'utf8'), 'synthetic fixture, not real credentials')
    assert(browserProcessArguments(9222, dst, true, 'Profile 2').includes('--profile-directory=Profile 2'))
  })
})

test('missing source permits a fresh profile; locks, bad metadata, links and failed copies fail closed', async () => {
  await withTempWorkspace(async root => {
    const src = join(root, 'source'), dst = join(root, 'snapshot')
    assert.deepEqual(await copyUserProfile(src, dst), { fresh: true })
    await mkdir(join(src, 'Default'), { recursive: true })
    await writeFile(join(src, 'SingletonLock'), 'synthetic lock')
    await assert.rejects(copyUserProfile(src, join(root, 'locked')), /profile is locked/)
    const { unlink } = await import('node:fs/promises')
    await unlink(join(src, 'SingletonLock'))
    await writeFile(join(src, 'Local State'), '{invalid')
    await assert.rejects(copyUserProfile(src, join(root, 'bad-state')), /no blank-profile fallback/)
    await writeFile(join(src, 'Local State'), JSON.stringify({ profile: { last_used: '../outside' } }))
    await assert.rejects(copyUserProfile(src, join(root, 'bad-selection')), /last_used/)
    await unlink(join(src, 'Local State'))
    await symlink(join(root, 'missing'), join(src, 'Default', 'linked'), 'junction')
    await assert.rejects(copyUserProfile(src, join(root, 'linked-copy')), /symbolic link/)
    await assert.rejects(copyUserProfile(src, join(src, 'nested')), /outside/)
    await assert.rejects(copyUserProfile(src, join(root, 'cancelled'), AbortSignal.abort()), /no blank-profile fallback/)
  })
})

test('managed allocation copies before launch and releases lease when copying fails, without launching', async () => {
  await withTempWorkspace(async root => {
    const src = join(root, 'source')
    await mkdir(join(src, 'Default'), { recursive: true })
    await writeFile(join(src, 'Default', 'Preferences'), 'synthetic preferences')
    const allocator = new ChromePortAllocator(async () => true)
    let alive = false
    let launches = 0
    const manager = new ChromeManager(root, () => ({ basePort: 9222 }), {
      projectId: 'fixture', portAllocator: allocator,
      runtime: {
        getUserDataDir: () => src, detectChrome: async () => 'synthetic',
        isDebugPortActive: async () => false, isProcessAlive: () => alive, terminateChrome: () => { alive = false },
        async launchChrome(_path, _port, profile, _signal, selected) {
          launches++
          alive = true
          assert.equal(selected, 'Default')
          assert.notEqual(profile, src)
          assert.equal(await readFile(join(profile, 'Default', 'Preferences'), 'utf8'), 'synthetic preferences')
          return { pid: 123 }
        },
      },
    })
    try {
      await writeFile(join(src, 'lockfile'), 'synthetic lock')
      const failed = await manager.allocate('locked', 9222)
      assert('error' in failed && /locked/.test(failed.error))
      assert.equal(launches, 0)
      const { unlink } = await import('node:fs/promises')
      await unlink(join(src, 'lockfile'))
      assert('port' in await manager.allocate('copied', 9222))
      assert.equal(launches, 1)
    } finally { await manager.releaseAll() }
  })
})

test('profile selection uses Default or a single nondefault profile and rejects ambiguity', async () => {
  await withTempWorkspace(async root => {
    const src = join(root, 'source')
    await mkdir(join(src, 'Profile 1'), { recursive: true })
    assert.deepEqual(await copyUserProfile(src, join(root, 'one')), { fresh: false, profileDirectory: 'Profile 1' })
    await mkdir(join(src, 'Profile 2'))
    await assert.rejects(copyUserProfile(src, join(root, 'ambiguous')), /Multiple user profiles/)
    await mkdir(join(src, 'Default'))
    assert.deepEqual(await copyUserProfile(src, join(root, 'default')), { fresh: false, profileDirectory: 'Default' })
    await writeFile(join(src, 'Preferences'), 'synthetic')
    await mkdir(join(root, 'existing'))
    await writeFile(join(root, 'existing', 'keep'), 'must not overwrite')
    await assert.rejects(copyUserProfile(src, join(root, 'existing')), /refusing to overwrite/)
    assert.equal(await readFile(join(root, 'existing', 'keep'), 'utf8'), 'must not overwrite')
  })
})
