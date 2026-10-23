import { join } from 'node:path'

export interface DesktopTarget {
  platform: 'win32' | 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
  builderFlag: '--win' | '--mac' | '--linux'
  format: 'nsis' | 'zip' | 'tar.gz'
  unpackedDirectory: string
  executableRelativePath: string
  resourcesRelativePath: string
}

export function desktopTarget(platform: string = process.platform, arch: string = process.arch): DesktopTarget {
  if (platform === 'win32' && arch === 'x64') {
    return { platform, arch, builderFlag: '--win', format: 'nsis', unpackedDirectory: 'win-unpacked',
      executableRelativePath: 'Shadow.exe', resourcesRelativePath: 'resources' }
  }
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { platform, arch, builderFlag: '--mac', format: 'zip',
      unpackedDirectory: join(arch === 'arm64' ? 'mac-arm64' : 'mac', 'Shadow.app'),
      executableRelativePath: join('Contents', 'MacOS', 'Shadow'), resourcesRelativePath: join('Contents', 'Resources') }
  }
  if (platform === 'linux' && arch === 'x64') {
    return { platform, arch, builderFlag: '--linux', format: 'tar.gz', unpackedDirectory: 'linux-unpacked',
      executableRelativePath: 'shadow', resourcesRelativePath: 'resources' }
  }
  throw new Error(`Unsupported desktop release host: ${platform}/${arch}. Build natively on Windows x64, macOS x64/arm64, or Linux x64.`)
}
