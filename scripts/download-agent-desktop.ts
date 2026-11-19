import { gunzipSync } from 'node:zlib'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_DESKTOP_REPOSITORY, AGENT_DESKTOP_REVISION, AGENT_DESKTOP_VERSION, agentDesktopDirectory, agentDesktopHash, agentDesktopTarget, verifyAgentDesktopAssets, type AgentDesktopIntegrity } from './agent-desktop-integrity.ts'

const MAX_ARCHIVE = 64 * 1024 * 1024
/** Parse only regular, flat allowlisted CLI files. Never ask tar to follow a
 * symlink, apply a PAX path override, or write anything outside staging. */
export function unpackAgentDesktopArchive(archive: Uint8Array, required: string[]): Map<string, Buffer> {
  const data = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
  const files = new Map<string, Buffer>()
  const text = (bytes: Buffer) => bytes.toString('utf8').replace(/\0.*$/s, '')
  let offset = 0
  let ended = false
  for (; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) { ended = true; break }
    const name = text(header.subarray(0, 100))
    const sizeText = text(header.subarray(124, 136)).trim()
    const sumText = text(header.subarray(148, 156)).trim()
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText)) throw new Error('Invalid CLI tar header')
    const size = parseInt(sizeText, 8)
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== parseInt(sumText, 8)) throw new Error('Invalid CLI tar checksum')
    const type = header[156]
    if ((type !== 0 && type !== 48) || text(header.subarray(345, 500)) || !required.includes(name) || files.has(name) || size === 0) {
      throw new Error(`Unexpected CLI archive entry: ${name}`)
    }
    offset += 512
    if (offset + size > data.length) throw new Error('Truncated CLI archive')
    files.set(name, Buffer.from(data.subarray(offset, offset + size)))
    offset += Math.ceil(size / 512) * 512
  }
  if (!ended || data.subarray(offset).some(byte => byte !== 0) || files.size !== required.length) throw new Error('Incomplete CLI archive/helper set')
  return files
}

export function verifyAgentDesktopArchive(bytes: Uint8Array, sha256: string): void {
  if (bytes.byteLength > MAX_ARCHIVE || agentDesktopHash(bytes) !== sha256) throw new Error('agent-desktop CLI archive SHA-256 mismatch')
}

export async function fetchAgentDesktopArchive(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`agent-desktop download HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_ARCHIVE) throw new Error('agent-desktop archive exceeds size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

/** Explicit preparation only. No package manager, Rust build, OS permission
 * changes or execution of downloaded binaries. Existing invalid installs are
 * never overwritten; remove/relocate them explicitly before retrying. */
export async function downloadAgentDesktop(root: string, platform = process.platform as string, arch = process.arch as string,
  operations = { download: fetchAgentDesktopArchive }): Promise<void> {
  const target = agentDesktopTarget(platform, arch)
  const destination = agentDesktopDirectory(root, platform, arch)
  try { await stat(destination) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  // Use one exclusive per-target lock across download, staging and publish.
  const parent = join(root, 'integrations/agent-desktop/artifacts')
  await mkdir(parent, { recursive: true })
  const lockPath = join(parent, `.download-${platform}-${arch}.lock`)
  const lease = await open(lockPath, 'wx')
  let scratch: string | undefined
  try {
    let exists = false
    try { await stat(destination); exists = true } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (exists) { await verifyAgentDesktopAssets(root, platform, arch); return }
    scratch = await mkdtemp(join(parent, `.staging-${platform}-${arch}-`))
    const archive = await operations.download(target.url)
    verifyAgentDesktopArchive(archive, target.sha256)
    const files = unpackAgentDesktopArchive(archive, target.files)
    const manifest: AgentDesktopIntegrity = { schema: 1, repository: AGENT_DESKTOP_REPOSITORY,
      version: AGENT_DESKTOP_VERSION, revision: AGENT_DESKTOP_REVISION, platform, arch,
      archive: { name: target.name, sha256: target.sha256 }, files: {} }
    for (const [file, bytes] of files) {
      const path = join(scratch, file)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o755 })
      await chmod(path, 0o755)
      manifest.files[file] = agentDesktopHash(bytes)
    }
    await writeFile(join(scratch, 'manifest.integrity.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    await rename(scratch, destination)
    scratch = undefined
    await verifyAgentDesktopAssets(root, platform, arch)
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
    await lease.close()
    await rm(lockPath)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 4) throw new Error('Usage: node scripts/download-agent-desktop.ts [platform] [arch]')
  await downloadAgentDesktop(process.cwd(), process.argv[2] ?? process.platform, process.argv[3] ?? process.arch)
  console.log('Official agent-desktop CLI and adjacent helpers prepared; no executable was run.')
}
