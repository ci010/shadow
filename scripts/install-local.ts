import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { desktopTarget } from './desktop-target.ts'
import { verifyReleaseManifest } from './release-manifest.ts'

const exec = promisify(execFile)

export function localInstallDirectory(
  platform = process.platform, arch = process.arch, localAppData = process.env.LOCALAPPDATA,
): string {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('Local desktop installation currently supports Windows x64 only.')
  }
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA must be an absolute current-user directory.')
  }
  return join(localAppData, 'Programs', 'Shadow')
}

export async function assertLocalAppStopped(directory: string): Promise<void> {
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; ` +
    `$prefix = $env:SHADOW_LOCAL_INSTALL_DIRECTORY.TrimEnd('\\') + '\\'; ` +
    `Get-CimInstance Win32_Process | Where-Object { ` +
    `$_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) ` +
    `} | ForEach-Object { $_.ProcessId }`,
  ], { env: { ...process.env, SHADOW_LOCAL_INSTALL_DIRECTORY: directory }, windowsHide: true })
  if (stdout.trim()) {
    throw new Error(`Quit Shadow and its background processes before installing (PIDs: ${stdout.trim().split(/\s+/).join(', ')}).`)
  }
}

interface InstallOperations {
  assertStopped(directory: string): Promise<void>
  install(installer: string): Promise<void>
  verify(directory: string, root: string): Promise<void>
}

const operations: InstallOperations = {
  assertStopped: assertLocalAppStopped,
  async install(installer) {
    await exec(installer, ['/S', '/currentuser'], { windowsHide: true })
  },
  verify: directory => verifyReleaseManifest(directory, undefined, desktopTarget('win32', 'x64')),
}

export async function installLocalDesktop(
  root: string, directory: string, runner: InstallOperations = operations,
): Promise<void> {
  await runner.assertStopped(directory)
  const manifest: unknown = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest)
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('Invalid desktop package version.')
  }
  const installer = join(root, 'desktop', 'release', `Shadow-${manifest.version}-win-x64.exe`)
  const info = await stat(installer).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Windows installer is missing. Run pnpm desktop:build first.', { cause: error })
    }
    throw error
  })
  if (!info.isFile()) {
    throw new Error('Windows installer is invalid. Run pnpm desktop:build first.')
  }
  await runner.verify(join(root, 'desktop', 'release', 'win-unpacked'), root)
  const expected = await readFile(join(root, 'desktop', 'release', 'win-unpacked', 'resources', 'release-manifest.v1.json'))
  await runner.assertStopped(directory)
  await runner.install(installer)
  await stat(join(directory, 'Shadow.exe'))
  const installed = await readFile(join(directory, 'resources', 'release-manifest.v1.json'))
  if (!expected.equals(installed)) {
    throw new Error('Installed Shadow does not match the locally built release.')
  }
  await runner.verify(directory, root)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: pnpm desktop:install')
  const directory = localInstallDirectory()
  await installLocalDesktop(process.cwd(), directory)
  console.log(`Installed local Shadow build at ${join(directory, 'Shadow.exe')}`)
}
