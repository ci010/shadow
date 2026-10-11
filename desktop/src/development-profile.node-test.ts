import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { resolveDesktopMainDirectory, resolveDesktopUserDataPath } from './development-profile.js'

test('desktop development uses a worktree-local profile, not installed user data', () => {
  const appPath = resolve('desktop')
  assert.equal(resolveDesktopUserDataPath(appPath, false), resolve('.tmp', 'desktop-dev', 'user-data'))
  assert.equal(resolveDesktopUserDataPath(appPath, true), undefined)
})

test('explicit desktop profile must be absolute', () => {
  const profile = resolve('.tmp', 'custom-desktop')
  assert.equal(resolveDesktopUserDataPath(resolve('desktop'), false, profile), profile)
  assert.throws(() => resolveDesktopUserDataPath(resolve('desktop'), false, 'relative'), /absolute/)
})

test('Main production default is expanded from the user home and ignores development overrides', () => {
  const home = resolve('.tmp', 'synthetic-home')
  const appPath = resolve('desktop')
  assert.equal(resolveDesktopMainDirectory(appPath, true, undefined, home), resolve(home, '.shadow'))
  assert.equal(resolveDesktopMainDirectory(appPath, true, resolve('.tmp', 'custom'), home), resolve(home, '.shadow'))
  assert.equal(resolveDesktopMainDirectory(appPath, true, 'relative-dev-value', home), resolve(home, '.shadow'))
})

test('Main development shares the production home by default and permits an explicit override', () => {
  const appPath = resolve('desktop')
  const home = resolve('.tmp', 'synthetic-home')
  assert.equal(resolveDesktopMainDirectory(appPath, false, undefined, home), resolve(home, '.shadow'))
  assert.equal(resolveDesktopMainDirectory(appPath, false, '', home), resolveDesktopMainDirectory(appPath, true, undefined, home))
  const custom = resolve('.tmp', 'smoke-main', '..', 'custom-main')
  assert.equal(resolveDesktopMainDirectory(appPath, false, custom, home), custom)
  for (const invalid of ['relative', '~/.shadow', 'C:drive-relative']) {
    assert.throws(() => resolveDesktopMainDirectory(appPath, false, invalid, home), /absolute/)
  }
})
