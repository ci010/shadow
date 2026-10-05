import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { acquireReleaseLock, checkInstallationLink, managedAppProcesses, parseReadiness, promoteRelease } from './mac-deployment.ts'

test('deployment lock refuses concurrent releases and never silently clears stale ownership', async () => {
  await withTempWorkspace(async root => {
    const id = randomUUID()
    const release = await acquireReleaseLock(root, id)
    await assert.rejects(acquireReleaseLock(root, randomUUID()), /Another release/)
    assert.equal(JSON.parse(await readFile(join(root, 'release.lock', 'owner.json'), 'utf8')).id, id)
    await release()
    const again = await acquireReleaseLock(root, randomUUID())
    await again()
    await assert.rejects(acquireReleaseLock(root, '../unsafe'), /Invalid release ID/)
  })
})

test('owned app census includes backend/helpers but not build commands or other test applications', () => {
  const root = '/Users/dev/.shadow-releases'
  const application = '/Users/dev/Applications/Shadow.app'
  assert.deepEqual(managedAppProcesses([
    `  123 ${root}/releases/version/Shadow.app/Contents/MacOS/Shadow`,
    `  124 ${root}/releases/version/Shadow.app/Contents/Frameworks/Shadow Helper.app/Contents/MacOS/Shadow Helper`,
    `  125 ${application}/Contents/MacOS/Shadow`,
    '  126 /Users/dev/test/Shadow.app/Contents/MacOS/Shadow',
    `  127 ${root}/builds/version/source/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
    '  128 /opt/homebrew/bin/node',
  ].join('\n'), root, application), [123, 124, 125])
})

test('readiness requires the exact child, build and source; unknown or failed status is not success', () => {
  const expected = { pid: 100, buildId: randomUUID(), sourceHash: 'a'.repeat(64), executablePath: '/app/Contents/MacOS/Shadow' }
  const value = { ...expected, type: 'shadow:release-ready', state: 'ready', role: 'child' }
  assert.equal(parseReadiness(value, expected).state, 'ready')
  assert.equal(parseReadiness({ ...value, state: 'setup-required', role: null }, expected).state, 'setup-required')
  for (const patch of [{ pid: 101 }, { sourceHash: 'b'.repeat(64) }, { buildId: randomUUID() },
    { executablePath: '/previous/app' }, { type: 'ready' }, { state: 'unknown' }, { state: 'failed' }, { role: 'admin' }]) {
    assert.throws(() => parseReadiness({ ...value, ...patch }, expected))
  }
})

test('existing unmanaged applications are never adopted or overwritten', async () => {
  await withTempWorkspace(async root => {
    const app = join(root, 'Applications', 'Shadow.app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'keep.txt'), 'existing application')
    await assert.rejects(checkInstallationLink(app, join(root, 'current')), /unmanaged application/)
    await assert.rejects(promoteRelease(root, randomUUID(), app), /unmanaged application/)
    assert.equal(await readFile(join(app, 'keep.txt'), 'utf8'), 'existing application')
  })
})

test('promotion changes only the current pointer and retains earlier applications and separate data', {
  skip: process.platform === 'win32' ? 'macOS deployment uses POSIX symlinks' : false,
}, async () => {
  await withTempWorkspace(async root => {
    const app = join(root, 'Applications', 'Shadow.app')
    const old = randomUUID(), next = randomUUID()
    for (const id of [old, next]) {
      await mkdir(join(root, 'releases', id, 'Shadow.app'), { recursive: true })
      await writeFile(join(root, 'releases', id, 'Shadow.app', 'identity'), id)
    }
    await writeFile(join(root, 'user-data'), 'unchanged')
    await promoteRelease(root, old, app)
    assert.equal(await readFile(join(app, 'identity'), 'utf8'), old)
    await promoteRelease(root, next, app)
    assert.equal(await readFile(join(app, 'identity'), 'utf8'), next)
    assert.equal(await readlink(join(root, 'current')), join('releases', next))
    assert.equal(await readFile(join(root, 'releases', old, 'Shadow.app', 'identity'), 'utf8'), old)
    assert.equal(await readFile(join(root, 'user-data'), 'utf8'), 'unchanged')
  })
})
