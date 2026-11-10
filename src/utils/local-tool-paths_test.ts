import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { localToolRoot, discoverLocalToolBinary } from './local-tool-paths.ts'

test('tool storage is device-local, user-shared and independent of Project/session/Shadow', () => {
  assert.equal(localToolRoot('audio.cpp', 'win32', { LOCALAPPDATA: 'D:\\Local Data' }, 'C:\\Users\\fixture'), 'D:\\Local Data\\audio.cpp')
  assert.equal(localToolRoot('stable-diffusion.cpp', 'darwin', {}, '/Users/fixture'), '/Users/fixture/Library/Application Support/stable-diffusion.cpp')
  assert.equal(localToolRoot('audio.cpp', 'linux', {}, '/home/fixture'), '/home/fixture/.local/share/audio.cpp')
  assert.equal(localToolRoot('stable-diffusion.cpp', 'linux', { XDG_DATA_HOME: '/mnt/data' }, '/home/fixture'), '/mnt/data/stable-diffusion.cpp')
  assert.equal(localToolRoot('audio.cpp', 'linux', { XDG_DATA_HOME: 'relative' }, '/home/fixture'), '/home/fixture/.local/share/audio.cpp')
  assert.throws(() => localToolRoot('audio.cpp', 'win32', {}, 'C:\\Users\\fixture'), /LOCALAPPDATA/)
  assert.throws(() => localToolRoot('audio.cpp', 'linux', {}, 'remote-display'), /absolute/)
  assert.throws(() => localToolRoot('audio.cpp', 'freebsd', {}, '/home/fixture'), /Unsupported/)
})

test('bounded shared binary discovery does not choose between multiple installed versions', async () => {
  await withTempWorkspace(async root => {
    assert.equal(await discoverLocalToolBinary(root, 'fixture-cli'), undefined)
    const version = join(root, 'versions', 'v1-arm64-metal', 'bin')
    await mkdir(version, { recursive: true })
    await writeFile(join(version, 'fixture-cli'), 'never executed')
    assert.equal(await discoverLocalToolBinary(root, 'fixture-cli'), join(version, 'fixture-cli'))
    await mkdir(join(root, 'versions', 'v2-arm64-metal'), { recursive: true })
    await writeFile(join(root, 'versions', 'v2-arm64-metal', 'fixture-cli'), 'never executed')
    assert.equal(await discoverLocalToolBinary(root, 'fixture-cli'), undefined)
    await writeFile(join(root, 'fixture-cli'), 'explicit direct layout')
    assert.equal(await discoverLocalToolBinary(root, 'fixture-cli'), join(root, 'fixture-cli'))
  })
})
