import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

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
  return electronDist
}
