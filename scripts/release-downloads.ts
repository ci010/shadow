import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

export const WINSW_VERSION = '2.12.0'
export const WINSW_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
const officialWinSW = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`

export function verifyWinSW(bytes: Uint8Array): void {
  if (createHash('sha256').update(bytes).digest('hex') !== WINSW_SHA256) {
    throw new Error(`WinSW ${WINSW_VERSION} SHA-256 mismatch; refusing to package an unverified service host`)
  }
}

export function downloadUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Release download URLs must use HTTPS without embedded credentials or fragments')
  }
  return url.href
}

export async function prepareReleaseDownloads(root: string, env = process.env, target: DesktopTarget = desktopTarget()): Promise<string> {
  const require = createRequire(join(root, 'desktop', 'package.json'))
  const desktop = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
  const electronDist = env.SHADOW_ELECTRON_DIST
    ? resolve(env.SHADOW_ELECTRON_DIST)
    : target.platform === 'darwin'
      ? resolve(dirname(require('electron') as string), '..', '..', '..')
      : dirname(require('electron') as string)
  const installedVersion = (await readFile(join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '')
  if (installedVersion !== desktop.devDependencies.electron) {
    throw new Error(`Electron distribution is ${installedVersion}; expected ${desktop.devDependencies.electron}`)
  }
  await readFile(join(electronDist, ...(target.platform === 'darwin'
    ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
    : [target.platform === 'win32' ? 'electron.exe' : 'electron'])))
  if (env.ELECTRON_BUILDER_BINARIES_MIRROR) downloadUrl(env.ELECTRON_BUILDER_BINARIES_MIRROR)
  if (target.platform !== 'win32') return electronDist
  const serviceBinary = join(root, 'desktop', 'service', 'ShadowService.exe')
  let bytes: Buffer | undefined
  if (env.SHADOW_WINSW_BINARY) {
    bytes = await readFile(resolve(env.SHADOW_WINSW_BINARY))
  } else {
    try { bytes = await readFile(serviceBinary) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  if (!bytes) {
    const response = await fetch(downloadUrl(env.SHADOW_WINSW_URL ?? officialWinSW), {
      signal: AbortSignal.timeout(60_000),
    }).catch(cause => { throw new Error('WinSW download failed. Supply SHADOW_WINSW_BINARY or an HTTPS SHADOW_WINSW_URL mirror.', { cause }) })
    if (!response.ok) throw new Error(`WinSW download failed with HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  verifyWinSW(bytes)
  await mkdir(dirname(serviceBinary), { recursive: true })
  await writeFile(serviceBinary, bytes)
  return electronDist
}
