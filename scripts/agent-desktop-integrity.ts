import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import lock from './agent-desktop-lock.json' with { type: 'json' }

export const AGENT_DESKTOP_VERSION = lock.version
export const AGENT_DESKTOP_REVISION = lock.revision
export const AGENT_DESKTOP_REPOSITORY = lock.repository
export const agentDesktopHash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export function agentDesktopTarget(platform: string, arch: string) {
  const key = `${platform}-${arch}` as keyof typeof lock.targets
  const target = lock.targets[key]
  if (!target) throw new Error(`Unsupported agent-desktop CLI target: ${platform}-${arch}`)
  const name = `agent-desktop-v${lock.version}-${target.triple}.tar.gz`
  return { ...target, fileHashes: target.files as Record<string, string>, platform, arch, name,
    url: `https://github.com/${lock.repository}/releases/download/v${lock.version}/${name}`,
    files: platform === 'win32' ? ['agent-desktop.exe'] : platform === 'darwin'
      ? ['agent-desktop', 'agent-desktop-macos-helper'] : ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
  }
}
export interface AgentDesktopIntegrity {
  schema: 1
  repository: string
  version: string
  revision: string
  platform: string
  arch: string
  archive: { name: string; sha256: string }
  files: Record<string, string>
}
export const agentDesktopDirectory = (root: string, platform: string, arch: string) =>
  join(root, 'integrations/agent-desktop/artifacts', `${platform}-${arch}`)

export async function verifyAgentDesktopAssets(root: string, platform = process.platform as string, arch = process.arch as string, trustedFileHashes?: Record<string, string>): Promise<AgentDesktopIntegrity> {
  const target = agentDesktopTarget(platform, arch)
  const directory = agentDesktopDirectory(root, platform, arch)
  const manifestPath = join(directory, 'manifest.integrity.json')
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.size > 32_768) throw new Error('Invalid agent-desktop integrity manifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentDesktopIntegrity
  if (manifest.schema !== 1 || manifest.repository !== lock.repository || manifest.version !== lock.version || manifest.revision !== lock.revision
    || manifest.platform !== platform || manifest.arch !== arch || manifest.archive?.name !== target.name || manifest.archive?.sha256 !== target.sha256
    || !manifest.files || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...target.files].sort())) {
    throw new Error('Unpinned agent-desktop CLI integrity manifest')
  }
  // Optional trusted hashes are for inert unit fixtures only. Production callers
  // always use hashes derived from the six verified official release archives,
  // never hashes asserted by the install's own mutable receipt.
  const expected = trustedFileHashes ?? target.fileHashes
  if (target.files.some(file => manifest.files[file] !== expected[file])) throw new Error('Unpinned agent-desktop executable/helper hash')
  for (const file of target.files) {
    const path = join(directory, file)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size === 0 || (platform !== 'win32' && (entry.mode & 0o111) === 0)
      || !/^[a-f0-9]{64}$/.test(manifest.files[file]) || agentDesktopHash(await readFile(path)) !== manifest.files[file]) {
      throw new Error(`Missing or invalid agent-desktop CLI asset: ${file}`)
    }
  }
  return manifest
}
