import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

const execFileAsync = promisify(execFile)
export const ARIA2_VERSION = '1.37.0'
export const ARIA2_REVISION = '02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a'

export function aria2Executable(target: DesktopTarget): string {
  return target.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
}

export async function verifyAria2Package(
  root: string,
  target: DesktopTarget = desktopTarget(),
  run: (binary: string) => Promise<{ stdout: string }> = binary =>
    execFileAsync(binary, ['--version'], { timeout: 10_000, windowsHide: true }),
): Promise<void> {
  const directory = join(root, 'desktop', 'aria2')
  for (const name of ['COPYING', 'LICENSE.OpenSSL', 'BUILD.md', 'build-aria2-native.sh', 'aria2-1.37.0-source.tar.gz']) {
    const file = await stat(join(directory, name))
    if (!file.isFile() || file.size < 100) throw new Error(`Incomplete aria2 source or license: ${name}`)
  }
  const binary = join(directory, aria2Executable(target))
  const info = await stat(binary)
  if (!info.isFile() || info.size < 1024) throw new Error('Bundled aria2c binary is invalid')
  const handle = await open(binary, 'r')
  try {
    const header = Buffer.alloc(256)
    await handle.read(header, 0, header.length, 0)
    let native = false
    if (target.platform === 'win32' && header.toString('ascii', 0, 2) === 'MZ') {
      const pe = header.readUInt32LE(0x3c)
      if (pe + 6 <= header.length && header.toString('ascii', pe, pe + 4) === 'PE\0\0') {
        native = header.readUInt16LE(pe + 4) === 0x8664
      }
    } else if (target.platform === 'linux' && header.toString('hex', 0, 4) === '7f454c46') {
      native = header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62
    } else if (target.platform === 'darwin') {
      const magic = header.toString('hex', 0, 4)
      const cpu = magic === 'cffaedfe' ? header.readUInt32LE(4)
        : magic === 'feedfacf' ? header.readUInt32BE(4) : 0
      native = cpu === (target.arch === 'arm64' ? 0x0100000c : 0x01000007)
    }
    if (!native) throw new Error(`Bundled aria2c has the wrong ${target.platform}/${target.arch} executable format`)
  } finally {
    await handle.close()
  }
  if (target.platform !== 'win32' && process.platform === target.platform && !(info.mode & 0o111)) {
    throw new Error('Bundled aria2c must have executable permissions')
  }
  const { stdout } = await run(binary)
  if (!new RegExp(`^aria2 version ${ARIA2_VERSION.replaceAll('.', '\\.')}\\r?\\n`).test(stdout)) {
    throw new Error(`Expected bundled aria2 ${ARIA2_VERSION} for ${target.platform}/${target.arch}`)
  }
}
