import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ARIA2_REVISION, ARIA2_VERSION, verifyAria2Package } from './aria2-package.ts'
import { desktopTarget } from './desktop-target.ts'

const exec = promisify(execFile)
export const WINDOWS_ARIA2_SHA256 = '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
export const ARIA2_SOURCE_SHA256 = 'dc6bb0336e46507d6b2dd5dcb47179d6a95261486a59063eb80f867a03480f87'
const windowsArchiveName = `aria2-${ARIA2_VERSION}-win-64bit-build1`

export function verifyWindowsAria2Download(bytes: Uint8Array): void {
  if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_ARIA2_SHA256) {
    throw new Error('Windows aria2 archive SHA-256 mismatch; refusing to install it.')
  }
}

export function verifyAria2SourceDownload(bytes: Uint8Array): void {
  if (createHash('sha256').update(bytes).digest('hex') !== ARIA2_SOURCE_SHA256) {
    throw new Error('Pinned aria2 source archive SHA-256 mismatch; refusing to package it.')
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

interface PreparationOperations {
  source(scratch: string): Promise<{ archive: Buffer; copying: Buffer; openssl: Buffer }>
  windows(scratch: string): Promise<string>
  verify(root: string): Promise<void>
}

async function downloadArchive(url: string, cache: string, verify: (bytes: Uint8Array) => void): Promise<Buffer> {
  if (await exists(cache)) {
    const bytes = await readFile(cache)
    verify(bytes)
    return bytes
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`aria2 download failed with HTTP ${response.status}.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  verify(bytes)
  await writeFile(cache, bytes)
  return bytes
}

const operations: PreparationOperations = {
  async source(scratch) {
    const cache = join(dirname(scratch), 'aria2-pinned-source.tar.gz')
    const archive = await downloadArchive(
      `https://codeload.github.com/aria2/aria2/tar.gz/${ARIA2_REVISION}`, cache, verifyAria2SourceDownload,
    )
    const prefix = `aria2-${ARIA2_REVISION}`
    await exec('tar.exe', ['-xzf', cache, '-C', scratch, `${prefix}/COPYING`, `${prefix}/LICENSE.OpenSSL`], {
      timeout: 30_000,
    })
    return {
      archive,
      copying: await readFile(join(scratch, prefix, 'COPYING')),
      openssl: await readFile(join(scratch, prefix, 'LICENSE.OpenSSL')),
    }
  },
  async windows(scratch) {
    const archive = join(dirname(scratch), `${windowsArchiveName}.zip`)
    await downloadArchive(
      `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/${windowsArchiveName}.zip`,
      archive, verifyWindowsAria2Download,
    )
    await exec('tar.exe', ['-xf', archive, '-C', scratch], { timeout: 30_000 })
    return join(scratch, windowsArchiveName)
  },
  verify: root => verifyAria2Package(root, desktopTarget('win32', 'x64')),
}

export async function prepareLocalAria2(root: string, runner: PreparationOperations = operations): Promise<void> {
  const directory = join(root, 'desktop', 'aria2')
  const binary = join(directory, 'aria2c.exe')
  const source = join(directory, `aria2-${ARIA2_VERSION}-source.tar.gz`)
  await mkdir(directory, { recursive: true })
  await cp(join(root, 'scripts', 'build-aria2-native.sh'), join(directory, 'build-aria2-native.sh'))
  const needsBinary = !await exists(binary)
  const needsSource = !await exists(source) || !await exists(join(directory, 'COPYING'))
    || !await exists(join(directory, 'LICENSE.OpenSSL'))
  if (needsBinary || needsSource) {
    const parent = join(root, '.tmp')
    await mkdir(parent, { recursive: true })
    const scratch = await mkdtemp(join(parent, 'local-aria2-'))
    try {
      if (needsBinary) {
        const extracted = await runner.windows(scratch)
        await cp(join(extracted, 'aria2c.exe'), binary)
      }
      if (needsSource) {
        const files = await runner.source(scratch)
        await writeFile(source, files.archive)
        await writeFile(join(directory, 'COPYING'), files.copying)
        await writeFile(join(directory, 'LICENSE.OpenSSL'), files.openssl)
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  await runner.verify(root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: pnpm desktop:prepare-aria2')
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Local aria2 preparation currently supports Windows x64 only.')
  }
  await prepareLocalAria2(process.cwd())
  console.log('Local aria2 package prepared and verified.')
}
