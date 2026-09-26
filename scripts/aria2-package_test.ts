import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyAria2Package } from './aria2-package.ts'
import { desktopTarget } from './desktop-target.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'

const requirements = ['COPYING', 'LICENSE.OpenSSL', 'BUILD.md', 'build-aria2-native.sh', 'aria2-1.37.0-source.tar.gz']

test('packaging validates native executable format, pinned version and bundled source', async () => {
  await withTempWorkspace(async root => {
    const directory = join(root, 'desktop', 'aria2')
    await mkdir(directory, { recursive: true })
    for (const name of requirements) await writeFile(join(directory, name), Buffer.alloc(200, 65))
    for (const [target, header] of [
      [desktopTarget('win32', 'x64'), (() => {
        const data = Buffer.alloc(256)
        data.write('MZ')
        data.writeUInt32LE(128, 0x3c)
        data.write('PE\0\0', 128)
        data.writeUInt16LE(0x8664, 132)
        return data
      })()],
      [desktopTarget('linux', 'x64'), (() => {
        const data = Buffer.alloc(256)
        Buffer.from([127, 69, 76, 70, 2, 1]).copy(data)
        data.writeUInt16LE(62, 18)
        return data
      })()],
      [desktopTarget('darwin', 'arm64'), (() => {
        const data = Buffer.alloc(256)
        Buffer.from([207, 250, 237, 254]).copy(data)
        data.writeUInt32LE(0x0100000c, 4)
        return data
      })()],
    ] as const) {
      const path = join(directory, target.platform === 'win32' ? 'aria2c.exe' : 'aria2c')
      await writeFile(path, Buffer.concat([header, Buffer.alloc(2048)]))
      if (target.platform !== 'win32') await chmod(path, 0o755)
      await verifyAria2Package(root, target, async () => ({ stdout: 'aria2 version 1.37.0\n', stderr: '' }))
      await assert.rejects(() => verifyAria2Package(root, target, async () =>
        ({ stdout: 'aria2 version 1.36.0\n', stderr: '' })), /Expected bundled aria2/)
      await writeFile(path, Buffer.alloc(2304, 65))
      await assert.rejects(() => verifyAria2Package(root, target, async () =>
        ({ stdout: 'aria2 version 1.37.0\n', stderr: '' })), /executable format/)
      await writeFile(path, Buffer.concat([header, Buffer.alloc(2048)]))
      if (target.platform !== 'win32') await chmod(path, 0o755)
    }
    await writeFile(join(directory, 'aria2-1.37.0-source.tar.gz'), 'missing source')
    await assert.rejects(() => verifyAria2Package(root, desktopTarget('win32', 'x64')), /Incomplete aria2 source/)
  })
})
