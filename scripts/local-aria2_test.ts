import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { prepareLocalAria2, verifyAria2SourceDownload, verifyWindowsAria2Download } from './local-aria2.ts'
import { verifyAria2Package } from './aria2-package.ts'
import { desktopTarget } from './desktop-target.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'

const materials = {
  archive: Buffer.alloc(200, 65), copying: Buffer.alloc(200, 66), openssl: Buffer.alloc(200, 67),
}

async function fixture(root: string) {
  const directory = join(root, 'desktop', 'aria2')
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'scripts'))
  const script = await readFile(new URL('./build-aria2-native.sh', import.meta.url))
  await writeFile(join(root, 'scripts', 'build-aria2-native.sh'), script)
  await writeFile(join(directory, 'BUILD.md'), Buffer.alloc(200, 68))
  const binary = Buffer.alloc(2304)
  binary.write('MZ')
  binary.writeUInt32LE(128, 0x3c)
  binary.write('PE\0\0', 128)
  binary.writeUInt16LE(0x8664, 132)
  await writeFile(join(directory, 'aria2c.exe'), binary)
  const calls: string[] = []
  const runner = {
    async source(_scratch: string) {
      calls.push('source')
      return materials
    },
    async windows(scratch: string) {
      calls.push('windows')
      const extracted = join(scratch, 'extracted')
      await mkdir(extracted)
      await writeFile(join(extracted, 'aria2c.exe'), binary)
      return extracted
    },
    async verify(path: string) {
      calls.push('verify')
      await verifyAria2Package(path, desktopTarget('win32', 'x64'), async () => ({
        stdout: 'aria2 version 1.37.0\n',
      }))
    },
  }
  return { directory, binary, script, calls, runner }
}

test('local preparation supplies missing source and build script while preserving existing binaries', async () => {
  await withTempWorkspace(async root => {
    const { directory, binary, script, calls, runner } = await fixture(root)
    await prepareLocalAria2(root, runner)
    assert.deepEqual(calls, ['source', 'verify'])
    assert.deepEqual(await readFile(join(directory, 'aria2c.exe')), binary)
    assert.deepEqual(await readFile(join(directory, 'build-aria2-native.sh')), script)
    assert.deepEqual(await readFile(join(directory, 'aria2-1.37.0-source.tar.gz')), materials.archive)
    assert.deepEqual(await readFile(join(directory, 'COPYING')), materials.copying)
    assert.deepEqual(await readdir(join(root, '.tmp')), [])
    calls.length = 0
    await writeFile(join(directory, 'build-aria2-native.sh'), 'outdated script')
    await prepareLocalAria2(root, runner)
    assert.deepEqual(calls, ['verify'], 'complete materials work without network access')
    assert.deepEqual(await readFile(join(directory, 'build-aria2-native.sh')), script)
  })
})

test('local preparation installs a missing Windows binary then validates all package materials', async () => {
  await withTempWorkspace(async root => {
    const { directory, calls, runner } = await fixture(root)
    await rm(join(directory, 'aria2c.exe'))
    await prepareLocalAria2(root, runner)
    assert.deepEqual(calls, ['windows', 'source', 'verify'])
    assert.deepEqual(await readdir(join(root, '.tmp')), [])
  })
})

test('source and binary preparation failures propagate and clean only their scratch directory', async () => {
  for (const failure of ['source', 'windows'] as const) {
    await withTempWorkspace(async root => {
      const { directory, calls, runner } = await fixture(root)
      if (failure === 'windows') await rm(join(directory, 'aria2c.exe'))
      runner[failure] = async () => { throw new Error(`${failure} unavailable`) }
      await assert.rejects(prepareLocalAria2(root, runner), new RegExp(`${failure} unavailable`))
      assert.ok(!calls.includes('verify'))
      assert.deepEqual(await readdir(join(root, '.tmp')), [])
    })
  }
})

test('invalid existing binaries and unverified downloads are not accepted', async () => {
  assert.throws(() => verifyWindowsAria2Download(Buffer.from('untrusted archive')), /SHA-256 mismatch/)
  assert.throws(() => verifyAria2SourceDownload(Buffer.from('untrusted source')), /SHA-256 mismatch/)
  await withTempWorkspace(async root => {
    const { directory, runner } = await fixture(root)
    await writeFile(join(directory, 'aria2c.exe'), Buffer.alloc(2304, 65))
    await assert.rejects(prepareLocalAria2(root, runner), /executable format/)
  })
})
